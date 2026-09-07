import { describe, expect, it, vi } from "vitest";
import {
  registerXaiUsage,
  renderXaiUsageCsv,
  type XaiUsageSnapshot,
} from "../../extensions/xai/usage";
import { commandContext, createExtensionHarness } from "../fixtures/extension-api";
import { BUILTIN_XAI_TEST_MODEL, TEST_MODEL } from "../fixtures/models";

const usage: XaiUsageSnapshot = {
  creditUsagePercent: 25,
  currentPeriod: { end: "2026-08-01T00:00:00Z" },
  history: [],
};

function setup(model: any = TEST_MODEL) {
  const harness = createExtensionHarness();
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; text?: string }> = [];
  let now = 1_000;
  let storedCredential: any = {
    type: "oauth",
    access: "SECRET",
    refresh: "refresh",
    expires: Date.now() + 60_000,
  };
  const resolveCredential = vi.fn(async () => ({ kind: "oauth-session" as const, token: "SECRET" }));
  const fetchUsage = vi.fn(async (_credential: any, _signal?: AbortSignal) => usage);
  const feature = registerXaiUsage(harness.api, {
    resolveCredential,
    fetchUsage,
    now: () => now,
    minimumRefreshMs: 60_000,
  });
  const ctx = commandContext(model, notifications, {
    signal: undefined,
    modelRegistry: {
      authStorage: {
        get: (provider: string) => provider === model.provider ? storedCredential : undefined,
      },
      find: (provider: string, id: string) =>
        provider === model.provider ? { ...model, provider, id } : undefined,
      isUsingOAuth: (registryModel: any) =>
        registryModel?.provider === model.provider && storedCredential?.type === "oauth",
      getProviderAuthStatus: (provider: string) => provider === model.provider
        ? { configured: !!storedCredential, source: "stored" }
        : { configured: false },
    },
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
      },
    },
  });
  const run = (args: string) => harness.commands.get("xai-usage").handler(args, ctx);
  return {
    ctx,
    feature,
    fetchUsage,
    harness,
    notifications,
    resolveCredential,
    run,
    statuses,
    setNow(value: number) { now = value; },
    setStoredCredential(value: any) { storedCredential = value; },
  };
}

