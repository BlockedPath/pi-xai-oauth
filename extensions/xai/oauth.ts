import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { createHash, randomBytes, randomUUID } from "crypto";
import { createServer, type Server } from "http";
import {
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_REDIRECT_HOST,
  XAI_OAUTH_REDIRECT_PATH,
  XAI_OAUTH_REDIRECT_PORT,
  XAI_OAUTH_REFRESH_SKEW_MS,
  XAI_OAUTH_SCOPE,
  XAI_OAUTH_TOKEN_URL,
} from "./constants";
import {
  pollXaiDeviceAuthorization,
  requestXaiDeviceAuthorization,
  type XaiDeviceAuthDependencies,
} from "./device-auth";
import { discoverXaiOidc, validateXaiIdToken, type XaiOidcDiscovery } from "./oidc";
import { xaiOAuthFormHeaders } from "./wire";

type XaiTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
};

type CallbackResult = {
  code?: string;
  state?: string;
  error?: string;
};

type ManualCallbackInput =
  | { kind: "callback"; result: CallbackResult }
  | { kind: "raw-code" }
  | { kind: "invalid" };

const RAW_CODE_MIGRATION_MESSAGE =
  "Raw xAI authorization codes are not accepted because they do not include the OAuth state that binds the code to this login. Run /login xai-auth again, then either use device code login or choose browser login and paste the complete redirect URL containing both code and state.";

export const XAI_BROWSER_LOGIN_METHOD = "browser";
export const XAI_DEVICE_LOGIN_METHOD = "device";

export type XaiLoginEnvironment = {
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
};

export type XaiLoginContext = "desktop" | "wsl" | "ssh" | "container" | "headless";

export type XaiOAuthOptions = {
  getExistingCredentials: () => OAuthCredentials | null;
  onLoginCredentials?: (credentials: OAuthCredentials, callbacks: OAuthLoginCallbacks) => Promise<void>;
  deviceAuth?: XaiDeviceAuthDependencies;
  loginEnvironment?: XaiLoginEnvironment;
};

/** Classify the login environment for advisory method-selector copy only. */
export function detectXaiLoginContext(options: XaiLoginEnvironment = {}): XaiLoginContext {
  const env = options.env ?? process.env;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return "wsl";
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return "ssh";
  if (
    env.container ||
    env.KUBERNETES_SERVICE_HOST ||
    env.CODESPACES ||
    env.REMOTE_CONTAINERS ||
    env.DEVCONTAINER
  ) return "container";
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY === true;
  return stdinIsTTY && stdoutIsTTY ? "desktop" : "headless";
}

