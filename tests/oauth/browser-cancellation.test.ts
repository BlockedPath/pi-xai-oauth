import { afterEach, describe, expect, it, vi } from "vitest";
import { createXaiOAuth } from "../../extensions/xai/oauth";
import { discovery, signIdToken } from "../fixtures/oauth";
import { jsonResponse } from "../fixtures/http";
const nativeFetch = globalThis.fetch;
const base = {
  onPrompt: async () => "n",
  onProgress: () => {},
  onSelect: async () => "browser",
  onDeviceCode: () => {},
} as any;
afterEach(() => vi.unstubAllGlobals());

describe("browser OAuth cancellation cleanup", () => {
  it("stops a pre-aborted login before discovery or browser authorization", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let opened = false;
    await expect(
      createXaiOAuth({ getExistingCredentials: () => null }).login({
        ...base,
        signal: controller.signal,
        onAuth: () => {
          opened = true;
        },
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(opened).toBe(false);
  });
  it("propagates cancellation during discovery", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: RequestInit) => {
        requestSignal = init.signal as AbortSignal;
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }),
    );
    await expect(
      createXaiOAuth({ getExistingCredentials: () => null }).login({
        ...base,
        signal: controller.signal,
        onAuth: () => {
          throw new Error("browser opened");
        },
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(requestSignal?.aborted).toBe(true);
  });
  it("treats an already-aborted signal as cancelled before waiting for the callback", async () => {
    const controller = new AbortController();
    let redirect = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any, init: RequestInit) => {
        if (String(input).startsWith("http://127.0.0.1:"))
          return nativeFetch(input, init);
        return jsonResponse(discovery());
      }),
    );
    await expect(
      createXaiOAuth({ getExistingCredentials: () => null }).login({
        ...base,
        signal: controller.signal,
        onAuth(auth: any) {
          redirect = new URL(auth.url).searchParams.get("redirect_uri")!;
          controller.abort();
        },
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:/);
    await expect(nativeFetch(redirect)).rejects.toThrow();
  });

  it("closes the callback listener when cancelled while waiting", async () => {
    const controller = new AbortController();
    let redirect = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any, init: RequestInit) => {
        if (String(input).startsWith("http://127.0.0.1:"))
          return nativeFetch(input, init);
        return jsonResponse(discovery());
      }),
    );
    await expect(
      createXaiOAuth({ getExistingCredentials: () => null }).login({
        ...base,
        signal: controller.signal,
        onAuth(auth: any) {
          redirect = new URL(auth.url).searchParams.get("redirect_uri")!;
          queueMicrotask(() => controller.abort());
        },
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:/);
    await expect(nativeFetch(redirect)).rejects.toThrow();
  });
  it.each(["token", "jwks"] as const)(
    "propagates cancellation during the %s request",
    async (stage) => {
      const controller = new AbortController();
      let authUrl: URL | undefined;
      let callbackDriver = Promise.resolve();
      let stageSignal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: any, init: RequestInit = {}) => {
          const url = String(input);
          if (url.startsWith("http://127.0.0.1:"))
            return nativeFetch(input, init);
          if (url.endsWith("openid-configuration"))
            return jsonResponse(discovery());
          if (url.endsWith("oauth2/token")) {
            if (stage === "token") {
              stageSignal = init.signal as AbortSignal;
              controller.abort();
              throw new DOMException("aborted", "AbortError");
            }
            return jsonResponse({
              access_token: "access",
              refresh_token: "refresh",
              id_token: signIdToken({
                nonce: authUrl?.searchParams.get("nonce") ?? "",
              }),
            });
          }
          if (url.endsWith("jwks.json") && stage === "jwks") {
            stageSignal = init.signal as AbortSignal;
            controller.abort();
            throw new DOMException("aborted", "AbortError");
          }
          throw new Error(`Unexpected request origin: ${new URL(url).origin}`);
        }),
      );

      const login = createXaiOAuth({
        getExistingCredentials: () => null,
      }).login({
        ...base,
        signal: controller.signal,
        onAuth(auth: any) {
          authUrl = new URL(auth.url);
          const callback = new URL(authUrl.searchParams.get("redirect_uri")!);
          callback.searchParams.set("code", `cancel-${stage}`);
          callback.searchParams.set(
            "state",
            authUrl.searchParams.get("state")!,
          );
          callbackDriver = nativeFetch(callback).then(() => undefined);
          void callbackDriver.catch(() => controller.abort());
        },
      });

      await expect(login).rejects.toThrow(/cancelled/i);
      await callbackDriver;
      expect(stageSignal).toBe(controller.signal);
      expect(stageSignal?.aborted).toBe(true);
    },
  );

  it("closes the callback listener when the Pi UI callback throws", async () => {
    let redirect = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(discovery())),
    );
    await expect(
      createXaiOAuth({ getExistingCredentials: () => null }).login({
        ...base,
        onAuth(auth: any) {
          redirect = new URL(auth.url).searchParams.get("redirect_uri")!;
          throw new Error("UI failure");
        },
      }),
    ).rejects.toThrow("UI failure");
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:/);
    await expect(nativeFetch(redirect)).rejects.toThrow();
  });
});
