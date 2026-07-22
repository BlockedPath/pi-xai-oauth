import { access, mkdir, writeFile } from "node:fs/promises";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGrokAuthCredentials,
  getStartupXaiCatalogAuth,
  hasPiManagedXaiOAuth,
  resolveXaiCredential,
  resolvePiManagedXaiCredential,
  resolvePiManagedXaiOAuthCredential,
} from "../../extensions/xai/auth";
import {
  CURATED_FALLBACK_MODELS,
  setXaiRuntimeModels,
} from "../../extensions/xai/models";
import { createTempDir } from "../fixtures/temp";
import { BUILTIN_XAI_TEST_MODEL, TEST_MODEL } from "../fixtures/models";
let temp: Awaited<ReturnType<typeof createTempDir>>;

const boundaryProviderConfig = {
  name: "xAI boundary fixture",
  baseUrl: "https://example.invalid/v1",
  api: "openai-responses",
  authHeader: true,
  oauth: {
    name: "xAI boundary fixture",
    async login() {
      throw new Error("not used");
    },
    async refreshToken(credentials: any) {
      return credentials;
    },
    getApiKey(credentials: any) {
      return credentials.access;
    },
  },
  models: [{
    id: TEST_MODEL.id,
    name: TEST_MODEL.name,
    api: "openai-responses",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  }],
};

async function realBoundaryRegistry(initialCredential: any) {
  const codingAgent = PiCodingAgent as any;
  if (codingAgent.ModelRuntime) {
    let stored = initialCredential;
    const credentialStore = {
      async read(providerId: string) {
        return providerId === "xai-auth" ? stored : undefined;
      },
      async list() {
        return stored
          ? [{ providerId: "xai-auth", type: stored.type }]
          : [];
      },
      async modify(_providerId: string, update: (current: any) => Promise<any>) {
        const next = await update(stored);
        if (next !== undefined) stored = next;
        return stored;
      },
      async delete() {
        stored = undefined;
      },
    };
    const runtime = await codingAgent.ModelRuntime.create({
      credentials: credentialStore,
      modelsPath: null,
      allowModelNetwork: false,
    });
    const registry = new codingAgent.ModelRegistry(runtime);
    registry.registerProvider("xai-auth", boundaryProviderConfig);
    await runtime.refresh({ allowNetwork: false });
    return {
      registry,
      setRuntimeApiKey: (key: string) => runtime.setRuntimeApiKey("xai-auth", key),
    };
  }

  const authStorage = codingAgent.AuthStorage.inMemory({
    "xai-auth": initialCredential,
  });
  const registry = codingAgent.ModelRegistry.inMemory(authStorage);
  registry.registerProvider("xai-auth", boundaryProviderConfig);
  return {
    registry,
    async setRuntimeApiKey(key: string) {
      authStorage.setRuntimeApiKey("xai-auth", key);
    },
  };
}

beforeEach(async () => {
  temp = await createTempDir("pi-xai-auth-");
  vi.stubEnv("HOME", temp.path);
});
afterEach(async () => {
  setXaiRuntimeModels(CURATED_FALLBACK_MODELS);
  vi.unstubAllEnvs();
  await temp.cleanup();
});

