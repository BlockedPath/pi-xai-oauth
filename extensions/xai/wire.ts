import { readTruncatedResponseText } from "./bounded-body";
import {
  XAI_CLIENT_IDENTIFIER,
  XAI_CLI_RESPONSES_URL,
  XAI_GROK_BUILD_REVIEWED_REVISION,
  XAI_IMAGES_EDITS_URL,
  XAI_IMAGES_GENERATIONS_URL,
  XAI_PROXY_CLIENT_VERSION,
  XAI_RESPONSES_URL,
  XAI_USER_AGENT,
  XAI_VIDEOS_GENERATIONS_URL,
  XAI_VIDEOS_STATUS_PREFIX,
} from "./constants";
import type { XaiCredentialKind } from "./routing";

const MAX_ERROR_BODY_BYTES = 16 * 1024;
const RESERVED_HEADER_NAMES = new Set([
  "accept",
  "authorization",
  "content-type",
  "session_id",
  "user-agent",
  "x-authenticateresponse",
  "x-client-request-id",
  "x-session-id",
  "x-userid",
  "x-xai-token-auth",
]);
const APPROVED_PROXY_HEADER_NAMES = new Set([
  "x-authenticateresponse",
  "x-grok-client-identifier",
  "x-grok-client-mode",
  "x-grok-client-version",
  "x-grok-conv-id",
  "x-grok-model-override",
  "x-grok-req-id",
  "x-grok-session-id",
  "x-xai-token-auth",
]);
const VERSION_GATE_STATUSES = new Set([400, 401, 403, 426]);
const VERSION_GATE_PATTERN =
  /\b(?:client[-_ ]?version|minimum[-_ ]?version|outdated[-_ ]?client|unsupported[-_ ]?client|update[-_ ]?required|version[-_ ]?gate)\b/i;
const ENCRYPTED_CONTENT_MISMATCH_PATTERN = /encrypted_content/;
const INVALID_REQUEST_PATTERN = /\binvalid_request\b/i;
export const XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE =
  "xAI could not replay encrypted reasoning for this model. Start a clean session or turn using the same xAI model.";

export type XaiClientMode = "interactive" | "headless";
export type XaiOAuthClientSurface = "ui" | "cli" | "headless";
export type XaiHttpRouteKind =
  | "responses-proxy"
  | "responses-direct"
  | "image-generation"
  | "image-edit"
  | "video-generation-create"
  | "video-generation-status"
  | "unknown";

export interface XaiProxyRequestMetadata {
  conversationId: string;
  requestId: string;
  sessionId: string;
}

export interface XaiProxyHeaderOptions {
  streaming?: boolean;
  clientMode?: XaiClientMode;
}

/** Resolve truthful Grok proxy client mode from pi's arguments and terminal state. */
export function resolveXaiClientMode(
  argv: readonly string[] = process.argv.slice(2),
  stdinIsTTY = process.stdin.isTTY === true,
  stdoutIsTTY = process.stdout.isTTY === true,
): XaiClientMode {
  let outputMode: "text" | "json" | "rpc" | undefined;
  let printRequested = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode" && index + 1 < argv.length) {
      const candidate = argv[++index];
      if (candidate === "text" || candidate === "json" || candidate === "rpc") {
        outputMode = candidate;
      }
    } else if (arg === "-p" || arg === "--print") {
      printRequested = true;
    }
  }

  if (outputMode === "json" || outputMode === "rpc" || printRequested) return "headless";
  return stdinIsTTY && stdoutIsTTY ? "interactive" : "headless";
}

/** Map pi's client mode onto xAI's OAuth client-surface vocabulary. */
export function resolveXaiOAuthClientSurface(): Exclude<XaiOAuthClientSurface, "ui"> {
  return resolveXaiClientMode() === "interactive" ? "cli" : "headless";
}

/** Remove all internally owned or unsupported xAI headers from caller input. */
export function scrubXaiReservedHeaders(
  headers: Record<string, string | null> | undefined,
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => {
      const normalized = name.trim().toLowerCase();
      return !RESERVED_HEADER_NAMES.has(normalized) && !normalized.startsWith("x-grok-");
    }),
  );
}

