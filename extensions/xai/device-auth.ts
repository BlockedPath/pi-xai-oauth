import {
  abortableSleep as sharedAbortableSleep,
  awaitAbortable,
  cancellationError,
  composeTimeoutSignal,
  throwIfAborted,
} from "./abort";
import { hasJsonContentType, readBoundedResponseText } from "./bounded-body";
import {
  XAI_CLIENT_IDENTIFIER,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DEVICE_DEFAULT_INTERVAL_SECONDS,
  XAI_OAUTH_DEVICE_GRANT_TYPE,
  XAI_OAUTH_DEVICE_MAX_DURATION_MS,
  XAI_OAUTH_DEVICE_MAX_RESPONSE_BYTES,
  XAI_OAUTH_DEVICE_MIN_INTERVAL_SECONDS,
  XAI_OAUTH_DEVICE_REQUEST_TIMEOUT_MS,
  XAI_OAUTH_DEVICE_SLOW_DOWN_SECONDS,
  XAI_OAUTH_DEVICE_URL,
  XAI_OAUTH_DEVICE_VERIFICATION_ORIGINS,
  XAI_OAUTH_SCOPE,
  XAI_OAUTH_TOKEN_URL,
} from "./constants";
import { xaiOAuthFormHeaders, type XaiOAuthClientSurface } from "./wire";

const MAX_DEVICE_CODE_LENGTH = 4096;
const MAX_USER_CODE_LENGTH = 128;
const MAX_VERIFICATION_URI_LENGTH = 2048;
const MAX_DEVICE_EXPIRY_SECONDS = 24 * 60 * 60;
const CANCEL_MESSAGE = "Login cancelled";
const EXPIRED_MESSAGE = "xAI device authorization expired; run /login xai-auth again";

type JsonRecord = Record<string, unknown>;

export interface XaiDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export interface XaiDeviceTokenPayload {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  token_type?: string;
}

