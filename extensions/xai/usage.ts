import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { composeTimeoutSignal } from "./abort";
import {
  hasPiManagedXaiOAuth,
  resolvePiManagedXaiOAuthCredential,
} from "./auth";
import { readBoundedResponseText } from "./bounded-body";
import {
  XAI_CLI_BILLING_URL,
  XAI_CLI_USER_URL,
  isXaiToolCompatibleProvider,
  XAI_USAGE_MAX_RESPONSE_BYTES,
  XAI_USAGE_STATUS_MIN_REFRESH_MS,
  XAI_USAGE_TIMEOUT_MS,
} from "./constants";
import type { XaiCredential } from "./routing";
import {
  parseXaiUsage,
  parseXaiUserId,
  XaiUsageError,
  type XaiUsageSnapshot,
} from "./usage-parse";
import { renderXaiUsage, renderXaiUsageStatus } from "./usage-render";
import { xaiUsageHeaders } from "./wire";

const XAI_USAGE_STATUS_KEY = "xai-usage";
const XAI_USAGE_COMMAND_HELP = "Usage: /xai-usage [status [on|off]]";

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  try {
    return await readBoundedResponseText(response, {
      maxBytes: XAI_USAGE_MAX_RESPONSE_BYTES,
      signal,
      emptyBody: "empty",
      checkDeclaredLength: false,
      strictUtf8: true,
      overflowError: () => new XaiUsageError("oversize", "xAI usage returned an oversized response."),
    });
  } catch (error) {
    if (error instanceof XaiUsageError) throw error;
    throw new XaiUsageError("invalid", "xAI usage returned an invalid response body.");
  }
}

function httpError(status: number): XaiUsageError {
  if (status === 401 || status === 403) {
    return new XaiUsageError(
      "auth",
      "xAI authentication was rejected. Run /login xai or /login xai-auth and try again.",
      status,
    );
  }
  if (status === 404 || (status >= 300 && status < 400)) {
    return new XaiUsageError(
      "http",
      "The pinned xAI usage contract is unavailable.",
      status,
    );
  }
  if (status === 429) {
    return new XaiUsageError("http", "xAI usage is rate limited. Try again later.", status);
  }
  return new XaiUsageError("http", `xAI usage request failed with status ${status}.`, status);
}

async function requestBoundedJson(
  url: string,
  credential: XaiCredential,
  userId?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (credential.kind !== "oauth-session" || !credential.token) {
    throw new XaiUsageError(
      "auth",
      "xAI OAuth credentials are required. Run /login xai or /login xai-auth first.",
    );
  }
  const abort = composeTimeoutSignal(signal, XAI_USAGE_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "error",
        signal: abort.signal,
        headers: xaiUsageHeaders(credential.token, userId),
      });
    } catch {
      if (signal?.aborted) throw new XaiUsageError("cancelled", "xAI usage request was cancelled.");
      if (abort.timedOut()) throw new XaiUsageError("timeout", "xAI usage request timed out.");
      throw new XaiUsageError("transport", "xAI usage request failed.");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw httpError(response.status);
    }
    let body: string;
    try {
      body = await readBoundedBody(response, abort.signal);
    } catch (error) {
      if (signal?.aborted) throw new XaiUsageError("cancelled", "xAI usage request was cancelled.");
      if (abort.timedOut()) throw new XaiUsageError("timeout", "xAI usage request timed out.");
      if (error instanceof XaiUsageError) throw error;
      throw new XaiUsageError("transport", "xAI usage request failed.");
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new XaiUsageError("invalid", "xAI usage returned malformed JSON.");
    }
  } finally {
    abort.dispose();
  }
}

/** Fetch identity and billing sequentially using one transient Pi-resolved bearer. */
export async function fetchXaiUsage(
  credential: XaiCredential,
  signal?: AbortSignal,
): Promise<XaiUsageSnapshot> {
  const identity = await requestBoundedJson(XAI_CLI_USER_URL, credential, undefined, signal);
  const userId = parseXaiUserId(identity);
  const billing = await requestBoundedJson(
    XAI_CLI_BILLING_URL,
    credential,
    userId,
    signal,
  );
  return parseXaiUsage(billing);
}

export interface XaiUsageFeature {
  reset(ctx?: ExtensionContext): void;
  clearIfInactive(ctx: ExtensionContext): void;
  refreshStatus(ctx: ExtensionContext): Promise<void>;
}

interface XaiUsageDependencies {
  resolveCredential: typeof resolvePiManagedXaiOAuthCredential;
  fetchUsage: typeof fetchXaiUsage;
  now: () => number;
  minimumRefreshMs: number;
}

function safeUsageError(error: unknown): XaiUsageError {
  return error instanceof XaiUsageError
    ? error
    : new XaiUsageError("transport", "xAI usage request failed.");
}

