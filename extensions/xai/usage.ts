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
  XAI_USAGE_MAX_HISTORY_PERIODS,
  XAI_USAGE_MAX_JSON_ARRAY_ITEMS,
  XAI_USAGE_MAX_JSON_DEPTH,
  XAI_USAGE_MAX_JSON_NODES,
  XAI_USAGE_MAX_JSON_OBJECT_KEYS,
  XAI_USAGE_MAX_RESPONSE_BYTES,
  XAI_USAGE_STATUS_MIN_REFRESH_MS,
  XAI_USAGE_TIMEOUT_MS,
} from "./constants";
import type { XaiCredential } from "./routing";
import { xaiUsageHeaders } from "./wire";

const XAI_USAGE_STATUS_KEY = "xai-usage";
const XAI_USAGE_COMMAND_HELP = "Usage: /xai-usage [csv|status [on|off]]";
const MAX_USER_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 80;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_CENTS = 1_000_000_000_000;
const MIN_BILLING_YEAR = 2000;
const MAX_BILLING_YEAR = 2200;
const USER_ID_PATTERN = /^[\x21-\x7e]+$/;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export interface XaiUsagePeriod {
  type?: string;
  start?: string;
  end?: string;
}

export interface XaiUsageHistoryPeriod {
  period?: XaiUsagePeriod;
  billingCycle?: { year: number; month: number };
  includedUsedCents?: number;
  onDemandUsedCents?: number;
  totalUsedCents?: number;
}

export interface XaiUsageSnapshot {
  creditUsagePercent?: number;
  currentPeriod?: XaiUsagePeriod;
  monthlyLimitCents?: number;
  usedCents?: number;
  onDemandCapCents?: number;
  onDemandUsedCents?: number;
  prepaidBalanceCents?: number;
  isUnifiedBillingUser?: boolean;
  onDemandEnabled?: boolean;
  subscriptionTier?: string;
  history: XaiUsageHistoryPeriod[];
}

type XaiUsageErrorCode =
  | "auth"
  | "cancelled"
  | "http"
  | "invalid"
  | "oversize"
  | "timeout"
  | "transport";

/** A user-safe usage failure that never includes response bodies, credentials, or identity. */
export class XaiUsageError extends Error {
  readonly code: XaiUsageErrorCode;
  readonly status?: number;

  constructor(code: XaiUsageErrorCode, message: string, status?: number) {
    super(message);
    this.name = "XaiUsageError";
    this.code = code;
    this.status = status;
  }
}

interface JsonBudget {
  nodes: number;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertBoundedJson(value: unknown, depth = 0, budget: JsonBudget = { nodes: 0 }): void {
  if (depth > XAI_USAGE_MAX_JSON_DEPTH || ++budget.nodes > XAI_USAGE_MAX_JSON_NODES) {
    throw new XaiUsageError("invalid", "xAI usage returned an over-complex response.");
  }
  if (Array.isArray(value)) {
    if (value.length > XAI_USAGE_MAX_JSON_ARRAY_ITEMS) {
      throw new XaiUsageError("invalid", "xAI usage returned too many response entries.");
    }
    for (const item of value) assertBoundedJson(item, depth + 1, budget);
    return;
  }
  const obj = objectValue(value);
  if (!obj) return;
  const values = Object.values(obj);
  if (values.length > XAI_USAGE_MAX_JSON_OBJECT_KEYS) {
    throw new XaiUsageError("invalid", "xAI usage returned too many response fields.");
  }
  for (const item of values) assertBoundedJson(item, depth + 1, budget);
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return label && label.length <= MAX_LABEL_LENGTH && !/[\u0000-\u001f\u007f]/.test(label)
    ? label
    : undefined;
}

function boundedTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP_LENGTH) return undefined;
  const match = value.match(RFC3339_PATTERN);
  if (!match) return undefined;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
    || !Number.isFinite(Date.parse(value))
  ) {
    return undefined;
  }
  return value;
}

function boundedPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function boundedCents(value: unknown): number | undefined {
  const wrapper = objectValue(value);
  if (!wrapper) return undefined;
  const cents = wrapper.val === undefined ? 0 : wrapper.val;
  return typeof cents === "number"
    && Number.isSafeInteger(cents)
    && cents >= 0
    && cents <= MAX_CENTS
    ? cents
    : undefined;
}

function usagePeriod(value: unknown): XaiUsagePeriod | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const result: XaiUsagePeriod = {};
  const type = boundedLabel(obj.type);
  const start = boundedTimestamp(obj.start);
  const end = boundedTimestamp(obj.end);
  if (type) result.type = type;
  if (start) result.start = start;
  if (end) result.end = end;
  return Object.keys(result).length > 0 ? result : undefined;
}

function billingCycle(value: unknown): { year: number; month: number } | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const { year, month } = obj;
  return Number.isSafeInteger(year)
    && Number.isSafeInteger(month)
    && (year as number) >= MIN_BILLING_YEAR
    && (year as number) <= MAX_BILLING_YEAR
    && (month as number) >= 1
    && (month as number) <= 12
    ? { year: year as number, month: month as number }
    : undefined;
}

function historyPeriod(value: unknown): XaiUsageHistoryPeriod | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const result: XaiUsageHistoryPeriod = {};
  const period = usagePeriod(obj.period);
  const cycle = billingCycle(obj.billingCycle);
  const included = boundedCents(obj.includedUsed);
  const onDemand = boundedCents(obj.onDemandUsed);
  const total = boundedCents(obj.totalUsed);
  if (period) result.period = period;
  if (cycle) result.billingCycle = cycle;
  if (included !== undefined) result.includedUsedCents = included;
  if (onDemand !== undefined) result.onDemandUsedCents = onDemand;
  if (total !== undefined) result.totalUsedCents = total;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Extract a transient header-safe user ID from the authenticated `/user` response. */
export function parseXaiUserId(value: unknown): string {
  assertBoundedJson(value);
  const userId = objectValue(value)?.userId;
  if (
    typeof userId !== "string"
    || !userId
    || userId.length > MAX_USER_ID_LENGTH
    || !USER_ID_PATTERN.test(userId)
  ) {
    throw new XaiUsageError(
      "invalid",
      "xAI account identity could not be verified; billing was not requested.",
    );
  }
  return userId;
}

/** Parse the bounded observed credits response without retaining its raw representation. */
export function parseXaiUsage(value: unknown): XaiUsageSnapshot {
  assertBoundedJson(value);
  const root = objectValue(value);
  if (!root) throw new XaiUsageError("invalid", "xAI usage returned an invalid response.");
  if (root.config !== undefined && root.config !== null && !objectValue(root.config)) {
    throw new XaiUsageError("invalid", "xAI usage returned an invalid response.");
  }
  const config = objectValue(root.config);
  const snapshot: XaiUsageSnapshot = { history: [] };
  if (typeof root.onDemandEnabled === "boolean") snapshot.onDemandEnabled = root.onDemandEnabled;
  const tier = boundedLabel(root.subscriptionTier);
  if (tier) snapshot.subscriptionTier = tier;
  if (!config) return snapshot;

  const history = config.history;
  if (history !== undefined && !Array.isArray(history)) {
    throw new XaiUsageError("invalid", "xAI usage returned invalid billing history.");
  }
  if (Array.isArray(history) && history.length > XAI_USAGE_MAX_HISTORY_PERIODS) {
    throw new XaiUsageError("invalid", "xAI usage returned too many billing periods.");
  }

  const percent = boundedPercent(config.creditUsagePercent);
  const currentPeriod = usagePeriod(config.currentPeriod);
  const monthlyLimit = boundedCents(config.monthlyLimit);
  const used = boundedCents(config.used);
  const onDemandCap = boundedCents(config.onDemandCap);
  const onDemandUsed = boundedCents(config.onDemandUsed);
  const prepaid = boundedCents(config.prepaidBalance);
  if (percent !== undefined) snapshot.creditUsagePercent = percent;
  if (currentPeriod) snapshot.currentPeriod = currentPeriod;
  if (monthlyLimit !== undefined) snapshot.monthlyLimitCents = monthlyLimit;
  if (used !== undefined) snapshot.usedCents = used;
  if (onDemandCap !== undefined) snapshot.onDemandCapCents = onDemandCap;
  if (onDemandUsed !== undefined) snapshot.onDemandUsedCents = onDemandUsed;
  if (prepaid !== undefined) snapshot.prepaidBalanceCents = prepaid;
  if (typeof config.isUnifiedBillingUser === "boolean") {
    snapshot.isUnifiedBillingUser = config.isUnifiedBillingUser;
  }
  const fallbackStart = boundedTimestamp(config.billingPeriodStart);
  const fallbackEnd = boundedTimestamp(config.billingPeriodEnd);
  if (!snapshot.currentPeriod && (fallbackStart || fallbackEnd)) {
    snapshot.currentPeriod = {
      ...(fallbackStart ? { start: fallbackStart } : {}),
      ...(fallbackEnd ? { end: fallbackEnd } : {}),
    };
  }
  if (Array.isArray(history)) {
    snapshot.history = history
      .map(historyPeriod)
      .filter((entry): entry is XaiUsageHistoryPeriod => entry !== undefined);
  }
  return snapshot;
}

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