function loginMethodOptions(environment: XaiLoginEnvironment | undefined) {
  const context = detectXaiLoginContext(environment);
  const recommendation = context === "desktop"
    ? "remote/headless"
    : context === "wsl"
      ? "this WSL session"
      : context === "ssh"
        ? "this SSH session"
        : context === "container"
          ? "this container"
          : "this headless session";
  return [
    { id: XAI_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
    {
      id: XAI_DEVICE_LOGIN_METHOD,
      label: context === "desktop"
        ? "Device code login (remote/headless)"
        : `Device code login (recommended for ${recommendation})`,
    },
  ];
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function assertLoginNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Login cancelled");
}

async function runAbortableLoginStep<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  assertLoginNotCancelled(signal);
  try {
    const result = await operation();
    assertLoginNotCancelled(signal);
    return result;
  } catch (error) {
    if (signal?.aborted) throw new Error("Login cancelled");
    throw error;
  }
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function callbackCorsOrigin(origin: string | undefined): string | undefined {
  return origin === "https://accounts.x.ai" || origin === "https://auth.x.ai" ? origin : undefined;
}

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

async function startCallbackServer(expectedState: string): Promise<{
  redirectUri: string;
  waitForCallback: (signal?: AbortSignal) => Promise<CallbackResult>;
  resolveCallback: (result: CallbackResult) => void;
  close: () => void;
}> {
  let resolveCallback!: (result: CallbackResult) => void;
  const callbackPromise = new Promise<CallbackResult>((resolve) => {
    resolveCallback = resolve;
  });

  const makeServer = () =>
    createServer((req, res) => {
      const origin = callbackCorsOrigin(req.headers.origin);
      const writeCors = () => {
        if (!origin) return;
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        res.setHeader("Vary", "Origin");
      };

      if (req.method === "OPTIONS") {
        writeCors();
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://${XAI_OAUTH_REDIRECT_HOST}`);
      if (url.pathname !== XAI_OAUTH_REDIRECT_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const result: CallbackResult = {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") || undefined,
        error: url.searchParams.get("error") || undefined,
      };
      if (result.state !== expectedState) {
        writeCors();
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><h1>xAI authorization state mismatch.</h1>Please return to pi and try again.</body></html>");
        return;
      }
      resolveCallback(result);

      writeCors();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        result.error
          ? "<html><body><h1>xAI authorization failed.</h1>You can close this tab.</body></html>"
          : "<html><body><h1>xAI authorization received.</h1>You can close this tab.</body></html>",
      );
    });

  const listen = (port: number): Promise<Server> =>
    new Promise((resolve, reject) => {
      const server = makeServer();
      server.once("error", reject);
      server.listen(port, XAI_OAUTH_REDIRECT_HOST, () => {
        server.removeListener("error", reject);
        resolve(server);
      });
    });

  let server: Server;
  try {
    server = await listen(XAI_OAUTH_REDIRECT_PORT);
  } catch {
    server = await listen(0);
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine xAI OAuth callback port");
  }

  const redirectUri = `http://${XAI_OAUTH_REDIRECT_HOST}:${address.port}${XAI_OAUTH_REDIRECT_PATH}`;

  const close = () => {
    try {
      server.close();
    } catch {
      // ignore
    }
  };

  return {
    redirectUri,
    close,
    resolveCallback,
    waitForCallback: async (signal?: AbortSignal) => {
      let timer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;
      const timeout = new Promise<CallbackResult>((_, reject) => {
        if (signal?.aborted) {
          reject(new Error("Login cancelled"));
          return;
        }
        timer = setTimeout(() => reject(new Error("Timed out waiting for xAI OAuth callback")), 180_000);
        abortHandler = () => {
          if (timer) clearTimeout(timer);
          reject(new Error("Login cancelled"));
        };
        signal?.addEventListener("abort", abortHandler, { once: true });
      });

      try {
        return await Promise.race([callbackPromise, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
        close();
      }
    },
  };
}

function buildAuthorizeUrl(
  discovery: XaiOidcDiscovery,
  redirectUri: string,
  challenge: string,
  state: string,
  nonce: string,
): string {
  // Match the official Grok CLI authorize URL. Extra query params such as
  // `plan=generic` can change xAI's routing/branding and send users toward
  // the API-console SSO surface instead of the Grok OAuth consent surface.
  const params = new URLSearchParams({
    response_type: "code",
    client_id: XAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: XAI_OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

function parseCallbackInput(input: string): ManualCallbackInput {
  const value = input.trim();
  if (!value) return { kind: "invalid" };
  if (/^[A-Za-z0-9_-]{20,}$/.test(value)) return { kind: "raw-code" };

  try {
    const url = value.startsWith("http")
      ? new URL(value)
      : new URL(`http://${XAI_OAUTH_REDIRECT_HOST}${XAI_OAUTH_REDIRECT_PATH}?${value.replace(/^\?/, "")}`);
    return {
      kind: "callback",
      result: {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") || undefined,
        error: url.searchParams.get("error") || undefined,
      },
    };
  } catch {
    return { kind: "invalid" };
  }
}

async function exchangeXaiToken(
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

function credentialsFromTokenPayload(
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

/** Build pi's OAuth provider config for xAI/Grok login and refresh. */
export function createXaiOAuth({
  getExistingCredentials,
  onLoginCredentials,
  deviceAuth,
  loginEnvironment,
}: XaiOAuthOptions) {
  const finishLogin = async (
    credentials: OAuthCredentials,
    callbacks: OAuthLoginCallbacks,
  ): Promise<OAuthCredentials> => {
    assertLoginNotCancelled(callbacks.signal);
    if (!onLoginCredentials) return credentials;
    try {
      await onLoginCredentials(credentials, callbacks);
      assertLoginNotCancelled(callbacks.signal);
    } catch (error) {
      if (callbacks.signal?.aborted) throw new Error("Login cancelled");
      // Catalog discovery must never discard an otherwise valid OAuth login.
      callbacks.onProgress?.(
        `xAI login succeeded, but the model catalog could not be refreshed (${messageFromError(error)}); using the curated fallback.`,
      );
    }
    return credentials;
  };

  return {
    usesCallbackServer: true,
    name: "xAI (Grok)",

    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      assertLoginNotCancelled(callbacks.signal);
      const existingCredentials = getExistingCredentials();
      if (existingCredentials) {
        const useExisting = await callbacks.onPrompt({
          message: "Found existing official Grok CLI credentials in ~/.grok/auth.json. Use them instead of opening a new xAI OAuth login? (y/n)",
        });
        if (useExisting.toLowerCase().startsWith("y")) {
          try {
            const credentials = await runAbortableLoginStep(callbacks.signal, () =>
              ensureFreshXaiCredentials(existingCredentials, callbacks.signal),
            );
            return finishLogin(credentials, callbacks);
          } catch (error) {
            callbacks.onProgress?.(
              `Existing Grok CLI credentials could not be refreshed (${messageFromError(error)}). Starting a fresh xAI OAuth login...`,
            );
          }
        }
      }

      const method = typeof callbacks.onSelect === "function"
        ? await runAbortableLoginStep(callbacks.signal, () => callbacks.onSelect({
            message: "Select xAI login method:",
            options: loginMethodOptions(loginEnvironment),
          }))
        : XAI_BROWSER_LOGIN_METHOD;
      if (!method) throw new Error("Login cancelled");
      if (method === XAI_DEVICE_LOGIN_METHOD) {
        callbacks.onProgress?.("Starting xAI device authorization...");
        const device = await runAbortableLoginStep(callbacks.signal, () =>
          requestXaiDeviceAuthorization(deviceAuth, callbacks.signal),
        );
        callbacks.onDeviceCode({
          userCode: device.userCode,
          verificationUri: device.verificationUri,
          intervalSeconds: device.intervalSeconds,
          expiresInSeconds: device.expiresInSeconds,
        });
        callbacks.onProgress?.("Waiting for xAI device authorization...");
        const data = await runAbortableLoginStep(callbacks.signal, () =>
          pollXaiDeviceAuthorization(device, deviceAuth, callbacks.signal),
        );
        return finishLogin(credentialsFromTokenPayload(data, XAI_OAUTH_TOKEN_URL), callbacks);
      }
      if (method !== XAI_BROWSER_LOGIN_METHOD) {
        throw new Error("Unsupported xAI login method");
      }

      callbacks.onProgress?.("Starting xAI SuperGrok OAuth login...");
      const discovery = await runAbortableLoginStep(callbacks.signal, () => discoverXaiOidc(callbacks.signal));
      const { verifier, challenge } = pkcePair();
      const state = randomUUID().replace(/-/g, "");
      const nonce = randomUUID().replace(/-/g, "");
      const callbackServer = await startCallbackServer(state);
      let callback: CallbackResult;
      try {
        const authorizeUrl = buildAuthorizeUrl(discovery, callbackServer.redirectUri, challenge, state, nonce);

        // Trigger automatic browser open via pi's onAuth handler.
        // pi's login dialog runs `open <url>` on macOS / `xdg-open` on Linux,
        // AND when usesCallbackServer:true it also shows a built-in manual input
        // field that resolves via onManualCodeInput. We race both paths below.
        callbacks.onAuth?.({
          url: authorizeUrl,
          instructions:
            "If the automatic open uses the wrong browser/profile, copy the authorization URL and open it manually. If the redirect cannot reach pi, paste the complete redirect URL (including code and state) below; raw codes are not accepted.",
        });

        callbacks.onProgress?.(`Waiting for xAI OAuth callback on ${callbackServer.redirectUri}...`);

        // Race the local callback server against pi's built-in manual input
        // (shown automatically when usesCallbackServer: true). If the HTTP
        // callback fires first (browser reaches localhost), the manual input
        // is simply a no-op since resolveCallback already ran.
        const manualCodePromise = callbacks.onManualCodeInput?.();
        if (manualCodePromise) {
          manualCodePromise
            .then((input: string) => {
              if (!input) return;
              const manual = parseCallbackInput(input);
              if (manual.kind === "raw-code") {
                callbacks.onProgress?.(RAW_CODE_MIGRATION_MESSAGE);
                callbackServer.resolveCallback({ error: "raw_code_not_supported", state });
                return;
              }
              if (manual.kind === "invalid") {
                callbacks.onProgress?.("Ignored pasted xAI OAuth input because it was not a complete redirect URL.");
                return;
              }
              if (manual.result.state !== state) {
                callbacks.onProgress?.(
                  "Ignored pasted xAI callback because it was missing the matching OAuth state. Paste the complete redirect URL from this login attempt.",
                );
                return;
              }
              callbackServer.resolveCallback(manual.result);
            })
            .catch(() => {
              // Cancellation is handled by callbacks.signal / the login dialog.
            });
        }

        callback = await callbackServer.waitForCallback(callbacks.signal);
      } finally {
        callbackServer.close();
      }
      if (callback.error === "raw_code_not_supported") {
        throw new Error(RAW_CODE_MIGRATION_MESSAGE);
      }
      if (callback.state !== state) {
        throw new Error("xAI authorization failed: state mismatch");
      }
      if (callback.error) {
        throw new Error("xAI authorization failed");
      }
      if (!callback.code) {
        throw new Error("xAI authorization failed: no authorization code returned");
      }

      assertLoginNotCancelled(callbacks.signal);
      callbacks.onProgress?.("Exchanging xAI authorization code...");
      const data = await runAbortableLoginStep(callbacks.signal, () =>
        exchangeXaiToken(
          discovery.token_endpoint,
          {
            grant_type: "authorization_code",
            code: callback.code!,
            redirect_uri: callbackServer.redirectUri,
            client_id: XAI_OAUTH_CLIENT_ID,
            code_verifier: verifier,
          },
          callbacks.signal,
        ),
      );
      if (typeof data.id_token !== "string" || !data.id_token) {
        throw new Error("xAI token response did not include an ID token");
      }
      await runAbortableLoginStep(callbacks.signal, () =>
        validateXaiIdToken(data.id_token!, discovery, nonce, callbacks.signal),
      );
      assertLoginNotCancelled(callbacks.signal);

      return finishLogin(
        credentialsFromTokenPayload(data, discovery.token_endpoint, "", data.id_token),
        callbacks,
      );
    },

    async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      if (!credentials.refresh && credentials.expires && credentials.expires <= Date.now()) {
        throw new Error("xAI OAuth token is expired and cannot be refreshed. Please run /login xai-auth again.");
      }
      if (!credentials.refresh) return credentials;
      return refreshXaiCredentials(credentials);
    },

    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },
  };
}
