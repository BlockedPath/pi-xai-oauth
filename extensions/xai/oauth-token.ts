import type { OAuthCredentials } from "@earendil-works/pi-ai";
import {
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_REFRESH_SKEW_MS,
  XAI_OAUTH_TOKEN_URL,
} from "./constants";
import { discoverXaiOidc } from "./oidc";
import { xaiOAuthFormHeaders } from "./wire";

/** Token-endpoint response fields read from xAI OAuth token responses. */
export type XaiTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
};

/** Refresh xAI OAuth credentials using their refresh token. */
export async function refreshXaiCredentials(
  credentials: OAuthCredentials,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  if (!credentials.refresh) {
    throw new Error("xAI credentials are expired and do not include a refresh token");
  }

  const tokenEndpoint =
    typeof credentials.tokenEndpoint === "string" && credentials.tokenEndpoint
      ? credentials.tokenEndpoint
      : (await discoverXaiOidc(signal)).token_endpoint;
  if (tokenEndpoint !== XAI_OAUTH_TOKEN_URL) {
    throw new Error("xAI credentials reference an untrusted token endpoint; run /login xai-auth again");
  }
  const data = await exchangeXaiToken(
    tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: credentials.refresh,
      client_id: XAI_OAUTH_CLIENT_ID,
    },
    signal,
  );

  return credentialsFromTokenPayload(data, tokenEndpoint, credentials.refresh);
}

/** Return credentials as-is when fresh, otherwise refresh them. */
export async function ensureFreshXaiCredentials(
  credentials: OAuthCredentials,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  if (!credentials.expires || credentials.expires > Date.now()) return credentials;
  return refreshXaiCredentials(credentials, signal);
}

/** POST a form grant to the pinned xAI token endpoint and return its JSON object payload. */
export async function exchangeXaiToken(
  tokenEndpoint: string,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<XaiTokenPayload> {
  if (tokenEndpoint !== XAI_OAUTH_TOKEN_URL) {
    throw new Error("Refusing to send xAI credentials to an untrusted token endpoint");
  }

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: xaiOAuthFormHeaders(),
    body: new URLSearchParams(body).toString(),
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error(`xAI token request failed with status ${response.status}`);
  }
  try {
    const payload = (await response.json()) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("invalid payload");
    }
    return payload as XaiTokenPayload;
  } catch {
    throw new Error("xAI token request returned invalid JSON");
  }
}

/** Convert a token-endpoint payload into pi OAuth credentials with the refresh skew applied. */
export function credentialsFromTokenPayload(
  data: XaiTokenPayload,
  tokenEndpoint: string,
  fallbackRefresh = "",
  validatedIdToken?: string,
): OAuthCredentials {
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("xAI token response did not include an access token");
  }

  const refresh = typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : fallbackRefresh;
  if (!refresh) {
    throw new Error("xAI token response did not include a refresh token");
  }
  const expiresIn =
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0
      ? data.expires_in
      : 3600;

  return {
    refresh,
    access: data.access_token,
    expires: Date.now() + expiresIn * 1000 - XAI_OAUTH_REFRESH_SKEW_MS,
    tokenEndpoint,
    ...(validatedIdToken ? { idToken: validatedIdToken } : {}),
    tokenType: typeof data.token_type === "string" && data.token_type ? data.token_type : "Bearer",
  };
}