function formatPercent(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

function formatCents(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}

function effectivePercent(usage: XaiUsageSnapshot): number | undefined {
  if (usage.creditUsagePercent !== undefined) return usage.creditUsagePercent;
  if (
    usage.usedCents !== undefined
    && usage.monthlyLimitCents !== undefined
    && usage.monthlyLimitCents > 0
  ) {
    return Math.min(100, (usage.usedCents / usage.monthlyLimitCents) * 100);
  }
  return undefined;
}

/** Render only validated usage fields for the explicit command. */
export function renderXaiUsage(usage: XaiUsageSnapshot): string {
  const lines = ["xAI usage (unofficial, revision-pinned):"];
  const percent = effectivePercent(usage);
  if (usage.subscriptionTier) lines.push(`Subscription: ${usage.subscriptionTier}`);
  if (percent !== undefined) lines.push(`Included usage: ${formatPercent(percent)}`);
  if (usage.usedCents !== undefined || usage.monthlyLimitCents !== undefined) {
    lines.push(
      `Included credits: ${usage.usedCents !== undefined ? `${formatCents(usage.usedCents)} used` : "usage unavailable"}`
      + `${usage.monthlyLimitCents !== undefined ? ` of ${formatCents(usage.monthlyLimitCents)}` : ""}`,
    );
  }
  if (usage.currentPeriod?.start) lines.push(`Period start: ${usage.currentPeriod.start}`);
  if (usage.currentPeriod?.end) lines.push(`Reset: ${usage.currentPeriod.end}`);
  if (usage.onDemandUsedCents !== undefined || usage.onDemandCapCents !== undefined) {
    lines.push(
      `On-demand credits: ${usage.onDemandUsedCents !== undefined ? `${formatCents(usage.onDemandUsedCents)} used` : "usage unavailable"}`
      + `${usage.onDemandCapCents !== undefined ? ` of ${formatCents(usage.onDemandCapCents)}` : ""}`,
    );
  }
  if (usage.prepaidBalanceCents !== undefined) {
    lines.push(`Prepaid balance: ${formatCents(usage.prepaidBalanceCents)}`);
  }
  if (usage.onDemandEnabled !== undefined) {
    lines.push(`On-demand billing: ${usage.onDemandEnabled ? "enabled" : "disabled"}`);
  }
  if (usage.isUnifiedBillingUser !== undefined) {
    lines.push(`Usage pool: ${usage.isUnifiedBillingUser ? "unified" : "standard"}`);
  }
  if (usage.history.length > 0) lines.push(`Validated history periods: ${usage.history.length}`);
  if (lines.length === 1) lines.push("No supported usage fields were returned.");
  return lines.join("\n");
}

function usageCsvCell(value: string | number | boolean | undefined): string {
  if (value === undefined) return "";
  let text = String(value);
  // CSV quoting alone does not prevent spreadsheet formula execution.
  if (typeof value === "string" && /^\s*[=+@-]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Render a parsed, bounded usage snapshot as CSV, without identity or raw response fields. */
export function renderXaiUsageCsv(usage: XaiUsageSnapshot): string {
  // Keep an explicit allowlist: never enumerate properties from authenticated data.
  const rows: Array<Array<string | number | boolean | undefined>> = [
    [
      "record_type", "period_type", "period_start", "period_end", "billing_year", "billing_month",
      "subscription_tier", "credit_usage_percent", "monthly_limit_cents", "included_used_cents",
      "on_demand_cap_cents", "on_demand_used_cents", "total_used_cents", "prepaid_balance_cents",
      "on_demand_enabled", "is_unified_billing_user",
    ],
  ];
  const currentRow = [
    "current", usage.currentPeriod?.type, usage.currentPeriod?.start, usage.currentPeriod?.end,
    undefined, undefined, usage.subscriptionTier, usage.creditUsagePercent,
    usage.monthlyLimitCents, usage.usedCents, usage.onDemandCapCents, usage.onDemandUsedCents,
    undefined, usage.prepaidBalanceCents, usage.onDemandEnabled, usage.isUnifiedBillingUser,
  ];
  // Ignore the record type, but keep valid zero/false values. Empty snapshots stay header-only.
  if (currentRow.slice(1).some((cell) => cell !== undefined && cell !== "")) rows.push(currentRow);
  for (const entry of usage.history) {
    rows.push([
      "history", entry.period?.type, entry.period?.start, entry.period?.end,
      entry.billingCycle?.year, entry.billingCycle?.month, undefined, undefined,
      undefined, entry.includedUsedCents, undefined, entry.onDemandUsedCents,
      entry.totalUsedCents, undefined, undefined, undefined,
    ]);
  }
  return rows.map((row) => row.map(usageCsvCell).join(",")).join("\r\n") + "\r\n";
}

/** Render a compact footer value without account identity. */
export function renderXaiUsageStatus(usage: XaiUsageSnapshot): string {
  const percent = effectivePercent(usage);
  const parts = [
    percent !== undefined
      ? `${formatPercent(percent)} used`
      : usage.usedCents !== undefined && usage.monthlyLimitCents !== undefined
        ? `${formatCents(usage.usedCents)}/${formatCents(usage.monthlyLimitCents)}`
        : usage.prepaidBalanceCents !== undefined
          ? `${formatCents(usage.prepaidBalanceCents)} prepaid`
          : "usage available",
  ];
  if (usage.currentPeriod?.end) parts.push(`reset ${usage.currentPeriod.end.slice(0, 10)}`);
  return `xAI ${parts.join(" · ")}`;
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
    if (signal?.aborted) {
      throw new XaiUsageError("cancelled", "xAI usage request was cancelled.");
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
    description: "Show xAI subscription usage, export CSV, or manage the optional session status",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean).map((part) => part.toLowerCase());
      const csv = parts.length === 1 && parts[0] === "csv";
      if (parts.length === 0 || csv) {
        oneShotController?.abort();
        const controller = new AbortController();
        oneShotController = controller;
        const requestGeneration = ++oneShotGeneration;
        const sessionGeneration = generation;
        const forwardAbort = () => controller.abort();
        ctx.signal?.addEventListener("abort", forwardAbort, { once: true });
        if (ctx.signal?.aborted) controller.abort();
        try {
          if (controller.signal.aborted) return;
          const usage = await resolveUsage(ctx, controller.signal);
          if (
            requestGeneration === oneShotGeneration
            && sessionGeneration === generation
            && !controller.signal.aborted
          ) {
            ctx.ui.notify(csv ? renderXaiUsageCsv(usage) : renderXaiUsage(usage), "info");
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