/** Register `/xai-usage` and return its session-scoped status lifecycle. */
export function registerXaiUsage(
  pi: ExtensionAPI,
  overrides: Partial<XaiUsageDependencies> = {},
): XaiUsageFeature {
  const dependencies: XaiUsageDependencies = {
    resolveCredential: overrides.resolveCredential ?? resolvePiManagedXaiOAuthCredential,
    fetchUsage: overrides.fetchUsage ?? fetchXaiUsage,
    now: overrides.now ?? Date.now,
    minimumRefreshMs: overrides.minimumRefreshMs ?? XAI_USAGE_STATUS_MIN_REFRESH_MS,
  };
  let statusEnabled = false;
  let lastRefreshAt = 0;
  let generation = 0;
  let lastUi: ExtensionUIContext | undefined;
  let statusController: AbortController | undefined;
  let oneShotController: AbortController | undefined;
  let oneShotGeneration = 0;
  let refreshPromise: Promise<{ ok: boolean; error?: XaiUsageError }> | undefined;

  const clear = (ctx?: ExtensionContext) => {
    const ui = ctx?.ui ?? lastUi;
    try {
      ui?.setStatus(XAI_USAGE_STATUS_KEY, undefined);
    } catch {
      // Status is cosmetic and must never affect chat or account changes.
    }
    lastUi = ctx?.ui;
  };

  const reset = (ctx?: ExtensionContext) => {
    statusEnabled = false;
    lastRefreshAt = 0;
    generation++;
    oneShotGeneration++;
    statusController?.abort();
    oneShotController?.abort();
    statusController = undefined;
    oneShotController = undefined;
    refreshPromise = undefined;
    clear(ctx);
  };

  const resolveUsage = async (ctx: ExtensionContext, signal?: AbortSignal) => {
    let credential: XaiCredential | null;
    try {
      credential = await dependencies.resolveCredential(ctx);
    } catch {
      throw new XaiUsageError(
        "auth",
        "xAI OAuth credentials could not be resolved. Run /login xai or /login xai-auth first.",
      );
    }
    if (!credential) {
      throw new XaiUsageError(
        "auth",
        "xAI OAuth credentials are required. Run /login xai or /login xai-auth first.",
      );
    }
    return dependencies.fetchUsage(credential, signal);
  };

  const updateStatus = async (
    ctx: ExtensionContext,
    force: boolean,
  ): Promise<{ ok: boolean; error?: XaiUsageError }> => {
    lastUi = ctx.ui;
    if (
      !statusEnabled
      || !isXaiToolCompatibleProvider(ctx.model?.provider)
      || !hasPiManagedXaiOAuth(ctx)
    ) {
      reset(ctx);
      return { ok: false };
    }
    const now = dependencies.now();
    if (!force && lastRefreshAt > 0 && now - lastRefreshAt < dependencies.minimumRefreshMs) {
      return { ok: true };
    }
    if (refreshPromise) return refreshPromise;
    lastRefreshAt = now;
    const refreshGeneration = generation;
    const controller = new AbortController();
    statusController = controller;
    const pending = (async () => {
      try {
        const usage = await resolveUsage(ctx, controller.signal);
        if (
          refreshGeneration === generation
          && statusEnabled
          && isXaiToolCompatibleProvider(ctx.model?.provider)
          && !controller.signal.aborted
        ) {
          ctx.ui.setStatus(XAI_USAGE_STATUS_KEY, renderXaiUsageStatus(usage));
        }
        return { ok: true };
      } catch (error) {
        const safeError = safeUsageError(error);
        if (refreshGeneration === generation) {
          if (safeError.code === "auth") reset(ctx);
          else clear(ctx);
        }
        return { ok: false, error: safeError };
      } finally {
        if (statusController === controller) statusController = undefined;
      }
    })();
    refreshPromise = pending;
    try {
      return await pending;
    } finally {
      if (refreshPromise === pending) refreshPromise = undefined;
    }
  };

  pi.registerCommand("xai-usage", {
    description: "Show xAI subscription usage or manage the optional session status",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean).map((part) => part.toLowerCase());
      if (parts.length === 0) {
        oneShotController?.abort();
        const controller = new AbortController();
        oneShotController = controller;
        const requestGeneration = ++oneShotGeneration;
        const sessionGeneration = generation;
        const forwardAbort = () => controller.abort();
        ctx.signal?.addEventListener("abort", forwardAbort, { once: true });
        if (ctx.signal?.aborted) controller.abort();
        try {
          const usage = await resolveUsage(ctx, controller.signal);
          if (
            requestGeneration === oneShotGeneration
            && sessionGeneration === generation
          ) {
            ctx.ui.notify(renderXaiUsage(usage), "info");
          }
        } catch (error) {
          if (
            requestGeneration === oneShotGeneration
            && sessionGeneration === generation
          ) {
            ctx.ui.notify(safeUsageError(error).message, "error");
          }
        } finally {
          ctx.signal?.removeEventListener("abort", forwardAbort);
          if (oneShotController === controller) oneShotController = undefined;
        }
        return;
      }
      if (parts[0] !== "status" || parts.length > 2 || (parts[1] && !["on", "off"].includes(parts[1]))) {
        ctx.ui.notify(XAI_USAGE_COMMAND_HELP, "error");
        return;
      }
      if (!parts[1]) {
        if (statusEnabled && !hasPiManagedXaiOAuth(ctx)) reset(ctx);
        ctx.ui.notify(`xAI usage status is ${statusEnabled ? "on" : "off"} for this session.`, "info");
        return;
      }
      if (parts[1] === "off") {
        reset(ctx);
        ctx.ui.notify("xAI usage status is off for this session.", "info");
        return;
      }
      if (!isXaiToolCompatibleProvider(ctx.model?.provider)) {
        reset(ctx);
        ctx.ui.notify("Select an xAI/Grok model before enabling xAI usage status.", "error");
        return;
      }
      reset(ctx);
      statusEnabled = true;
      lastRefreshAt = 0;
      const result = await updateStatus(ctx, true);
      if (result.ok) {
        ctx.ui.notify("xAI usage status is on for this session.", "info");
      } else {
        reset(ctx);
        ctx.ui.notify(result.error?.message ?? "xAI usage status could not be refreshed.", "error");
      }
    },
  });

  return {
    reset,
    clearIfInactive(ctx) {
      if (
        !isXaiToolCompatibleProvider(ctx.model?.provider)
        || !hasPiManagedXaiOAuth(ctx)
      ) {
        reset(ctx);
      }
    },
    async refreshStatus(ctx) {
      if (!statusEnabled) return;
      await updateStatus(ctx, false);
    },
  };
}
