import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { randomUUID } from "crypto";
import { XAI_OAUTH_CLIENT_ID, XAI_OAUTH_TOKEN_URL } from "./constants";
import {
  pollXaiDeviceAuthorization,
  requestXaiDeviceAuthorization,
  type XaiDeviceAuthDependencies,
} from "./device-auth";
import {
  buildAuthorizeUrl,
  parseCallbackInput,
  pkcePair,
  startCallbackServer,
  type CallbackResult,
} from "./oauth-browser";
import {
  credentialsFromTokenPayload,
  ensureFreshXaiCredentials,
  exchangeXaiToken,
  refreshXaiCredentials,
} from "./oauth-token";
import { discoverXaiOidc, validateXaiIdToken } from "./oidc";
import { messageFromError } from "./text";

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
        "xAI login succeeded, but the model catalog could not be refreshed; using the curated fallback.",
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

    async refreshToken(
      credentials: OAuthCredentials,
      signal?: AbortSignal,
    ): Promise<OAuthCredentials> {
      if (!credentials.refresh && credentials.expires && credentials.expires <= Date.now()) {
        throw new Error("xAI OAuth token is expired and cannot be refreshed. Please run /login xai-auth again.");
      }
      if (!credentials.refresh) return credentials;
      return refreshXaiCredentials(credentials, signal);
    },

    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },
  };
}