export interface XaiDeviceAuthDependencies {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
  clientSurface?: XaiOAuthClientSurface;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNotCancelled(signal?: AbortSignal): void {
  throwIfAborted(signal, () => new Error(CANCEL_MESSAGE));
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return sharedAbortableSleep(milliseconds, signal, () => new Error(CANCEL_MESSAGE));
}

async function readBoundedJson(response: Response, label: string, signal?: AbortSignal): Promise<JsonRecord> {
  if (!hasJsonContentType(response)) {
    throw new Error(`${label} did not return JSON`);
  }

  const text = await readBoundedResponseText(response, {
    maxBytes: XAI_OAUTH_DEVICE_MAX_RESPONSE_BYTES,
    signal,
    overflowError: () => new Error(`${label} was too large`),
    abortError: () => cancellationError("The operation was aborted"),
  });

  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function positiveInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : undefined;
}

function validateVerificationUri(value: unknown): string | undefined {
  const uri = boundedString(value, MAX_VERIFICATION_URI_LENGTH);
  if (!uri) return undefined;
  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== "https:" ||
      !XAI_OAUTH_DEVICE_VERIFICATION_ORIGINS.includes(parsed.origin as (typeof XAI_OAUTH_DEVICE_VERIFICATION_ORIGINS)[number]) ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

async function withPostFormResponse<T>(
  url: string,
  form: Record<string, string>,
  label: string,
  dependencies: XaiDeviceAuthDependencies,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  handle: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (url !== XAI_OAUTH_DEVICE_URL && url !== XAI_OAUTH_TOKEN_URL) {
    throw new Error("Refusing to send xAI device credentials to an untrusted endpoint");
  }
  assertNotCancelled(signal);
  const abort = composeTimeoutSignal(signal, Math.min(timeoutMs, dependencies.requestTimeoutMs ?? XAI_OAUTH_DEVICE_REQUEST_TIMEOUT_MS));
  try {
    let response: Response;
    try {
      response = await awaitAbortable(
        (dependencies.fetchImpl ?? fetch)(url, {
          method: "POST",
          headers: xaiOAuthFormHeaders(dependencies.clientSurface ?? "ui"),
          body: new URLSearchParams(form).toString(),
          redirect: "error",
          signal: abort.signal,
        }),
        abort.signal,
      );
    } catch {
      if (signal?.aborted) throw new Error(CANCEL_MESSAGE);
      if (abort.timedOut()) throw new Error(`${label} timed out`);
      throw new Error(`${label} failed`);
    }
    try {
      return await awaitAbortable(handle(response, abort.signal), abort.signal);
    } catch (error) {
      if (signal?.aborted) throw new Error(CANCEL_MESSAGE);
      if (abort.timedOut()) throw new Error(`${label} timed out`);
      throw error;
    }
  } finally {
    abort.dispose();
  }
}

/** Request and validate an xAI device authorization challenge. */
export async function requestXaiDeviceAuthorization(
  dependencies: XaiDeviceAuthDependencies = {},
  signal?: AbortSignal,
): Promise<XaiDeviceAuthorization> {
  return withPostFormResponse(
    XAI_OAUTH_DEVICE_URL,
    {
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: XAI_OAUTH_SCOPE,
      referrer: XAI_CLIENT_IDENTIFIER,
    },
    "xAI device authorization request",
    dependencies,
    signal,
    XAI_OAUTH_DEVICE_REQUEST_TIMEOUT_MS,
    async (response, requestSignal) => {
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? "xAI device authorization is not available; choose browser login"
            : `xAI device authorization request failed with status ${response.status}`,
        );
      }
      const data = await readBoundedJson(response, "xAI device authorization response", requestSignal);
      const deviceCode = boundedString(data.device_code, MAX_DEVICE_CODE_LENGTH);
      const userCode = boundedString(data.user_code, MAX_USER_CODE_LENGTH);
      const verificationUri = validateVerificationUri(data.verification_uri);
      const expiresInSeconds = positiveInteger(data.expires_in, MAX_DEVICE_EXPIRY_SECONDS);
      const suppliedInterval = data.interval === undefined
        ? XAI_OAUTH_DEVICE_DEFAULT_INTERVAL_SECONDS
        : positiveInteger(data.interval, MAX_DEVICE_EXPIRY_SECONDS);
      if (
        !deviceCode ||
        !userCode ||
        !/^[A-Za-z0-9-]+$/.test(userCode) ||
        !verificationUri ||
        verificationUriContainsSecret(verificationUri, deviceCode) ||
        !expiresInSeconds ||
        !suppliedInterval
      ) {
        throw new Error("xAI device authorization response had an invalid schema");
      }
      return {
        deviceCode,
        userCode,
        // pi shows the user code separately. Ignore verification_uri_complete
        // so the opaque device code can never be reflected into UI/browser URLs.
        verificationUri,
        intervalSeconds: Math.max(XAI_OAUTH_DEVICE_MIN_INTERVAL_SECONDS, suppliedInterval),
        expiresInSeconds: Math.min(expiresInSeconds, XAI_OAUTH_DEVICE_MAX_DURATION_MS / 1000),
      };
    },
  );
}

function decodedComponentContainsSecret(value: string, secret: string): boolean {
  let current = value;
  for (let pass = 0; pass < 8; pass += 1) {
    if (current.includes(secret)) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return true;
    }
    if (decoded === current) return false;
    current = decoded;
  }
  // Reject excessive nested encoding rather than guessing how a browser or
  // intermediary will canonicalize it.
  return true;
}

