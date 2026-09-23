import { awaitAbortable, composeTimeoutSignal, throwIfAborted } from "./abort";
import { readBoundedResponseText } from "./bounded-body";
import {
  XAI_OAUTH_DISCOVERY_URL,
  XAI_OAUTH_JWKS_URL,
  XAI_OAUTH_MAX_RESPONSE_BYTES,
  XAI_OAUTH_REQUEST_TIMEOUT_MS,
  XAI_OAUTH_TOKEN_URL,
} from "./constants";
import { xaiOAuthFormHeaders } from "./wire";

class XaiOAuthResponseTooLargeError extends Error {}

type XaiOAuthJsonRequest =
  | { kind: "discovery" | "jwks"; signal?: AbortSignal }
  | { kind: "token"; form: Record<string, string>; signal?: AbortSignal };

/** Fetch bounded JSON from one pinned browser OAuth endpoint. */
export async function requestXaiOAuthJson(request: XaiOAuthJsonRequest): Promise<unknown> {
  const url = request.kind === "discovery"
    ? XAI_OAUTH_DISCOVERY_URL
    : request.kind === "jwks"
      ? XAI_OAUTH_JWKS_URL
      : XAI_OAUTH_TOKEN_URL;
  const label = request.kind === "discovery"
    ? "xAI OIDC discovery"
    : request.kind === "jwks"
      ? "xAI JWKS"
      : "xAI token request";
  throwIfAborted(request.signal, () => new Error(`${label} cancelled`));
  const abort = composeTimeoutSignal(request.signal, XAI_OAUTH_REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await awaitAbortable(fetch(url, {
        method: request.kind === "token" ? "POST" : "GET",
        headers: request.kind === "token" ? xaiOAuthFormHeaders() : { Accept: "application/json" },
        ...(request.kind === "token" ? { body: new URLSearchParams(request.form).toString() } : {}),
        redirect: "error",
        signal: abort.signal,
      }).then((result) => {
        if (abort.signal.aborted) void result.body?.cancel().catch(() => undefined);
        return result;
      }), abort.signal);
    } catch {
      if (request.signal?.aborted) throw new Error(`${label} cancelled`);
      if (abort.timedOut()) throw new Error(`${label} timed out`);
      throw new Error(`${label} failed`);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`${label} ${request.kind === "jwks" ? "request " : ""}failed with status ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (request.kind !== "token" && contentType !== "application/json") {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`${label} did not return application/json`);
    }
    let contents: string;
    try {
      contents = await awaitAbortable(readBoundedResponseText(response, {
        maxBytes: XAI_OAUTH_MAX_RESPONSE_BYTES,
        signal: abort.signal,
        overflowError: () => new XaiOAuthResponseTooLargeError(`${label} response was too large`),
      }), abort.signal);
    } catch (error) {
      if (request.signal?.aborted) throw new Error(`${label} cancelled`);
      if (abort.timedOut()) throw new Error(`${label} timed out`);
      if (error instanceof XaiOAuthResponseTooLargeError) throw error;
      throw new Error(`${label} failed`);
    }
    try {
      return JSON.parse(contents) as unknown;
    } catch {
      throw new Error(`${label} returned invalid JSON`);
    }
  } finally {
    abort.dispose();
  }
}
