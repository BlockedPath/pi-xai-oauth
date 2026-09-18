import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../../extensions/xai-oauth";
import {
  CURATED_FALLBACK_MODELS,
  getXaiRuntimeModel,
  setXaiRuntimeModels,
  XaiModelInputProvenance,
} from "../../extensions/xai/models";
import { createExtensionHarness } from "../fixtures/extension-api";
import { createTempDir } from "../fixtures/temp";
import { discovery, OIDC_PUBLIC_JWK, signIdToken } from "../fixtures/oauth";
import { jsonResponse } from "../fixtures/http";
let temp: Awaited<ReturnType<typeof createTempDir>>;
beforeEach(async () => {
  temp = await createTempDir("pi-xai-lifecycle-");
  vi.stubEnv("HOME", temp.path);
});
afterEach(async () => {
  setXaiRuntimeModels(CURATED_FALLBACK_MODELS);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await temp.cleanup();
});

async function loadAndLogin(catalog: any) {
  const h = createExtensionHarness();
  let authUrl: URL | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
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
            nonce: authUrl?.searchParams.get("nonce") ?? "",
          }),
        });
      if (url.endsWith("models-v2")) return jsonResponse(catalog);
      throw new Error(`Unexpected request origin ${URL.parse(url)?.origin ?? "invalid URL"}`);
    }),
  );
  await extension(h.api);
  const provider = h.providers.get("xai-auth");
  let manualCallback = "";
  const credentials = await provider.oauth.login({
    onPrompt: async () => "n",
    onProgress: () => {},
    onSelect: async () => "browser",
    onDeviceCode: () => {},
    onAuth(auth: any) {
      const parsedAuthUrl = URL.parse(auth.url);
      const redirectUri = parsedAuthUrl?.searchParams.get("redirect_uri");
      const callback = redirectUri ? URL.parse(redirectUri) : null;
      const state = parsedAuthUrl?.searchParams.get("state");
      if (!parsedAuthUrl || !callback || !state) throw new Error("Invalid test authorization URL");
      authUrl = parsedAuthUrl;
      callback.searchParams.set("code", "login-code");
      callback.searchParams.set("state", state);
      manualCallback = callback.toString();
    },
    onManualCodeInput: async () => manualCallback,
  });
  return { h, credentials };
}

describe("authenticated provider catalog lifecycle", { concurrent: false }, () => {
  it("immediately replaces fallback models after login", async () => {
    const { h, credentials } = await loadAndLogin({
      data: [
        {
          model: "grok-4.5",
          api_backend: "responses",
          context_window: 500_000,
        },
        {
          model: "new-entitled",
          api_backend: "responses",
          context_window: 100_000,
        },
      ],
    });
    expect(credentials.access).toBe("login-access");
    expect(h.providers.get("xai-auth").models.map(({ id }: any) => id)).toEqual([
      "grok-4.5",
      "new-entitled",
      // Known aliases and proven OAuth routes of entitled grok-4.5 only — not invented families.
      "grok-4.3",
      "grok-4.5-latest",
      "grok-build-latest",
      "grok-composer-2.5-fast",
    ]);
  });
  it("advertises authenticated modalities without exposing internal provenance", async () => {
    const { h } = await loadAndLogin({
      data: [
        {
          model: "grok-4.5",
          api_backend: "responses",
          context_window: 500_000,
          acceptsImages: false,
        },
      ],
    });
    const providerModel = h.providers.get("xai-auth").models[0];
    expect(providerModel.input).toEqual(["text"]);
    expect(providerModel).not.toHaveProperty("inputProvenance");
    expect(getXaiRuntimeModel("grok-4.5")).toMatchObject({
      input: ["text"],
      inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
    });
  });
  it("treats an authenticated empty catalog as exact and blocks an unreplaced prompt", async () => {
    const { h } = await loadAndLogin({ data: [] });
    expect(h.providers.get("xai-auth").models).toEqual([]);
    const notices: any[] = [];
    const result = await h.handlers.get("input")?.(
      {},
      {
        model: { provider: "xai-auth", id: "grok-4.5" },
        modelRegistry: { find: () => undefined },
        ui: {
          notify: (message: string, type: string) =>
            notices.push({ message, type }),
        },
      },
    );
    expect(result).toEqual({ action: "handled" });
    expect(notices.at(-1).message).toMatch(/no entitled xAI replacement/);
  });
  it("switches a removed active model before prompt execution", async () => {
    const { h } = await loadAndLogin({
      data: [
        {
          model: "grok-4.5",
          api_backend: "responses",
          context_window: 500_000,
        },
      ],
    });
    const result = await h.handlers.get("input")?.(
      {},
      {
        model: { provider: "xai-auth", id: "removed" },
        modelRegistry: {
          find: (_provider: string, id: string) =>
            id === "grok-4.5" ? { provider: "xai-auth", id } : undefined,
        },
        ui: { notify() {} },
      },
    );
    expect(result).toEqual({ action: "continue" });
    expect(h.selectedModels.at(-1)?.id).toBe("grok-4.5");
  });
});