/** Build the complete internally owned contract for an OAuth Responses proxy request. */
export function xaiProxyRequestHeaders(
  modelId: string,
  credentialKind: XaiCredentialKind,
  metadata: XaiProxyRequestMetadata,
  options: XaiProxyHeaderOptions = {},
): Record<string, string> {
  if (credentialKind !== "oauth-session") return {};
  const normalizedModelId = (modelId || "").toLowerCase().split("/").pop() || "";

  return {
    Accept: options.streaming ? "text/event-stream" : "application/json",
    "Content-Type": "application/json",
    "User-Agent": XAI_USER_AGENT,
    "x-grok-client-identifier": XAI_CLIENT_IDENTIFIER,
    "x-grok-client-version": XAI_PROXY_CLIENT_VERSION,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-mode": options.clientMode ?? resolveXaiClientMode(),
    "x-grok-conv-id": metadata.conversationId,
    "x-grok-req-id": metadata.requestId,
    "x-grok-model-override": normalizedModelId,
    "x-grok-session-id": metadata.sessionId,
  };
}

/** Build the exact entitlement-catalog proxy header contract. */
export function xaiCatalogHeaders(
  accessToken: string,
  clientMode: XaiClientMode = resolveXaiClientMode(),
): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": XAI_USER_AGENT,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-identifier": XAI_CLIENT_IDENTIFIER,
    "x-grok-client-version": XAI_PROXY_CLIENT_VERSION,
    "x-grok-client-mode": clientMode,
  };
}

/** Build the exact authenticated CLI-proxy header contract for usage GET requests. */
export function xaiUsageHeaders(
  accessToken: string,
  userId?: string,
  clientMode: XaiClientMode = resolveXaiClientMode(),
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": XAI_PROXY_CLIENT_VERSION,
    "x-grok-client-mode": clientMode,
    ...(userId ? { "x-userid": userId } : {}),
  };
}

/** Build pinned OAuth form-request headers without CLI-proxy metadata. */
export function xaiOAuthFormHeaders(
  surface: XaiOAuthClientSurface = resolveXaiOAuthClientSurface(),
): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": XAI_USER_AGENT,
    "X-Grok-Client-Version": XAI_PROXY_CLIENT_VERSION,
    "X-Grok-Client-Surface": surface,
  };
}

/** Build protected JSON POST headers from a bearer and approved internal proxy metadata. */
export function xaiJsonPostHeaders(
  authToken: string,
  contractHeaders: Record<string, string> = {},
): Record<string, string> {
  const approvedProxyHeaders = Object.fromEntries(
    Object.entries(contractHeaders).filter(([name]) =>
      APPROVED_PROXY_HEADER_NAMES.has(name.toLowerCase()),
    ),
  );
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
    "User-Agent": XAI_USER_AGENT,
    ...approvedProxyHeaders,
  };
}

/** Build the exact protected header contract for direct public media JSON requests. */
export function xaiDirectMediaJsonHeaders(authToken: string): Record<string, string> {
  return xaiJsonPostHeaders(authToken);
}