describe("credential resolution", () => {
  it("does not create Pi auth storage during an absent startup read", async () => {
    expect(getStartupXaiCatalogAuth()).toMatchObject({
      credential: null,
      needsRegistryRefresh: false,
    });
    await expect(access(join(temp.path, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("reads official Grok CLI credentials without modifying them", async () => {
    const path = join(temp.path, ".grok/auth.json");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
          key: "grok-access",
          refresh_token: "grok-refresh",
          expires_at: Date.now() + 3600_000,
        },
      }),
    );
    expect(getGrokAuthCredentials()).toMatchObject({
      access: "grok-access",
      refresh: "grok-refresh",
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    });
  });
  it("prefers fresh Grok auth while retaining deferred expired Pi refresh intent", async () => {
    const pi = join(temp.path, ".pi/agent/auth.json");
    await mkdir(join(pi, ".."), { recursive: true });
    await writeFile(
      pi,
      JSON.stringify({
        "xai-auth": {
          type: "oauth",
          access: "expired",
          refresh: "pi-refresh",
          expires: 1,
        },
      }),
    );
    const grok = join(temp.path, ".grok/auth.json");
    await mkdir(join(grok, ".."), { recursive: true });
    await writeFile(
      grok,
      JSON.stringify({
        "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
          key: "fresh-grok-access",
          refresh_token: "refresh",
          expires_at: Date.now() + 3600_000,
        },
      }),
    );
    expect(getStartupXaiCatalogAuth()).toMatchObject({
      credential: { access: "fresh-grok-access" },
      needsRegistryRefresh: true,
    });
  });
  it("uses the active entitled model when the fallback model is absent", async () => {
    const model = { ...TEST_MODEL, id: "grok-composer-2.5-fast" } as any;
    setXaiRuntimeModels([{ ...CURATED_FALLBACK_MODELS[0], id: model.id }]);
    const credential = await resolveXaiCredential({
      model,
      modelRegistry: {
        find: (_provider: string, id: string) =>
          id === model.id ? model : undefined,
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: "composer-only-token",
        }),
      },
    });
    expect(credential).toEqual({
      kind: "oauth-session",
      token: "composer-only-token",
    });
  });
  it("prefers active built-in OAuth and preserves OAuth-session provenance", async () => {
    const stored = {
      type: "oauth",
      access: "builtin-oauth",
      refresh: "refresh",
      expires: Date.now() + 60_000,
    };
    const lookups: string[] = [];
    const ctx = {
      model: BUILTIN_XAI_TEST_MODEL,
      modelRegistry: {
        authStorage: {
          get: (provider: string) => provider === "xai" ? stored : { ...stored, access: "package-oauth" },
        },
        find: (provider: string, id: string) => {
          lookups.push(provider);
          return { ...BUILTIN_XAI_TEST_MODEL, provider, id };
        },
        isUsingOAuth: () => true,
        getApiKeyAndHeaders: async (model: any) => ({
          ok: true,
          apiKey: model.provider === "xai" ? "builtin-oauth" : "package-oauth",
        }),
      },
    };

    await expect(resolvePiManagedXaiCredential(ctx)).resolves.toEqual({
      catalogScope: "host",
      kind: "oauth-session",
      token: "builtin-oauth",
    });
    expect(lookups[0]).toBe("xai");
    await expect(resolvePiManagedXaiOAuthCredential(ctx)).resolves.toEqual({
      kind: "oauth-session",
      token: "builtin-oauth",
    });
  });
  it("tags an active built-in API key for public API routing and rejects it for usage", async () => {
    const getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true,
      apiKey: "BUILTIN_API_KEY",
    }));
    const ctx = {
      model: BUILTIN_XAI_TEST_MODEL,
      modelRegistry: {
        authStorage: {
          get: (provider: string) => provider === "xai"
            ? { type: "api_key", key: "BUILTIN_API_KEY" }
            : { type: "oauth", access: "package-oauth" },
        },
        find: (provider: string, id: string) => ({ ...BUILTIN_XAI_TEST_MODEL, provider, id }),
        isUsingOAuth: (model: any) => model.provider === "xai-auth",
        getApiKeyAndHeaders,
      },
    };

    await expect(resolvePiManagedXaiCredential(ctx)).resolves.toEqual({
      kind: "api-key",
      token: "BUILTIN_API_KEY",
    });
    await expect(resolvePiManagedXaiOAuthCredential(ctx)).resolves.toBeNull();
    expect(getApiKeyAndHeaders).toHaveBeenCalledTimes(1);
  });
  it("does not reuse sibling-provider credentials when the active provider has none", async () => {
    const lookups: string[] = [];
    const builtinCtx = {
      model: BUILTIN_XAI_TEST_MODEL,
      modelRegistry: {
        authStorage: {
          get: (provider: string) => provider === "xai-auth"
            ? {
                type: "oauth",
                access: "package-oauth",
                refresh: "refresh",
                expires: Date.now() + 60_000,
              }
            : undefined,
        },
        find: (provider: string, id: string) => {
          lookups.push(provider);
          // Both providers can resolve models; only xai-auth has usable auth.
          return { ...(provider === "xai" ? BUILTIN_XAI_TEST_MODEL : TEST_MODEL), provider, id };
        },
        isUsingOAuth: (model: any) => model.provider === "xai-auth",
        getApiKeyAndHeaders: async (model: any) => model.provider === "xai-auth"
          ? { ok: true, apiKey: "package-oauth" }
          : { ok: false, error: "missing" },
      },
    };

    await expect(resolvePiManagedXaiCredential(builtinCtx)).resolves.toBeNull();
    await expect(resolvePiManagedXaiOAuthCredential(builtinCtx)).resolves.toBeNull();
    expect(hasPiManagedXaiOAuth(builtinCtx)).toBe(false);
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((provider) => provider === "xai")).toBe(true);

    lookups.length = 0;
    const packageCtx = {
      model: TEST_MODEL,
      modelRegistry: {
        authStorage: {
          get: (provider: string) => provider === "xai"
            ? { type: "api_key", key: "BUILTIN_API_KEY" }
            : undefined,
        },
        find: (provider: string, id: string) => {
          lookups.push(provider);
          return { ...(provider === "xai" ? BUILTIN_XAI_TEST_MODEL : TEST_MODEL), provider, id };
        },
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: async (model: any) => model.provider === "xai"
          ? { ok: true, apiKey: "BUILTIN_API_KEY" }
          : { ok: false, error: "missing" },
      },
    };

    await expect(resolvePiManagedXaiCredential(packageCtx)).resolves.toBeNull();
    await expect(resolvePiManagedXaiOAuthCredential(packageCtx)).resolves.toBeNull();
    expect(hasPiManagedXaiOAuth(packageCtx)).toBe(false);
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((provider) => provider === "xai-auth")).toBe(true);
  });
  it("uses Authorization bearer when registry omits apiKey", async () => {
    const credential = await resolveXaiCredential({
      model: TEST_MODEL,
      modelRegistry: {
        find: () => TEST_MODEL,
        getApiKeyAndHeaders: async () => ({
          ok: true,
          headers: { Authorization: "Bearer header-token" },
        }),
      },
    });
    expect(credential).toEqual({
      kind: "oauth-session",
      token: "header-token",
    });
  });
  it("accepts only a bearer that matches Pi's current stored OAuth credential", async () => {
    let stored = {
      type: "oauth",
      access: "expired-access",
      refresh: "refresh",
      expires: 1,
    };
    const credential = await resolvePiManagedXaiOAuthCredential({
      model: TEST_MODEL,
      modelRegistry: {
        authStorage: {
          get: () => stored,
        },
        find: () => TEST_MODEL,
        isUsingOAuth: () => true,
        getApiKeyAndHeaders: async () => {
          stored = { ...stored, access: "refreshed-access", expires: Date.now() + 60_000 };
          return { ok: true, apiKey: "refreshed-access" };
        },
      },
    });
    expect(credential).toEqual({
      kind: "oauth-session",
      token: "refreshed-access",
    });
  });
  it("rejects stored and runtime API-key provenance for the usage surface", async () => {
    const getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true,
      apiKey: "RUNTIME_API_KEY",
    }));
    const storedApiKey = await resolvePiManagedXaiOAuthCredential({
      model: TEST_MODEL,
      modelRegistry: {
        authStorage: {
          get: () => ({ type: "api_key", key: "STORED_API_KEY" }),
        },
        find: () => TEST_MODEL,
        isUsingOAuth: () => false,
        getApiKeyAndHeaders,
      },
    });
    expect(storedApiKey).toBeNull();
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();

    const runtimeOverride = await resolvePiManagedXaiOAuthCredential({
      model: TEST_MODEL,
      modelRegistry: {
        authStorage: {
          get: (provider: string) => provider === "xai-auth"
            ? {
                type: "oauth",
                access: "stored-oauth-access",
                refresh: "refresh",
                expires: Date.now() + 60_000,
              }
            : undefined,
        },
        find: (provider: string) => provider === "xai-auth" ? TEST_MODEL : undefined,
        isUsingOAuth: () => true,
        getApiKeyAndHeaders,
      },
    });
    expect(runtimeOverride).toBeNull();
    expect(getApiKeyAndHeaders).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["runtime override", { configured: true, source: "runtime" }],
    ["stored OAuth removal", { configured: false }],
  ])("rejects a modern-registry %s introduced during resolution", async (_label, afterStatus) => {
    let usingOAuth = true;
    let status: any = { configured: true, source: "stored" };
    const credential = await resolvePiManagedXaiOAuthCredential({
      model: TEST_MODEL,
      modelRegistry: {
        find: () => TEST_MODEL,
        isUsingOAuth: () => usingOAuth,
        getProviderAuthStatus: () => status,
        getApiKeyAndHeaders: async () => {
          usingOAuth = false;
          status = afterStatus;
          return { ok: true, apiKey: "STALE_OR_OVERRIDDEN_TOKEN" };
        },
      },
    });
    expect(credential).toBeNull();
  });
  it("does not use a Grok auth file when Pi has no stored OAuth credential", async () => {
    const path = join(temp.path, ".grok/auth.json");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
          key: "grok-file-access",
          refresh_token: "grok-file-refresh",
          expires_at: Date.now() + 3600_000,
        },
      }),
    );
    await expect(resolvePiManagedXaiOAuthCredential({
      model: TEST_MODEL,
      modelRegistry: {
        authStorage: { get: () => undefined },
        find: () => TEST_MODEL,
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: vi.fn(),
      },
    })).resolves.toBeNull();
  });
  it("uses the real exact-boundary registry facade and rejects its runtime override", async () => {
    const boundary = await realBoundaryRegistry({
      type: "oauth",
      access: "boundary-oauth-access",
      refresh: "boundary-refresh",
      expires: Date.now() + 60_000,
    });
    const ctx = {
      model: TEST_MODEL,
      modelRegistry: boundary.registry,
    };

    await expect(resolvePiManagedXaiOAuthCredential(ctx)).resolves.toEqual({
      kind: "oauth-session",
      token: "boundary-oauth-access",
    });

    await boundary.setRuntimeApiKey("BOUNDARY_RUNTIME_API_KEY");
    await expect(resolvePiManagedXaiOAuthCredential(ctx)).resolves.toBeNull();
  });
  it("rejects a stored API key through the real exact-boundary registry facade", async () => {
    const boundary = await realBoundaryRegistry({
      type: "api_key",
      key: "BOUNDARY_STORED_API_KEY",
    });
    await expect(resolvePiManagedXaiOAuthCredential({
      model: TEST_MODEL,
      modelRegistry: boundary.registry,
    })).resolves.toBeNull();
  });
});
