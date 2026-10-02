import { describe, expect, it, vi } from "vitest";
import { fetchXaiUsage } from "../../extensions/xai/usage";
import { XaiUsageError } from "../../extensions/xai/usage-parse";
import { XAI_CLI_BILLING_URL, XAI_CLI_USER_URL } from "../../extensions/xai/constants";
import { headerValue, jsonResponse } from "../fixtures/http";
import newCredits from "../fixtures/usage/credits-new.json";
import identity from "../fixtures/usage/identity.json";

const credential = { kind: "oauth-session" as const, token: "SECRET_BEARER_82" };

async function capturedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected request to fail");
}

describe("xAI usage transport", () => {
  it("uses the pinned identity-first contract and required proxy metadata", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      return url === XAI_CLI_USER_URL ? jsonResponse(identity) : jsonResponse(newCredits);
    }));

    const usage = await fetchXaiUsage(credential);
    expect(usage.creditUsagePercent).toBe(42.5);
    expect(requests.map(({ url }) => url)).toEqual([XAI_CLI_USER_URL, XAI_CLI_BILLING_URL]);
    for (const request of requests) {
      expect(request.init).toMatchObject({ method: "GET", redirect: "error" });
      expect(headerValue(request.init?.headers, "Authorization")).toBe("Bearer SECRET_BEARER_82");
      expect(headerValue(request.init?.headers, "X-XAI-Token-Auth")).toBe("xai-grok-cli");
      expect(headerValue(request.init?.headers, "x-grok-client-version")).toMatch(/^\d+\.\d+\.\d+/);
      expect(headerValue(request.init?.headers, "x-grok-client-mode")).toMatch(/interactive|headless/);
    }
    expect(headerValue(requests[0]?.init?.headers, "x-userid")).toBeUndefined();
    expect(headerValue(requests[1]?.init?.headers, "x-userid")).toBe("user-fixture-82");
    expect(JSON.stringify(usage)).not.toMatch(/SECRET_BEARER_82|user-fixture-82/);
  });

  it.each([
    ["missing identity", jsonResponse({})],
    ["identity auth failure", jsonResponse({ error: "SECRET_BODY" }, 401)],
    ["identity redirect", jsonResponse({}, 302, { Location: "https://attacker.invalid" })],
    ["malformed identity", new Response("{not-json")],
    ["invalid UTF-8 identity", new Response(Uint8Array.from([0xc3, 0x28]))],
    ["oversized identity", new Response("x".repeat(64 * 1024 + 1))],
  ])("fails closed before billing on %s", async (_label, response) => {
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchXaiUsage(credential)).rejects.toBeInstanceOf(XaiUsageError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds billing bodies and never reflects response or transport secrets", async () => {
    const bodies = [
      jsonResponse({ error: "RAW_BILLING_SECRET" }, 500),
      new Response("x".repeat(64 * 1024 + 1)),
    ];
    for (const billingResponse of bodies) {
      const fetchMock = vi.fn(async (input: string | URL | Request) =>
        String(input) === XAI_CLI_USER_URL ? jsonResponse(identity) : billingResponse);
      vi.stubGlobal("fetch", fetchMock);
      const error = await capturedError(fetchXaiUsage(credential));
      expect(error).toBeInstanceOf(XaiUsageError);
      expect(error.message).not.toMatch(/RAW_BILLING_SECRET|SECRET_BEARER_82|user-fixture-82/);
    }

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("transport leaked SECRET_BEARER_82");
    }));
    const transportError = await capturedError(fetchXaiUsage(credential));
    expect(transportError.message).toBe("xAI usage request failed.");
  });

  it("cancels unsuccessful response bodies before returning a redacted error", async () => {
    const cancel = vi.fn();
    const fetchMock = vi.fn(async () =>
      new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchXaiUsage(credential)).rejects.toMatchObject({
      code: "http",
      status: 500,
      message: "xAI usage request failed with status 500.",
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation safely before billing", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetchMock = vi.fn(async () =>
      new Response(new ReadableStream<Uint8Array>({ cancel })));
    vi.stubGlobal("fetch", fetchMock);
    const request = fetchXaiUsage(credential, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    const error = await request.catch((caught) => caught as XaiUsageError);
    expect(error).toMatchObject({ code: "cancelled", message: "xAI usage request was cancelled." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not await a response stream whose cancellation never settles", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetchMock = vi.fn(async () =>
      new Response(new ReadableStream<Uint8Array>({ cancel })));
    vi.stubGlobal("fetch", fetchMock);
    const request = fetchXaiUsage(credential, controller.signal)
      .catch((caught) => caught as XaiUsageError);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(request).resolves.toMatchObject({
      code: "cancelled",
      message: "xAI usage request was cancelled.",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("applies the 15-second timeout without leaking fetch errors", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("SECRET_TIMEOUT")), { once: true });
      })));
    const request = fetchXaiUsage(credential).catch((error) => error as XaiUsageError);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(request).resolves.toMatchObject({
      code: "timeout",
      message: "xAI usage request timed out.",
    });
  });

  it("applies the timeout after response headers when the body stalls", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(new ReadableStream<Uint8Array>({ cancel }))));
    const request = fetchXaiUsage(credential).catch((error) => error as XaiUsageError);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(request).resolves.toMatchObject({
      code: "timeout",
      message: "xAI usage request timed out.",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects API-key provenance before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchXaiUsage({ kind: "api-key", token: "SECRET" })).rejects.toMatchObject({
      code: "auth",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