/** Build protected JSON GET headers for direct public media status requests. */
export function xaiDirectMediaJsonGetHeaders(authToken: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${authToken}`,
    "User-Agent": XAI_USER_AGENT,
  };
}

function routeKindForUrl(url: string): XaiHttpRouteKind {
  if (url === XAI_CLI_RESPONSES_URL) return "responses-proxy";
  if (url === XAI_RESPONSES_URL) return "responses-direct";
  if (url === XAI_IMAGES_GENERATIONS_URL) return "image-generation";
  if (url === XAI_IMAGES_EDITS_URL) return "image-edit";
  if (url === XAI_VIDEOS_GENERATIONS_URL) return "video-generation-create";
  if (url.startsWith(XAI_VIDEOS_STATUS_PREFIX)) return "video-generation-status";
  return "unknown";
}

function statusFromTransportText(value: string): number | undefined {
  const match = value.match(/(?:API error|HTTP|status(?: code)?)\D{0,12}([1-5]\d{2})/i);
  return match ? Number(match[1]) : undefined;
}

function isProxyVersionGate(status: number | undefined, detail: string): boolean {
  return (
    status === 426 ||
    (!!status && VERSION_GATE_STATUSES.has(status) && VERSION_GATE_PATTERN.test(detail))
  );
}

function isEncryptedContentMismatch(
  status: number | undefined,
  detail: string,
  routeKind: XaiHttpRouteKind,
  streamedFailure = false,
): boolean {
  if (
    routeKind !== "responses-proxy" ||
    !ENCRYPTED_CONTENT_MISMATCH_PATTERN.test(detail)
  ) return false;
  if (status !== undefined) return status === 400;
  return streamedFailure && INVALID_REQUEST_PATTERN.test(detail);
}

function routeLabel(routeKind: XaiHttpRouteKind): string {
  if (routeKind === "responses-proxy" || routeKind === "responses-direct") return "Responses";
  if (routeKind === "image-generation") return "image generation";
  if (routeKind === "image-edit") return "image editing";
  if (routeKind === "video-generation-create") return "video generation";
  if (routeKind === "video-generation-status") return "video status";
  return "request";
}

/**
 * Return stable transport text without reflecting raw upstream response bodies.
 *
 * An explicit numeric status wins over status text parsed from `detail`. A
 * status-less streamed failure is classified as an encrypted-reasoning
 * mismatch only when `streamedFailure` is true and the bounded delegate detail
 * contains both the `invalid_request` code and `encrypted_content` marker.
 *
 * @param detail Bounded transport or delegate error text used only for classification.
 * @param status Numeric HTTP status when the transport preserved one.
 * @param routeKind Internally selected pinned route classification.
 * @param streamedFailure Whether the status-less detail came from a terminal streamed failure.
 * @returns A fixed, non-reflective error message with safe route and status classification.
 */
export function safeXaiTransportErrorMessage(
  detail: string,
  status?: number,
  routeKind: XaiHttpRouteKind = "unknown",
  streamedFailure = false,
): string {
  const resolvedStatus = status ?? statusFromTransportText(detail);
  if (isEncryptedContentMismatch(resolvedStatus, detail, routeKind, streamedFailure)) {
    return XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE;
  }
  if (routeKind === "responses-proxy" && isProxyVersionGate(resolvedStatus, detail)) {
    const statusText = resolvedStatus ? ` (HTTP ${resolvedStatus})` : "";
    return `xAI proxy rejected ${XAI_CLIENT_IDENTIFIER}'s reviewed client/version contract${statusText}. Update ${XAI_CLIENT_IDENTIFIER}; if already current, open a compatibility issue with the HTTP status only. Last reviewed Grok Build revision: ${XAI_GROK_BUILD_REVIEWED_REVISION}.`;
  }
  const statusText = resolvedStatus ? ` with status ${resolvedStatus}` : "";
  return `xAI API error: ${routeLabel(routeKind)} failed${statusText}`;
}

/** HTTP error carrying only stable route/status classification. */
export class XaiHttpError extends Error {
  readonly status: number;
  readonly routeKind: XaiHttpRouteKind;
  readonly code: "encrypted-content-mismatch" | "proxy-version-gate" | "http";

  constructor(status: number, routeKind: XaiHttpRouteKind, detail = "") {
    super(safeXaiTransportErrorMessage(detail, status, routeKind));
    this.name = "XaiHttpError";
    this.status = status;
    this.routeKind = routeKind;
    this.code = isEncryptedContentMismatch(status, detail, routeKind)
      ? "encrypted-content-mismatch"
      : routeKind === "responses-proxy" && isProxyVersionGate(status, detail)
        ? "proxy-version-gate"
        : "http";
  }
}

/** Convert an unsuccessful response into a bounded, non-reflective xAI error. */
export async function xaiHttpErrorFromResponse(
  response: Response,
  url: string,
  signal?: AbortSignal,
): Promise<XaiHttpError> {
  const detail = await readTruncatedResponseText(response, MAX_ERROR_BODY_BYTES, signal);
  return new XaiHttpError(response.status, routeKindForUrl(url), detail);
}