describe("/xai-usage command and status lifecycle", () => {
  it("performs an explicit one-shot lookup without enabling status", async () => {
    const { fetchUsage, harness, notifications, run, statuses } = setup();
    expect(harness.commands.has("xai-usage")).toBe(true);
    await run("");
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(notifications.at(-1)).toMatchObject({ type: "info" });
    expect(notifications.at(-1)?.message).toContain("Included usage: 25%");
    expect(statuses).toEqual([]);
    await run("status");
    expect(notifications.at(-1)?.message).toMatch(/status is off/);
  });

  it.each([TEST_MODEL, BUILTIN_XAI_TEST_MODEL])("exports CSV explicitly on $provider without enabling status", async (model) => {
    const state = setup(model);
    await state.feature.refreshStatus(state.ctx as any);
    expect(state.fetchUsage).not.toHaveBeenCalled();
    await state.run("  CSV  ");
    expect(state.fetchUsage).toHaveBeenCalledTimes(1);
    expect(state.notifications).toEqual([{ message: renderXaiUsageCsv(usage), type: "info" }]);
    expect(state.statuses).toEqual([]);
    await state.run("status");
    expect(state.notifications.at(-1)?.message).toMatch(/status is off/);
    await state.feature.refreshStatus(state.ctx as any);
    expect(state.fetchUsage).toHaveBeenCalledTimes(1);
  });

  it.each(["csv extra", "csv status on", "status csv", "--csv", "export csv"])(
    "rejects unsupported CSV arguments without fetching: %s",
    async (args) => {
      const state = setup();
      await state.run(args);
      expect(state.resolveCredential).not.toHaveBeenCalled();
      expect(state.fetchUsage).not.toHaveBeenCalled();
      expect(state.notifications).toEqual([{
        message: "Usage: /xai-usage [csv|status [on|off]]",
        type: "error",
      }]);
    },
  );

  it("keeps status off for non-xAI models and validates command arguments", async () => {
    const { fetchUsage, notifications, run, statuses } = setup({ provider: "anthropic", id: "claude" });
    await run("status on");
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(notifications.at(-1)?.message).toMatch(/Select an xAI\/Grok model/);
    expect(statuses.at(-1)).toEqual({ key: "xai-usage", text: undefined });
    await run("enable");
    expect(notifications.at(-1)?.message).toBe("Usage: /xai-usage [csv|status [on|off]]");
  });
  it("enables status for a built-in xAI model with SuperGrok OAuth", async () => {
    const state = setup(BUILTIN_XAI_TEST_MODEL);

    await state.run("status on");

    expect(state.fetchUsage).toHaveBeenCalledTimes(1);
    expect(state.statuses.at(-1)?.text).toBe("xAI 25% used · reset 2026-08-01");
    expect(state.notifications.at(-1)?.message).toMatch(/status is on/);
  });
  it("rejects built-in API-key provenance before usage resolution", async () => {
    const state = setup(BUILTIN_XAI_TEST_MODEL);
    state.setStoredCredential({ type: "api_key", key: "BUILTIN_API_KEY" });

    await state.run("status on");

    expect(state.resolveCredential).not.toHaveBeenCalled();
    expect(state.fetchUsage).not.toHaveBeenCalled();
    expect(state.notifications.at(-1)?.message).toMatch(/could not be refreshed/);
  });

  it("never treats an unrelated active-model API key as an xAI OAuth bearer", async () => {
    const harness = createExtensionHarness();
    const notifications: Array<{ message: string; type?: string }> = [];
    registerXaiUsage(harness.api);
    const ctx = commandContext(
      { provider: "anthropic", id: "claude" },
      notifications,
      {
        apiKey: "UNRELATED_API_KEY",
        modelRegistry: {
          find: vi.fn(() => undefined),
          getApiKeyAndHeaders: vi.fn(),
        },
      },
    );

    await harness.commands.get("xai-usage").handler("", ctx);

    expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(notifications.at(-1)).toEqual({
      message: "xAI OAuth credentials are required. Run /login xai or /login xai-auth first.",
      type: "error",
    });
  });

  it("refreshes only on bounded events and clears when disabled", async () => {
    const state = setup();
    await state.run("status on");
    expect(state.fetchUsage).toHaveBeenCalledTimes(1);
    expect(state.statuses.at(-1)?.text).toBe("xAI 25% used · reset 2026-08-01");

    state.setNow(60_999);
    await state.feature.refreshStatus(state.ctx as any);
    expect(state.fetchUsage).toHaveBeenCalledTimes(1);
    state.setNow(61_000);
    await state.feature.refreshStatus(state.ctx as any);
    expect(state.fetchUsage).toHaveBeenCalledTimes(2);

    await state.run("status off");
    expect(state.statuses.at(-1)).toEqual({ key: "xai-usage", text: undefined });
    state.setNow(200_000);
    await state.feature.refreshStatus(state.ctx as any);
    expect(state.fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("clears and disables status on provider, model, account, or session resets", async () => {
    const state = setup();
    await state.run("status on");
    state.feature.clearIfInactive({
      ...state.ctx,
      model: { provider: "anthropic", id: "claude" },
    } as any);
    expect(state.statuses.at(-1)).toEqual({ key: "xai-usage", text: undefined });
    await state.run("status");
    expect(state.notifications.at(-1)?.message).toMatch(/status is off/);

    await state.run("status on");
    state.feature.reset(state.ctx as any);
    expect(state.statuses.at(-1)).toEqual({ key: "xai-usage", text: undefined });
    await state.feature.refreshStatus(state.ctx as any);
    expect(state.fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("fails closed on stored credential removal before the refresh throttle", async () => {
    const state = setup();
    await state.run("status on");
    expect(state.fetchUsage).toHaveBeenCalledTimes(1);
    state.setStoredCredential(undefined);
    await state.feature.refreshStatus(state.ctx as any);
    expect(state.fetchUsage).toHaveBeenCalledTimes(1);
    expect(state.statuses.at(-1)).toEqual({ key: "xai-usage", text: undefined });
    await state.run("status");
    expect(state.notifications.at(-1)?.message).toMatch(/status is off/);
  });

  it.each(["", "csv"])("suppresses stale one-shot errors after a reset (%s)", async (args) => {
    const state = setup();
    state.fetchUsage.mockImplementationOnce(async (_credential: any, signal?: AbortSignal) =>
      new Promise<XaiUsageSnapshot>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      }));
    const pending = state.run(args);
    await vi.waitFor(() => expect(state.fetchUsage).toHaveBeenCalledTimes(1));
    state.feature.reset(state.ctx as any);
    await pending;
    expect(state.notifications).toEqual([]);
  });

  it.each(["cancel", "reset", "supersede"])("suppresses late CSV success after %s", async (action) => {
    const state = setup();
    const controller = new AbortController();
    state.ctx.signal = controller.signal;
    let complete!: (value: XaiUsageSnapshot) => void;
    state.fetchUsage.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = state.run("csv");
    await vi.waitFor(() => expect(state.fetchUsage).toHaveBeenCalledTimes(1));
    if (action === "cancel") controller.abort();
    else if (action === "reset") state.feature.reset(state.ctx as any);
    else await state.run("csv");
    expect(state.fetchUsage.mock.calls[0][1]?.aborted).toBe(true);
    const before = [...state.notifications];
    complete({ subscriptionTier: "STALE_ACCOUNT", history: [] });
    await pending;
    expect(state.notifications).toEqual(before);
    expect(JSON.stringify(state.notifications)).not.toContain("STALE_ACCOUNT");
  });

  it("does not resolve credentials for an already-cancelled export", async () => {
    const state = setup();
    state.ctx.signal = AbortSignal.abort();
    await state.run("csv");
    expect(state.resolveCredential).not.toHaveBeenCalled();
    expect(state.fetchUsage).not.toHaveBeenCalled();
    expect(state.notifications).toEqual([]);
  });

  it("does not fetch after cancellation during credential resolution", async () => {
    const state = setup();
    const controller = new AbortController();
    state.ctx.signal = controller.signal;
    state.resolveCredential.mockImplementationOnce(async () => {
      controller.abort();
      return { kind: "oauth-session", token: "SECRET" };
    });
    await state.run("csv");
    expect(state.fetchUsage).not.toHaveBeenCalled();
    expect(state.notifications).toEqual([{
      message: "xAI usage request was cancelled.", type: "error",
    }]);
  });

  it("redacts CSV credential and fetch errors without changing an enabled status", async () => {
    const state = setup();
    await state.run("status on");
    const before = [...state.statuses];
    state.resolveCredential.mockRejectedValueOnce(new Error("PRIVATE_AUTH"));
    await state.run("csv");
    expect(state.notifications.at(-1)).toEqual({
      message: "xAI OAuth credentials could not be resolved. Run /login xai or /login xai-auth first.",
      type: "error",
    });
    state.fetchUsage.mockRejectedValueOnce(new Error("PRIVATE_BODY"));
    await state.run("csv");
    expect(state.notifications.at(-1)).toEqual({ message: "xAI usage request failed.", type: "error" });
    await state.run("csv");
    expect(state.notifications.at(-1)).toEqual({ message: renderXaiUsageCsv(usage), type: "info" });
    expect(state.statuses).toEqual(before);
    await state.run("status");
    expect(state.notifications.at(-1)?.message).toMatch(/status is on/);
    expect(JSON.stringify(state.notifications)).not.toContain("PRIVATE_");
  });

  it("aborts an in-flight status refresh without a late footer write", async () => {
    const state = setup();
    state.fetchUsage.mockImplementationOnce(async (_credential: any, signal?: AbortSignal) =>
      new Promise<XaiUsageSnapshot>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      }));
    const pending = state.run("status on");
    await vi.waitFor(() => expect(state.fetchUsage).toHaveBeenCalledTimes(1));
    state.feature.reset(state.ctx as any);
    await pending;
    expect(state.statuses.some(({ text }) => text?.includes("used"))).toBe(false);
    await state.run("status");
    expect(state.notifications.at(-1)?.message).toMatch(/status is off/);
  });

  it("fails closed and leaves status off after an initial refresh error", async () => {
    const state = setup();
    state.fetchUsage.mockRejectedValueOnce(new Error("SECRET_RAW_ERROR"));
    await state.run("status on");
    expect(state.notifications.at(-1)).toEqual({
      message: "xAI usage request failed.",
      type: "error",
    });
    expect(state.statuses.at(-1)).toEqual({ key: "xai-usage", text: undefined });
    await state.run("status");
    expect(state.notifications.at(-1)?.message).toMatch(/status is off/);
  });
});
