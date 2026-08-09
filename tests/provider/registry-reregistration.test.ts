import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolvePiManagedXaiCredential,
  resolveRegistryRequestAuth,
} from "../../extensions/xai/auth";
import {
  CURATED_FALLBACK_MODELS,
  setXaiRuntimeModels,
} from "../../extensions/xai/models";
import { TEST_MODEL } from "../fixtures/models";
import { createTempDir } from "../fixtures/temp";

let temp: Awaited<ReturnType<typeof createTempDir>>;

const staleProviderConfig = {
  name: "xAI stale catalog",
  baseUrl: "https://example.invalid/stale/v1",
  api: "openai-responses",
  authHeader: true,
  models: [
    {
      id: "stale-bundled-model",
      name: "Stale bundled model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_000,
      maxTokens: 100,
    },
  ],
};

const refreshedProviderConfig = {
  name: "xAI refreshed catalog",
  baseUrl: "https://cli-chat-proxy.grok.com/v1",
  api: "openai-responses",
  authHeader: true,
  models: [
    {
      id: "grok-4.5",
      name: "Grok 4.5",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 500_000,
      maxTokens: 64_000,
    },
    {
      id: "new-entitled",
      name: "New entitled",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_000,
    },
  ],
};

const baselineModelConfig = {
  id: "baseline-model",
  name: "Baseline model",
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
};

function codingAgentApi(): any {
  return PiCodingAgent as any;
}

function hasModelRuntime(): boolean {
  return typeof codingAgentApi().ModelRuntime === "function";
}

/**
 * Mirror Pi 0.81.0 remoteModels(): discard a persisted store entry when the
 * local catalog is newer than the store's lastModified watermark.
 */
function modelsFromStoreIfNewerThanLocal(
  stored: { models?: any[]; lastModified?: number } | undefined,
  localLastModified: number,
): any[] | undefined {
  if (!stored?.models?.length) return undefined;
  if (
    stored.lastModified === undefined
    || stored.lastModified <= localLastModified
  ) {
    return undefined;
  }
  return stored.models;
}

beforeEach(async () => {
  temp = await createTempDir("pi-xai-registry-");
  vi.stubEnv("HOME", temp.path);
});

afterEach(async () => {
  setXaiRuntimeModels(CURATED_FALLBACK_MODELS);
  vi.unstubAllEnvs();
  await temp.cleanup();
});

