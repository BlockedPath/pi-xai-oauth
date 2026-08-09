import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { XAI_OAUTH_DEVICE_URL } from "../../extensions/xai/constants";
import {
  createXaiOAuth,
  XAI_DEVICE_LOGIN_METHOD,
} from "../../extensions/xai/oauth";
import {
  devicePayload,
  jsonResponse,
  makeClock,
  tokenPayload,
} from "../fixtures/device";
import { createTempDir } from "../fixtures/temp";

function oauthWithClock() {
  const clock = makeClock();
  return createXaiOAuth({
    getExistingCredentials: () => null,
    deviceAuth: {
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: async (url) =>
        String(url) === XAI_OAUTH_DEVICE_URL
          ? jsonResponse(devicePayload({ interval: 1 }))
          : jsonResponse(tokenPayload()),
    },
  });
}

function providerConfig() {
  return {
    name: "xAI integration test",
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
    api: "xai-responses",
    models: [
      {
        id: "grok-integration-test",
        name: "Grok integration test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000,
        maxTokens: 100,
      },
    ],
    oauth: oauthWithClock(),
  };
}

function runtimeInteraction(callbacks: OAuthLoginCallbacks) {
  return {
    signal: callbacks.signal,
    async prompt(prompt: any): Promise<string> {
      if (prompt.type === "select") {
        return (await callbacks.onSelect?.({ message: prompt.message, options: prompt.options })) ?? "";
      }
      if (prompt.type === "manual_code") {
        return (await callbacks.onManualCodeInput?.()) ?? "";
      }
      return callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
    },
    notify(event: any): void {
      if (event.type === "auth_url") {
        callbacks.onAuth?.({ url: event.url, instructions: event.instructions });
      } else if (event.type === "device_code") {
        callbacks.onDeviceCode({
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          intervalSeconds: event.intervalSeconds,
          expiresInSeconds: event.expiresInSeconds,
        });
      } else if (event.type === "progress") {
        callbacks.onProgress?.(event.message);
      }
    },
  };
}

/**
 * Keep Pi's real credential runtime hermetic for this suite.
 *
 * `ModelRuntime.create` sets `modelNetworkEnabled = process.env.PI_OFFLINE === undefined`,
 * and `ModelRuntime.login()` finishes by awaiting `refresh({ allowNetwork: modelNetworkEnabled })`
 * with no signal and no timeout. Left unset, a *successful* login therefore fans out real,
 * unbounded catalog requests for every builtin provider (observed: `https://pi.dev/api/models/...`),
 * which hangs the test whenever the network is slow or unreachable. `PI_OFFLINE` keeps that
 * post-login refresh offline, and the fetch stub guarantees no request can escape the suite.
 */
beforeEach(() => {
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    throw new Error(`Unexpected network request in an isolated test: ${String((input as Request)?.url ?? input)}`);
  });
});

async function createPiAuthHarness(id: string, initial?: any) {
  const codingAgent = (await import("@earendil-works/pi-coding-agent")) as any;
  const piAi = (await import("@earendil-works/pi-ai")) as any;

  if (typeof codingAgent.ModelRuntime === "function" && typeof piAi.InMemoryCredentialStore === "function") {
    const credentials = new piAi.InMemoryCredentialStore();
    if (initial) await credentials.modify(id, async () => initial);
    const runtime = await codingAgent.ModelRuntime.create({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
    });
    runtime.registerProvider(id, providerConfig());
    return {
      login: (callbacks: OAuthLoginCallbacks) => runtime.login(id, "oauth", runtimeInteraction(callbacks)),
      read: () => credentials.read(id),
    };
  }

  const oauth = oauthWithClock();
  const storage = codingAgent.AuthStorage.inMemory(initial ? { [id]: initial } : {});
  return {
    login: async (callbacks: OAuthLoginCallbacks) => {
      const credentials = await oauth.login(callbacks);
      storage.set(id, { ...credentials, type: "oauth" });
    },
    read: async () => storage.get(id),
  };
}

