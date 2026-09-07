import { describe, expect, it, vi } from "vitest";
import { registerXaiUsage } from "../../extensions/xai/usage";
import { XAI_CLI_BILLING_URL, XAI_CLI_USER_URL } from "../../extensions/xai/constants";
import { commandContext, createExtensionHarness } from "../fixtures/extension-api";
import { BUILTIN_XAI_TEST_MODEL, TEST_MODEL } from "../fixtures/models";
import { headerValue, jsonResponse } from "../fixtures/http";
import newCredits from "../fixtures/usage/credits-new.json";

function setup(model = TEST_MODEL, oauth = true) {
  const harness = createExtensionHarness();
  const notifications: Array<{ message: string; type?: string }> = [];
  const setStatus = vi.fn();
  const feature = registerXaiUsage(harness.api);
  const ctx = commandContext(model, notifications, {
    modelRegistry: {
      authStorage: {
        get: () => oauth
          ? { type: "oauth", access: "PRIVATE_TOKEN", refresh: "PRIVATE_REFRESH", expires: Date.now() + 60_000 }
          : { type: "api_key", key: "PRIVATE_API_KEY" },
      },
      find: () => model,
      isUsingOAuth: () => oauth,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "PRIVATE_TOKEN" }),
    },
  });
  ctx.ui.setStatus = setStatus;
  return {
    notifications,
    run: () => harness.commands.get("xai-usage").handler("csv", ctx),
    refresh: () => feature.refreshStatus(ctx as any),
    setStatus,
  };
}

describe("CSV command through real usage resolution and transport", () => {
  it.each([TEST_MODEL, BUILTIN_XAI_TEST_MODEL])("exports only normalized fields on $provider", async (model) => {
    const state = setup(model);
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      String(input) === XAI_CLI_USER_URL
        ? jsonResponse({ userId: "PRIVATE_ID", email: "PRIVATE_EMAIL" })
        : jsonResponse({ ...newCredits, rawBody: "PRIVATE_BODY", token: "PRIVATE_TOKEN" }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");

    await state.refresh();
    expect(fetchMock).not.toHaveBeenCalled();
    await state.run();
    expect(fetchMock.mock.calls.map(([input]) => String(input)))
      .toEqual([XAI_CLI_USER_URL, XAI_CLI_BILLING_URL]);
    expect(headerValue(fetchMock.mock.calls[0][1]?.headers, "x-userid")).toBeUndefined();
    expect(headerValue(fetchMock.mock.calls[1][1]?.headers, "x-userid")).toBe("PRIVATE_ID");
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].type).toBe("info");
    expect(state.notifications[0].message).toMatch(/^record_type,/);
    expect(state.notifications[0].message).toContain(",SuperGrok,42.5,");
    expect(JSON.stringify(state.notifications)).not.toMatch(/PRIVATE_|Bearer|rawBody|userId/);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(state.setStatus).not.toHaveBeenCalled();
    await state.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns header-only CSV for an empty normalized snapshot without changing status", async () => {
    const state = setup();
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input) === XAI_CLI_USER_URL
        ? jsonResponse({ userId: "PRIVATE_ID" })
        : jsonResponse({ config: {}, rawBody: "PRIVATE_BODY", token: "PRIVATE_TOKEN" }));
    vi.stubGlobal("fetch", fetchMock);

    await state.run();
    expect(fetchMock.mock.calls.map(([input]) => String(input)))
      .toEqual([XAI_CLI_USER_URL, XAI_CLI_BILLING_URL]);
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].type).toBe("info");
    const records = state.notifications[0].message.split("\r\n");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatch(/^record_type,period_type,/);
    expect(records[0].split(",")).toHaveLength(16);
    expect(records[1]).toBe("");
    expect(state.notifications[0].message).not.toMatch(/PRIVATE_|Bearer|rawBody|userId/);
    expect(state.setStatus).not.toHaveBeenCalled();
    await state.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([TEST_MODEL, BUILTIN_XAI_TEST_MODEL])("rejects API-key provenance on $provider without requests", async (model) => {
    const state = setup(model, false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await state.run();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.notifications).toEqual([{
      message: "xAI OAuth credentials are required. Run /login xai or /login xai-auth first.",
      type: "error",
    }]);
  });

  it.each(["missing identity", "billing error", "oversized billing", "excess history"])(
    "exports no CSV and reports only a safe error for %s",
    async (failure) => {
      const state = setup();
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        if (String(input) === XAI_CLI_USER_URL) {
          return jsonResponse(failure === "missing identity" ? { email: "PRIVATE_EMAIL" } : { userId: "PRIVATE_ID" });
        }
        if (failure === "billing error") return jsonResponse({ error: "PRIVATE_BODY" }, 500);
        if (failure === "oversized billing") return new Response("PRIVATE_BODY".repeat(10_000));
        return jsonResponse({ config: { history: Array.from({ length: 25 }, () => ({})) } });
      });
      vi.stubGlobal("fetch", fetchMock);
      await state.run();
      expect(fetchMock).toHaveBeenCalledTimes(failure === "missing identity" ? 1 : 2);
      expect(state.notifications).toHaveLength(1);
      expect(state.notifications[0].type).toBe("error");
      expect(state.notifications[0].message).not.toMatch(/PRIVATE_|record_type|Bearer/);
    },
  );
});