describe("ModelRegistry re-registration precedence", () => {
  it("replaces a stale registered catalog when models are re-registered", async () => {
    if (!hasModelRuntime()) {
      // Minimum matrix (0.80.1) still uses the older registry surface.
      expect(true).toBe(true);
      return;
    }

    const codingAgent = codingAgentApi();
    const runtime = await codingAgent.ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
    });
    const registry = new codingAgent.ModelRegistry(runtime);

    registry.registerProvider("xai-auth", staleProviderConfig);
    await runtime.refresh({ allowNetwork: false });
    expect(registry.find("xai-auth", "stale-bundled-model")).toBeDefined();
    expect(registry.find("xai-auth", "grok-4.5")).toBeUndefined();

    // Extension catalog refresh unregisters then re-registers with the new
    // exact entitlement set so stale models cannot outlive a successful refresh.
    registry.unregisterProvider("xai-auth");
    registry.registerProvider("xai-auth", refreshedProviderConfig);
    await runtime.refresh({ allowNetwork: false });

    expect(registry.find("xai-auth", "stale-bundled-model")).toBeUndefined();
    expect(registry.find("xai-auth", "grok-4.5")).toMatchObject({
      id: "grok-4.5",
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      contextWindow: 500_000,
    });
    expect(registry.find("xai-auth", "new-entitled")).toBeDefined();

    const ids = registry
      .getAll()
      .filter((model: { provider: string }) => model.provider === "xai-auth")
      .map((model: { id: string }) => model.id)
      .sort();
    expect(ids).toEqual(["grok-4.5", "new-entitled"]);
  });

  it("discards a stale models-store.json overlay when the local catalog is newer", async () => {
    if (!hasModelRuntime()) {
      expect(true).toBe(true);
      return;
    }

    const codingAgent = codingAgentApi();
    const agentDir = join(temp.path, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    const modelsPath = join(agentDir, "models.json");
    const modelsStorePath = join(agentDir, "models-store.json");
    await writeFile(modelsPath, JSON.stringify({ providers: {} }));

    // Store watermark is older than the local catalog mtime used below.
    await writeFile(
      modelsStorePath,
      JSON.stringify({
        "xai-auth": {
          models: [
            {
              id: "stale-from-store",
              name: "Stale from store",
              provider: "xai-auth",
              api: "openai-responses",
              baseUrl: "https://example.invalid/stale-store",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1_000,
              maxTokens: 100,
            },
          ],
          checkedAt: Date.now() - 10_000,
          lastModified: 1,
        },
      }),
    );

    let storedCredential: any = {
      type: "oauth",
      access: "store-oauth-access",
      refresh: "refresh",
      expires: Date.now() + 60_000,
    };
    const credentialStore = {
      async read(providerId: string) {
        return providerId === "xai-auth" ? storedCredential : undefined;
      },
      async list() {
        return storedCredential
          ? [{ providerId: "xai-auth", type: storedCredential.type }]
          : [];
      },
      async modify(_providerId: string, update: (current: any) => Promise<any>) {
        const next = await update(storedCredential);
        if (next !== undefined) storedCredential = next;
        return storedCredential;
      },
      async delete() {
        storedCredential = undefined;
      },
    };

    const runtime = await codingAgent.ModelRuntime.create({
      credentials: credentialStore,
      modelsPath,
      modelsStorePath,
      allowModelNetwork: true,
    });
    const registry = new codingAgent.ModelRegistry(runtime);

    // Local catalog is newer than store lastModified:1, so remoteModels-style
    // policy must discard the persisted overlay and keep the local baseline.
    const localCatalogModifiedAt = Date.now();
    let refreshCalls = 0;
    let sawStaleStore = false;

    registry.registerProvider("xai-auth", {
      name: "xAI store precedence",
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      api: "openai-responses",
      authHeader: true,
      oauth: {
        name: "xAI store precedence",
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
      models: [{ ...baselineModelConfig, id: "placeholder-model" }],
      async refreshModels(context: {
        store?: { read: () => Promise<any> };
        stored?: any;
        allowNetwork?: boolean;
      }) {
        refreshCalls += 1;
        const stored = context.stored ?? await context.store?.read();
        if (stored?.models?.some((model: { id: string }) => model.id === "stale-from-store")) {
          sawStaleStore = true;
        }
        const fromStore = modelsFromStoreIfNewerThanLocal(stored, localCatalogModifiedAt);
        if (fromStore) {
          return fromStore.map((model) => ({
            id: model.id,
            name: model.name ?? model.id,
            reasoning: !!model.reasoning,
            input: model.input ?? ["text"],
            cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: model.contextWindow ?? 1_000,
            maxTokens: model.maxTokens ?? 100,
          }));
        }
        return [baselineModelConfig];
      },
    });

    await vi.waitFor(() => {
      expect(refreshCalls).toBeGreaterThan(0);
      expect(sawStaleStore).toBe(true);
      expect(registry.find("xai-auth", "stale-from-store")).toBeUndefined();
      expect(registry.find("xai-auth", "placeholder-model")).toBeUndefined();
      expect(registry.find("xai-auth", "baseline-model")).toMatchObject({
        id: "baseline-model",
      });
    });
    expect(
      runtime
        .getModels("xai-auth")
        .map((model: { id: string }) => model.id),
    ).toEqual(["baseline-model"]);
  });

  it("prefers ModelRuntime.getAuth over the legacy getApiKeyAndHeaders projection", async () => {
    if (!hasModelRuntime()) {
      expect(true).toBe(true);
      return;
    }

    const codingAgent = codingAgentApi();
    let stored: any = {
      type: "oauth",
      access: "registry-oauth-access",
      refresh: "refresh",
      expires: Date.now() + 60_000,
    };
    const credentialStore = {
      async read(providerId: string) {
        return providerId === "xai-auth" ? stored : undefined;
      },
      async list() {
        return stored ? [{ providerId: "xai-auth", type: stored.type }] : [];
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
    registry.registerProvider("xai-auth", {
      ...refreshedProviderConfig,
      oauth: {
        name: "xAI registry auth",
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
    });
    await runtime.refresh({ allowNetwork: false });

    const model = registry.find("xai-auth", "grok-4.5");
    expect(model).toBeDefined();

    const getApiKeyAndHeaders = vi.spyOn(registry, "getApiKeyAndHeaders");
    const getAuth = vi.spyOn(runtime, "getAuth");

    const auth = await resolveRegistryRequestAuth(registry, model, runtime);
    expect(auth).toMatchObject({
      ok: true,
      apiKey: "registry-oauth-access",
    });
    expect(getAuth).toHaveBeenCalled();
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();

    await expect(
      resolvePiManagedXaiCredential({
        model: { ...TEST_MODEL, id: "grok-4.5" },
        modelRegistry: registry,
        modelRuntime: runtime,
      }),
    ).resolves.toEqual({
      kind: "oauth-session",
      token: "registry-oauth-access",
    });
  });

  it("falls back to provider-scoped getProviderAuth when model auth is unavailable", async () => {
    const auth = await resolveRegistryRequestAuth({
      getProviderAuth: async () => ({
        auth: {
          apiKey: "provider-scoped-token",
          headers: { Authorization: "Bearer provider-scoped-token" },
        },
        source: "stored OAuth",
      }),
    });
    expect(auth).toEqual({
      ok: true,
      apiKey: "provider-scoped-token",
      headers: { Authorization: "Bearer provider-scoped-token" },
    });
  });
});
