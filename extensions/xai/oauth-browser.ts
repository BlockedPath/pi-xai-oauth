import { createHash, randomBytes } from "crypto";
import { createServer, type Server } from "http";
import {
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_REDIRECT_HOST,
  XAI_OAUTH_REDIRECT_PATH,
  XAI_OAUTH_REDIRECT_PORT,
  XAI_OAUTH_SCOPE,
} from "./constants";
import type { XaiOidcDiscovery } from "./oidc";

/** Authorization callback fields received over HTTP or pasted by the user. */
export type CallbackResult = {
  code?: string;
  state?: string;
  error?: string;
};

type ManualCallbackInput =
  | { kind: "callback"; result: CallbackResult }
  | { kind: "raw-code" }
  | { kind: "invalid" };

/** Create a PKCE S256 verifier/challenge pair. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function callbackCorsOrigin(origin: string | undefined): string | undefined {
  return origin === "https://accounts.x.ai" || origin === "https://auth.x.ai" ? origin : undefined;
}

/** Start the local loopback callback server that accepts only the expected OAuth state. */
export async function startCallbackServer(expectedState: string): Promise<{
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

/** Build the xAI authorization URL for a browser PKCE login. */
export function buildAuthorizeUrl(
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

/** Classify pasted browser-login input as a callback, a rejected raw code, or invalid. */
export function parseCallbackInput(input: string): ManualCallbackInput {
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
