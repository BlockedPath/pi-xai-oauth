import { composeTimeoutSignal } from "../abort";

export type XaiVoiceErrorCode =
  | "invalid_input"
  | "cancelled"
  | "timeout"
  | "network_failure"
  | "http_failure"
  | "invalid_response"
  | "output_failure";

/** A Grok voice failure whose message is safe to show verbatim; it never reflects response bodies. */
export class XaiVoiceOperationError extends Error {
  constructor(
    message: string,
    readonly code: XaiVoiceErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = "XaiVoiceOperationError";
  }
}

/** Throw a stable invalid-input voice error. */
export function invalidVoiceInput(message: string): never {
  throw new XaiVoiceOperationError(message, "invalid_input");
}

/** Status-only, actionable message for an unsuccessful voice response. */
export function voiceHttpFailureMessage(label: string, status: number): string {
  const base = `xAI ${label} failed with HTTP ${status}.`;
  if (status === 401) return `${base} Sign in again with /login and retry.`;
  if (status === 403) return `${base} This xAI account may not include voice access.`;
  if (status === 413) return `${base} The audio or text is too large for xAI ${label}.`;
  if (status === 429) return `${base} xAI rate-limited the request; try again shortly.`;
  return base;
}

/**
 * POST to a pinned voice route with redirect rejection and one composed
 * caller/timeout signal that stays armed until `consume` has read the body.
 */
export async function fetchVoiceRoute<T>(options: {
  url: string;
  init: RequestInit;
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch: typeof fetch;
  consume: (response: Response, signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const abort = composeTimeoutSignal(options.signal, options.timeoutMs);
  const classify = (error: unknown): XaiVoiceOperationError => {
    if (error instanceof XaiVoiceOperationError) return error;
    if (options.signal?.aborted) {
      return new XaiVoiceOperationError(`xAI ${options.label} was cancelled.`, "cancelled");
    }
    if (abort.timedOut()) {
      return new XaiVoiceOperationError(`xAI ${options.label} timed out.`, "timeout");
    }
    return new XaiVoiceOperationError(
      `xAI ${options.label} request failed. Check the network and try again.`,
      "network_failure",
    );
  };
  try {
    let response: Response;
    try {
      response = await options.fetch(options.url, {
        ...options.init,
        signal: abort.signal,
        redirect: "error",
      });
    } catch (error) {
      throw classify(error);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new XaiVoiceOperationError(
        voiceHttpFailureMessage(options.label, response.status),
        "http_failure",
        response.status,
      );
    }
    try {
      return await options.consume(response, abort.signal);
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw classify(error);
    }
  } finally {
    abort.dispose();
  }
}
