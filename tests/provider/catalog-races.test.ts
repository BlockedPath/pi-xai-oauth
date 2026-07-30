import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../../extensions/xai-oauth";
import {
  CURATED_FALLBACK_MODELS,
  setXaiRuntimeModels,
} from "../../extensions/xai/models";
import { createExtensionHarness } from "../fixtures/extension-api";
import { createTempDir } from "../fixtures/temp";
import { discovery, OIDC_PUBLIC_JWK, signIdToken } from "../fixtures/oauth";
import { headerValue, jsonResponse } from "../fixtures/http";
import { TEST_MODEL } from "../fixtures/models";
let temp: Awaited<ReturnType<typeof createTempDir>>;
beforeEach(async () => {
  temp = await createTempDir("pi-xai-race-");
  vi.stubEnv("HOME", temp.path);
  const auth = join(temp.path, ".pi/agent/auth.json");
  await mkdir(join(auth, ".."), { recursive: true });
  await writeFile(
    auth,
    JSON.stringify({
      "xai-auth": {
        type: "oauth",
        access: "expired",
        refresh: "refresh",
        expires: 1,
        tokenEndpoint: "https://auth.x.ai/oauth2/token",
      },
    }),
  );
  const cache = join(temp.path, ".pi/agent/cache/pi-xai-oauth/models-v2.json");
  await mkdir(join(cache, ".."), { recursive: true });
  await writeFile(
    cache,
    JSON.stringify({
      schemaVersion: 1,
      fetchedAt: Date.now(),
      models: CURATED_FALLBACK_MODELS,
    }),
  );
});
afterEach(async () => {
  setXaiRuntimeModels(CURATED_FALLBACK_MODELS);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await temp.cleanup();
});
function installBaseFetch(
  catalogHandlers: Array<(init: RequestInit) => Promise<Response> | Response>,
  getAuthUrl: () => URL | undefined,
) {
  const bearers: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("openid-configuration"))
        return jsonResponse(discovery());
      if (url.endsWith("jwks.json"))
        return jsonResponse({ keys: [OIDC_PUBLIC_JWK] });
      if (url.endsWith("oauth2/token"))
        return jsonResponse({
          access_token: "login-access",
          refresh_token: "refresh",
          expires_in: 3600,
          id_token: signIdToken({
            nonce: getAuthUrl()?.searchParams.get("nonce") ?? "",
          }),
        });
      if (url.endsWith("models-v2")) {
        bearers.push(headerValue(init.headers, "Authorization") ?? "");
        const handler = catalogHandlers.shift();
        if (!handler) throw new Error("unexpected catalog request");
        return handler(init);
      }
      throw new Error(`unexpected origin ${new URL(url).origin}`);
    }),
  );
  return bearers;
}
async function login(
  provider: any,
  setUrl: (url: URL) => void,
  onProgress: (message: string) => void = () => {},
) {
  let manualCallback = "";
  return provider.oauth.login({
    onPrompt: async () => "n",
    onProgress,
    onAuth(auth: any) {
      const url = new URL(auth.url);
      setUrl(url);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "new-login");
      callback.searchParams.set("state", url.searchParams.get("state")!);
      manualCallback = callback.toString();
    },
    onManualCodeInput: async () => manualCallback,
  });
}