function verificationUriContainsSecret(uri: string, secret: string): boolean {
  try {
    const parsed = new URL(uri);
    // Scan the complete serialization first so secrets spanning URL syntax
    // delimiters (for example `abc=def`) cannot evade component-wise checks.
    if (decodedComponentContainsSecret(parsed.toString(), secret)) return true;
    if (decodedComponentContainsSecret(parsed.pathname, secret)) return true;
    for (const [key, value] of parsed.searchParams) {
      if (decodedComponentContainsSecret(key, secret) || decodedComponentContainsSecret(value, secret)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function validateTokenSuccess(data: JsonRecord): XaiDeviceTokenPayload {
  const accessToken = boundedString(data.access_token, XAI_OAUTH_DEVICE_MAX_RESPONSE_BYTES);
  if (!accessToken) throw new Error("xAI device token response did not include an access token");
  const refreshToken = boundedString(data.refresh_token, XAI_OAUTH_DEVICE_MAX_RESPONSE_BYTES);
  if (!refreshToken) throw new Error("xAI device token response did not include a refresh token");
  const expiresIn = data.expires_in === undefined
    ? undefined
    : positiveInteger(data.expires_in, MAX_DEVICE_EXPIRY_SECONDS);
  const tokenType = data.token_type === undefined
    ? undefined
    : boundedString(data.token_type, 64);
  if ((data.expires_in !== undefined && !expiresIn) || (data.token_type !== undefined && !tokenType)) {
    throw new Error("xAI device token response had an invalid schema");
  }
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(expiresIn ? { expires_in: expiresIn } : {}),
    ...(tokenType ? { token_type: tokenType } : {}),
  };
}

async function pollTokenOnce(
  device: XaiDeviceAuthorization,
  dependencies: XaiDeviceAuthDependencies,
  signal: AbortSignal | undefined,
  requestBudget: number,
) {
  return withPostFormResponse(
    XAI_OAUTH_TOKEN_URL,
    {
      grant_type: XAI_OAUTH_DEVICE_GRANT_TYPE,
      device_code: device.deviceCode,
      client_id: XAI_OAUTH_CLIENT_ID,
    },
    "xAI device token request",
    dependencies,
    signal,
    requestBudget,
    async (response, requestSignal) => {
      if (response.ok) {
        return {
          kind: "success" as const,
          data: await readBoundedJson(response, "xAI device token response", requestSignal),
        };
      }
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        return { kind: "http" as const, status: response.status };
      }
      try {
        return {
          kind: "oauth" as const,
          status: response.status,
          data: await readBoundedJson(response, "xAI device token response", requestSignal),
        };
      } catch {
        return { kind: "http" as const, status: response.status };
      }
    },
  );
}

/** Poll xAI's pinned token endpoint until device authorization completes or terminates. */
export async function pollXaiDeviceAuthorization(
  device: XaiDeviceAuthorization,
  dependencies: XaiDeviceAuthDependencies = {},
  signal?: AbortSignal,
): Promise<XaiDeviceTokenPayload> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? abortableSleep;
  const startedAt = now();
  const timeoutMs = Math.min(device.expiresInSeconds * 1000, XAI_OAUTH_DEVICE_MAX_DURATION_MS);
  let scheduledWaitMs = 0;
  const intervalSeconds = Number.isFinite(device.intervalSeconds) && device.intervalSeconds > 0
    ? device.intervalSeconds
    : XAI_OAUTH_DEVICE_DEFAULT_INTERVAL_SECONDS;
  let intervalMs = Math.max(XAI_OAUTH_DEVICE_MIN_INTERVAL_SECONDS * 1000, intervalSeconds * 1000);

  const remainingMs = () => timeoutMs - Math.max(Math.max(0, now() - startedAt), scheduledWaitMs);

  while (remainingMs() > 0) {
    assertNotCancelled(signal);
    const waitMs = Math.min(intervalMs, remainingMs());
    try {
      await sleep(waitMs, signal);
    } catch {
      if (signal?.aborted) throw new Error(CANCEL_MESSAGE);
      throw new Error("xAI device authorization wait failed");
    }
    scheduledWaitMs += waitMs;
    assertNotCancelled(signal);
    const requestBudget = remainingMs();
    if (requestBudget <= 0) break;

    let result: Awaited<ReturnType<typeof pollTokenOnce>>;
    try {
      result = await pollTokenOnce(
        device,
        dependencies,
        signal,
        requestBudget,
      );
    } catch (error) {
      if (!signal?.aborted && remainingMs() <= 0) throw new Error(EXPIRED_MESSAGE);
      throw error;
    }
    assertNotCancelled(signal);
    if (remainingMs() <= 0) throw new Error(EXPIRED_MESSAGE);
    if (result.kind === "success") return validateTokenSuccess(result.data);
    if (result.kind === "http") {
      throw new Error(`xAI device token request failed with status ${result.status}`);
    }

    const data = result.data;
    const error = boundedString(data.error, 128);
    if (!error) throw new Error("xAI device token response had an invalid schema");
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      const replacementInterval = data.interval === undefined
        ? undefined
        : positiveInteger(data.interval, MAX_DEVICE_EXPIRY_SECONDS);
      if (data.interval !== undefined && !replacementInterval) {
        throw new Error("xAI device token response had an invalid schema");
      }
      intervalMs = Math.max(
        intervalMs + XAI_OAUTH_DEVICE_SLOW_DOWN_SECONDS * 1000,
        (replacementInterval ?? 0) * 1000,
      );
      continue;
    }
    if (error === "access_denied" || error === "authorization_denied") {
      throw new Error("xAI device authorization was denied");
    }
    if (error === "expired_token") throw new Error(EXPIRED_MESSAGE);
    throw new Error("xAI device authorization failed");
  }

  throw new Error(EXPIRED_MESSAGE);
}
