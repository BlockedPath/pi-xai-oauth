import { describe, expect, it, vi } from "vitest";
import packageMetadata from "../../package.json";
import {
  createXaiOAuth,
  ensureFreshXaiCredentials,
  refreshXaiCredentials,
} from "../../extensions/xai/oauth";
import { XAI_OAUTH_TOKEN_URL } from "../../extensions/xai/constants";
import { jsonResponse } from "../fixtures/http";
import { XAI_USER_AGENT } from "../../extensions/xai/constants";
import { resolveXaiOAuthClientSurface } from "../../extensions/xai/wire";

describe("OAuth refresh", () => {
  it("rotates or preserves refresh tokens without renegotiating scope", async () => {
    const bodies: Record<string, string>[] = [];
    const headers: Headers[] = [];
    const replies = [
      jsonResponse({
        access_token: "rotated",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      }),
      jsonResponse({
        access_token: "preserved",
        expires_in: 3600,
        id_token: "unvalidated",
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init: RequestInit) => {
        expect(String(url)).toBe(XAI_OAUTH_TOKEN_URL);
        expect(init).toMatchObject({ method: "POST", redirect: "error" });
        headers.push(new Headers(init.headers));
        bodies.push(Object.fromEntries(new URLSearchParams(String(init.body))));
        return replies.shift()!;
      }),
    );
    const oauth = createXaiOAuth({ getExistingCredentials: () => null });
    const base = {
      access: "old",
      refresh: "old-refresh",
      expires: 1,
      tokenEndpoint: XAI_OAUTH_TOKEN_URL,
    };
    expect((await oauth.refreshToken(base)).refresh).toBe("rotated-refresh");
    const preserved = await oauth.refreshToken(base);
    expect(preserved).toMatchObject({
      access: "preserved",
      refresh: "old-refresh",
    });
    expect(preserved).not.toHaveProperty("idToken");
    expect(bodies.every((body) => !("scope" in body))).toBe(true);
    expect(bodies[0]).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    });
    expect(headers[0].get("Accept")).toBe("application/json");
    expect(headers[0].get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(headers[0].get("User-Agent")).toBe(XAI_USER_AGENT);
    expect(headers[0].get("X-Grok-Client-Version")).toBe(
      packageMetadata.version,
    );
    expect(headers[0].get("X-Grok-Client-Surface")).toBe(
      resolveXaiOAuthClientSurface(),
    );
    expect(headers[0].get("X-XAI-Token-Auth")).toBeNull();
  });

  it("forwards Pi's concrete refresh abort signal to the token exchange", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: any, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      return jsonResponse({
        access_token: "signal-bound-access",
        refresh_token: "signal-bound-refresh",
        expires_in: 3600,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const oauth = createXaiOAuth({ getExistingCredentials: () => null });
    await oauth.refreshToken(
      {
        access: "old",
        refresh: "old-refresh",
        expires: 1,
        tokenEndpoint: XAI_OAUTH_TOKEN_URL,
      },
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects missing refresh and untrusted token endpoints", async () => {
    await expect(
      refreshXaiCredentials({ access: "expired", refresh: "", expires: 1 }),
    ).rejects.toThrow(/do not include a refresh token/);
    await expect(
      refreshXaiCredentials({
        access: "expired",
        refresh: "refresh",
        expires: 1,
        tokenEndpoint: "https://evil.x.ai/oauth2/token",
      }),
    ).rejects.toThrow(/untrusted token endpoint/);
  });

  it("redacts token error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: "invalid_grant", error_description: "TOKEN_SECRET" },
          400,
        ),
      ),
    );
    const error = await refreshXaiCredentials({
      access: "old",
      refresh: "refresh",
      expires: 1,
      tokenEndpoint: XAI_OAUTH_TOKEN_URL,
    }).catch((value) => value as Error);
    expect(error.message).toMatch(/status 400/);
    expect(error.message).not.toContain("TOKEN_SECRET");
  });

  it("returns unexpired credentials without a token request", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("must not refresh a fresh token");
    });
    vi.stubGlobal("fetch", fetchMock);
    const oauth = createXaiOAuth({ getExistingCredentials: () => null });
    const fresh = {
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: Date.now() + 60_000,
      tokenEndpoint: XAI_OAUTH_TOKEN_URL,
    };
    const noExpiry = { access: "no-expiry-access", refresh: "refresh", expires: 0 };

    await expect(ensureFreshXaiCredentials(fresh)).resolves.toBe(fresh);
    await expect(oauth.refreshToken({ ...fresh, refresh: "" })).resolves.toEqual({
      ...fresh,
      refresh: "",
    });
    await expect(ensureFreshXaiCredentials(noExpiry)).resolves.toBe(noExpiry);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes expired stored credentials and refuses expired tokens without refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
      ),
    );
    const oauth = createXaiOAuth({ getExistingCredentials: () => null });
    const expired = {
      access: "stale-access",
      refresh: "stale-refresh",
      expires: 1,
      tokenEndpoint: XAI_OAUTH_TOKEN_URL,
    };

    await expect(ensureFreshXaiCredentials(expired)).resolves.toMatchObject({
      access: "rotated-access",
      refresh: "rotated-refresh",
    });
    await expect(
      oauth.refreshToken({ access: "stale-access", refresh: "", expires: 1 }),
    ).rejects.toThrow(/expired and cannot be refreshed/);
  });

  it.each([
    ["non-JSON", () => new Response("not-json", { status: 200 }), /invalid JSON/],
    ["array JSON", () => jsonResponse(["token"]), /invalid JSON/],
    [
      "missing access token",
      () => jsonResponse({ refresh_token: "refresh" }),
      /did not include an access token/,
    ],
    [
      "empty access token",
      () => jsonResponse({ access_token: "", refresh_token: "refresh" }),
      /did not include an access token/,
    ],
  ] as const)("rejects a %s token payload", async (_label, response, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await expect(
      refreshXaiCredentials({
        access: "old",
        refresh: "refresh",
        expires: 1,
        tokenEndpoint: XAI_OAUTH_TOKEN_URL,
      }),
    ).rejects.toThrow(message);
  });

  it("reuses existing Grok CLI credentials during login without opening a browser", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        access_token: "login-rotated",
        refresh_token: "login-rotated-refresh",
        expires_in: 3600,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const existing = {
      access: "stale-grok",
      refresh: "grok-refresh",
      expires: 1,
      tokenEndpoint: XAI_OAUTH_TOKEN_URL,
    };
    const oauth = createXaiOAuth({ getExistingCredentials: () => existing });
    const credentials = await oauth.login({
      onPrompt: async () => "yes",
      onProgress: () => {},
      onAuth: () => {
        throw new Error("browser login must not start");
      },
      onSelect: async () => {
        throw new Error("login method selector must not start");
      },
      onDeviceCode: () => {
        throw new Error("device login must not start");
      },
    } as any);

    expect(credentials).toMatchObject({
      access: "login-rotated",
      refresh: "login-rotated-refresh",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls through to a fresh login when existing credentials cannot be refreshed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: "invalid_grant", error_description: "TOKEN_SECRET" },
          400,
        ),
      ),
    );
    const progress: string[] = [];
    const oauth = createXaiOAuth({
      getExistingCredentials: () => ({
        access: "stale-grok",
        refresh: "grok-refresh",
        expires: 1,
        tokenEndpoint: XAI_OAUTH_TOKEN_URL,
      }),
    });

    await expect(
      oauth.login({
        onPrompt: async () => "Y",
        onProgress: (message: string) => progress.push(message),
        onSelect: async () => undefined,
        onAuth: () => {
          throw new Error("browser login must wait for method selection");
        },
        onDeviceCode: () => {
          throw new Error("device login must wait for method selection");
        },
      } as any),
    ).rejects.toThrow("Login cancelled");

    expect(progress[0]).toMatch(/could not be refreshed/);
    expect(progress[0]).toMatch(/status 400/);
    expect(progress.join("\n")).not.toContain("TOKEN_SECRET");
  });
});