describe("Pi credential-runtime device integration", () => {
  it("preserves existing credentials when login is cancelled", async () => {
    const id = `xai-cancel-${crypto.randomUUID()}`;
    const harness = await createPiAuthHarness(id, {
      type: "oauth",
      access: "existing-access",
      refresh: "existing-refresh",
      expires: Date.now() + 60_000,
    });
    const controller = new AbortController();
    let resolved = false;
    const cancellation = await harness.login({
      onPrompt: async () => "n",
      onAuth: () => {},
      onSelect: async () => XAI_DEVICE_LOGIN_METHOD,
      onDeviceCode: () => controller.abort(),
      signal: controller.signal,
    } as any).then(
      () => {
        resolved = true;
        return undefined;
      },
      (error: unknown) => error,
    );
    expect(resolved).toBe(false);
    expect(cancellation).toBeInstanceOf(Error);
    expect((cancellation as Error).message).toMatch(/Login cancelled|operation was aborted/i);
    await expect(harness.read()).resolves.toMatchObject({
      access: "existing-access",
      refresh: "existing-refresh",
    });
  });

  it("persists a completed device login", async () => {
    const id = `xai-success-${crypto.randomUUID()}`;
    const harness = await createPiAuthHarness(id);
    await harness.login({
      onPrompt: async () => "n",
      onAuth: () => {},
      onSelect: async () => XAI_DEVICE_LOGIN_METHOD,
      onDeviceCode: () => {},
    } as any);
    await expect(harness.read()).resolves.toMatchObject({
      access: "device-access-token",
      refresh: "device-refresh-token",
    });
  });

  it("persists rotated credentials before preparing an authenticated request", async () => {
    const codingAgent = (await import("@earendil-works/pi-coding-agent")) as any;
    const temp = await createTempDir("pi-xai-refresh-store-");
    const id = `xai-refresh-${crypto.randomUUID()}`;
    const authPath = join(temp.path, "agent", "auth.json");
    try {
      await mkdir(join(authPath, ".."), { recursive: true });
      await writeFile(authPath, JSON.stringify({
        [id]: {
          type: "oauth",
          access: "expired-access",
          refresh: "original-refresh",
          expires: 1,
          tokenEndpoint: "https://auth.x.ai/oauth2/token",
        },
      }));
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(tokenPayload({
        access_token: "refreshed-access",
        refresh_token: "rotated-refresh",
      }))));

      let requestAccess: string | undefined;
      if (typeof codingAgent.ModelRuntime === "function") {
        const runtime = await codingAgent.ModelRuntime.create({
          authPath,
          modelsPath: null,
          allowModelNetwork: false,
        });
        runtime.registerProvider(id, providerConfig());
        await runtime.refresh({ allowNetwork: false, providers: [id] });
        const model = runtime.getModel(id, "grok-integration-test");
        expect(model).toBeDefined();
        requestAccess = (await runtime.prepareRequest(model, {})).options.apiKey;
      } else {
        const storage = codingAgent.AuthStorage.create(authPath);
        const registry = codingAgent.ModelRegistry.create(storage);
        registry.registerProvider(id, providerConfig());
        const model = registry.find(id, "grok-integration-test");
        expect(model).toBeDefined();
        const auth = await registry.getApiKeyAndHeaders(model);
        expect(auth).toMatchObject({ ok: true });
        requestAccess = auth.apiKey;
      }

      const stored = JSON.parse(await readFile(authPath, "utf8"))[id];
      expect(requestAccess).toBe("refreshed-access");
      expect(stored).toMatchObject({
        type: "oauth",
        access: "refreshed-access",
        refresh: "rotated-refresh",
      });
      expect(stored.expires).toBeGreaterThan(Date.now());
    } finally {
      await temp.cleanup();
    }
  });
});