describe.sequential("catalog refresh ownership races", () => {
  it("prevents a late old-account refresh from overwriting a new login", async () => {
    let authUrl: URL | undefined;
    let releaseOld!: () => void;
    let markOldStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve;
    });
    const bearers = installBaseFetch(
      [
        async () => {
          markOldStarted();
          return new Promise<Response>((resolve) => {
            releaseOld = () =>
              resolve(
                jsonResponse({
                  data: [
                    {
                      model: "old-only",
                      api_backend: "responses",
                      context_window: 100_000,
                    },
                  ],
                }),
              );
          });
        },
        async () =>
          jsonResponse({
            data: [
              {
                model: "new-only",
                api_backend: "responses",
                context_window: 100_000,
              },
            ],
          }),
      ],
      () => authUrl,
    );
    const h = createExtensionHarness();
    await extension(h.api);
    const session = h.handlers.get("session_start")?.(
      {},
      {
        model: TEST_MODEL,
        modelRegistry: {
          find: (_p: string, id: string) => ({ ...TEST_MODEL, id }),
          getApiKeyAndHeaders: async () => ({
            ok: true,
            apiKey: "OLD_ACCOUNT",
          }),
        },
      },
    );
    await oldStarted;
    await login(h.providers.get("xai-auth"), (url) => {
      authUrl = url;
    });
    releaseOld();
    await session;
    expect(bearers).toEqual(["Bearer OLD_ACCOUNT", "Bearer login-access"]);
    expect(h.providers.get("xai-auth").models.map(({ id }: any) => id)).toEqual(
      ["new-only"],
    );
    const cache = JSON.parse(
      await readFile(
        join(temp.path, ".pi/agent/cache/pi-xai-oauth/models-v2.json"),
        "utf8",
      ),
    );
    expect(cache.models.map(({ id }: any) => id)).toEqual(["new-only"]);
  });
  it("prevents a deferred pre-login credential lookup from superseding login", async () => {
    let authUrl: URL | undefined;
    let resolveLookup!: (value: any) => void;
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const bearers = installBaseFetch(
      [
        async () =>
          jsonResponse({
            data: [
              {
                model: "login-priority",
                api_backend: "responses",
                context_window: 100_000,
              },
            ],
          }),
      ],
      () => authUrl,
    );
    const h = createExtensionHarness();
    await extension(h.api);
    const session = h.handlers.get("session_start")?.(
      {},
      {
        model: TEST_MODEL,
        modelRegistry: {
          find: (_p: string, id: string) => ({ ...TEST_MODEL, id }),
          getApiKeyAndHeaders: async () => {
            markLookupStarted();
            return new Promise((resolve) => {
              resolveLookup = resolve;
            });
          },
        },
      },
    );
    await lookupStarted;
    await login(h.providers.get("xai-auth"), (url) => {
      authUrl = url;
    });
    resolveLookup({ ok: true, apiKey: "PRE_LOGIN" });
    await session;
    expect(bearers).toEqual(["Bearer login-access"]);
    expect(h.providers.get("xai-auth").models.map(({ id }: any) => id)).toEqual(
      ["login-priority"],
    );
  });
  it("keeps the applied remote catalog when the progress callback throws", async () => {
    let authUrl: URL | undefined;
    installBaseFetch(
      [
        async () =>
          jsonResponse({
            data: [
              {
                model: "entitled-only",
                api_backend: "responses",
                context_window: 100_000,
              },
            ],
          }),
      ],
      () => authUrl,
    );
    const h = createExtensionHarness();
    await extension(h.api);

    // A host UI failure is cosmetic: it must not roll the validated remote
    // entitlement snapshot back to the curated fallback. Only the catalog
    // notice throws; earlier login-flow progress must still work.
    const notices: string[] = [];
    await login(
      h.providers.get("xai-auth"),
      (url) => {
        authUrl = url;
      },
      (message) => {
        notices.push(message);
        if (/OAuth-visible|curated fallback/.test(message)) {
          throw new Error("ui notification failed");
        }
      },
    );

    expect(notices.at(-1)).toMatch(/Refreshed 1 OAuth-visible xAI model\./);

    expect(h.providers.get("xai-auth").models.map(({ id }: any) => id)).toEqual(
      ["entitled-only"],
    );
    const cache = JSON.parse(
      await readFile(
        join(temp.path, ".pi/agent/cache/pi-xai-oauth/models-v2.json"),
        "utf8",
      ),
    );
    expect(cache.models.map(({ id }: any) => id)).toEqual(["entitled-only"]);
  });
});
