import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../../extensions/xai-oauth";
import {
  CURATED_FALLBACK_MODELS,
  expandXaiCatalogWithAliases,
  KNOWN_XAI_MODEL_METADATA,
  setXaiRuntimeModels,
} from "../../extensions/xai/models";
import { XAI_NETWORK_TOOL_NAMES } from "../../extensions/xai/tools/model-scope";
import { createExtensionHarness } from "../fixtures/extension-api";
import { TEST_MODEL } from "../fixtures/models";
import { createTempDir, stubHome } from "../fixtures/temp";
let temp: Awaited<ReturnType<typeof createTempDir>>;
beforeEach(async () => {
  temp = await createTempDir("pi-xai-provider-");
  stubHome(temp.path);
});
afterEach(async () => {
  setXaiRuntimeModels(CURATED_FALLBACK_MODELS);
  vi.restoreAllMocks();
  await temp.cleanup();
});

describe("provider registration", () => {
  it("registers the OAuth provider, tools, command, and curated fallback", async () => {
    const harness = createExtensionHarness();
    await extension(harness.api);
    const provider = harness.providers.get("xai-auth");
    expect(provider).toBeDefined();
    expect(harness.providers.has("xai")).toBe(false);
    expect(provider).toMatchObject({
      api: "xai-responses",
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      authHeader: true,
    });
    expect(provider.models.map(({ id }: any) => id)).toEqual(
      expandXaiCatalogWithAliases(CURATED_FALLBACK_MODELS).map((model) => model.id),
    );
    expect(provider.models[0]).toMatchObject({
      contextWindow: 500_000,
      reasoning: true,
      cost: { input: 2, cacheRead: 0.5, output: 6 },
      thinkingLevelMap: { off: null },
    });
    expect(harness.tools.size).toBe(18);
    expect(harness.tools.has("xai_edit_image")).toBe(true);
    expect(harness.tools.has("xai_image_to_video")).toBe(true);
    expect(harness.tools.has("xai_text_to_speech")).toBe(true);
    expect(harness.tools.has("xai_transcribe_audio")).toBe(true);
    expect(harness.tools.has("xai_grok_web_search")).toBe(true);
    expect(harness.tools.has("xai_web_search")).toBe(false);
    expect(harness.tools.has("web_search")).toBe(false);
    expect(harness.commands.has("xai-tools")).toBe(true);
    expect(harness.commands.has("xai-usage")).toBe(true);
    expect(harness.commands.has("xai-voice")).toBe(true);
    expect([...harness.shortcuts.keys()]).toEqual(["ctrl+space", "f8"]);
    expect([...harness.handlers.keys()]).toEqual(
      expect.arrayContaining([
        "session_start",
        "input",
        "model_select",
        "before_agent_start",
        "turn_end",
        "session_shutdown",
      ]),
    );
    expect(
      harness.handlers.get("turn_end")?.({}, { model: TEST_MODEL, ui: {} }),
    ).toBeUndefined();
  });
  it("registers independently on a second Pi API object", async () => {
    const first = createExtensionHarness();
    const second = createExtensionHarness();
    await extension(first.api);
    await extension(second.api);
    expect(second.tools.size).toBe(first.tools.size);
    expect(second.commands.size).toBe(first.commands.size);
    expect(second.providers.has("xai-auth")).toBe(true);
  });
  it("wires usage status through turn, model, session-start, and shutdown events", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const harness = createExtensionHarness();
    await extension(harness.api);
    const notifications: Array<{ message: string; type?: string }> = [];
    const statuses: Array<{ key: string; text?: string }> = [];
    let storedCredential: any = {
      type: "oauth",
      access: "oauth-access",
      refresh: "refresh",
      expires: Date.now() + 60_000,
    };
    const ui = {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
      },
    };
    const ctx = {
      model: TEST_MODEL,
      signal: undefined,
      ui,
      modelRegistry: {
        authStorage: {
          get: () => storedCredential,
        },
        find: () => TEST_MODEL,
        isUsingOAuth: () => storedCredential?.type === "oauth",
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: storedCredential?.access,
        }),
      },
    };
    let stallNext = false;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (stallNext) {
        stallNext = false;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        });
      }
      return String(input).endsWith("/user")
        ? new Response(JSON.stringify({ userId: "user-registration-test" }))
        : new Response(JSON.stringify({ config: { creditUsagePercent: 25 } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const usageCommand = harness.commands.get("xai-usage").handler;

    await usageCommand("status on", ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)?.text).toBe("xAI 25% used");

    now += 60_000;
    stallNext = true;
    expect(harness.handlers.get("turn_end")?.({}, ctx)).toBeUndefined();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    await harness.handlers.get("model_select")?.({ model: TEST_MODEL }, ctx);
    expect(statuses.at(-1)).toEqual({ key: "xai-usage", text: undefined });
    await usageCommand("status", ctx);
    expect(notifications.at(-1)?.message).toMatch(/status is off/);

    await usageCommand("status on", ctx);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    harness.handlers.get("session_shutdown")?.({}, ctx);
    expect(statuses.at(-1)).toEqual({ key: "xai-usage", text: undefined });

    await usageCommand("status on", ctx);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    await harness.handlers.get("session_start")?.({}, { model: TEST_MODEL, ui });
    await usageCommand("status", ctx);
    expect(notifications.at(-1)?.message).toMatch(/status is off/);
  });
  it("wires model, session, and before-agent events to fail-closed tool synchronization", async () => {
    const harness = createExtensionHarness();
    await extension(harness.api);
    const fetchMock = vi.fn(async () => {
      throw new Error("lifecycle handlers must not use the network");
    });
    vi.stubGlobal("fetch", fetchMock);

    await harness.handlers.get("model_select")?.(
      { model: { ...TEST_MODEL, id: "grok-4.5" } },
      { model: { ...TEST_MODEL, id: "grok-4.5" } },
    );
    expect(harness.getActiveTools()).toContain("xai_grok_grep");
    expect(harness.getActiveTools()).not.toContain("web_search");

    harness.setActiveTools([
      ...harness.getActiveTools(),
      ...XAI_NETWORK_TOOL_NAMES,
    ]);
    await harness.handlers.get("session_start")?.({}, { model: TEST_MODEL });
    // Local Grok-native tools stay for xai-auth; network tools reset.
    expect(harness.getActiveTools()).toContain("xai_grok_grep");
    expect(
      XAI_NETWORK_TOOL_NAMES.every(
        (name) => !harness.getActiveTools().includes(name),
      ),
    ).toBe(true);

    await harness.handlers.get("model_select")?.(
      { model: { ...TEST_MODEL, id: "grok-4.5" } },
      { model: { ...TEST_MODEL, id: "grok-4.5" } },
    );
    await harness.handlers.get("before_agent_start")?.(
      {},
      { model: { ...TEST_MODEL, id: "grok-4.5" } },
    );
    expect(harness.getActiveTools()).toContain("xai_grok_grep");
    expect(harness.getActiveTools()).not.toContain("web_search");

    harness.setActiveTools([
      ...harness.getActiveTools(),
      ...XAI_NETWORK_TOOL_NAMES,
    ]);
    harness.failRegistry({ get: true });
    await harness.handlers.get("session_start")?.({}, { model: TEST_MODEL });
    harness.failRegistry();
    await harness.handlers.get("before_agent_start")?.(
      {},
      { model: TEST_MODEL },
    );
    expect(
      XAI_NETWORK_TOOL_NAMES.every(
        (name) => !harness.getActiveTools().includes(name),
      ),
    ).toBe(true);

    harness.setActiveTools([
      ...harness.getActiveTools(),
      ...XAI_NETWORK_TOOL_NAMES,
    ]);
    harness.failRegistry({ set: true });
    await harness.handlers.get("session_start")?.({}, { model: TEST_MODEL });
    harness.failRegistry();
    await harness.handlers.get("before_agent_start")?.(
      {},
      { model: TEST_MODEL },
    );
    expect(
      XAI_NETWORK_TOOL_NAMES.every(
        (name) => !harness.getActiveTools().includes(name),
      ),
    ).toBe(true);

    await harness.handlers.get("model_select")?.(
      { model: { provider: "anthropic", id: "claude" } },
      { model: { provider: "anthropic", id: "claude" } },
    );
    expect(harness.getActiveTools()).not.toContain("xai_grok_grep");
    expect(
      XAI_NETWORK_TOOL_NAMES.every(
        (name) => !harness.getActiveTools().includes(name),
      ),
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains known compatibility metadata without advertising it offline", () => {
    expect(
      KNOWN_XAI_MODEL_METADATA.find(({ id }) => id === "grok-build")
        ?.contextWindow,
    ).toBe(512_000);
    expect(
      KNOWN_XAI_MODEL_METADATA.find(({ id }) => id === "grok-composer-2.5-fast")
        ?.reasoning,
    ).toBe(false);
  });
});
