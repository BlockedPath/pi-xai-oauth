import { afterEach, describe, expect, it, vi } from "vitest";
import packageMetadata from "../../package.json";
import {
  createXaiOAuth,
  XAI_BROWSER_LOGIN_METHOD,
} from "../../extensions/xai/oauth";
import { discovery, OIDC_PUBLIC_JWK, signIdToken } from "../fixtures/oauth";
import { jsonResponse } from "../fixtures/http";
import { XAI_USER_AGENT } from "../../extensions/xai/constants";
import { resolveXaiOAuthClientSurface } from "../../extensions/xai/wire";

const nativeFetch = globalThis.fetch;
const EXPECTED_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
];

interface BrowserFixture {
  authUrl?: URL;
  exchanges: Record<string, string>[];
  exchangeHeaders: Headers[];
  fetchMock: ReturnType<typeof vi.fn>;
  lastIdToken?: string;
}

function browserFixture(
  tokenStatus = 200,
  tokenBody: Record<string, unknown> = {},
) {
  const fixture: BrowserFixture = {
    exchanges: [],
    exchangeHeaders: [],
    fetchMock: vi.fn(),
  };
  fixture.fetchMock.mockImplementation(
    async (input: any, init: RequestInit = {}) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return nativeFetch(input, init);
      if (url.endsWith("openid-configuration")) {
        expect(init.redirect).toBe("error");
        return jsonResponse(discovery());
      }
      if (url.endsWith("jwks.json")) {
        expect(init.redirect).toBe("error");
        return jsonResponse({ keys: [OIDC_PUBLIC_JWK] });
      }
      if (url.endsWith("oauth2/token")) {
        expect(init).toMatchObject({ method: "POST", redirect: "error" });
        fixture.exchangeHeaders.push(new Headers(init.headers));
        const body = Object.fromEntries(new URLSearchParams(String(init.body)));
        fixture.exchanges.push(body);
        if (tokenStatus !== 200) return jsonResponse(tokenBody, tokenStatus);
        const nonce = fixture.authUrl?.searchParams.get("nonce") ?? "";
        fixture.lastIdToken = signIdToken({ nonce });
        return jsonResponse({
          access_token: `access-${body.code}`,
          refresh_token: "refresh",
          expires_in: 3600,
          token_type: "Bearer",
          id_token: fixture.lastIdToken,
          ...tokenBody,
        });
      }
      throw new Error(`Unexpected request origin: ${new URL(url).origin}`);
    },
  );
  vi.stubGlobal("fetch", fixture.fetchMock);
  return fixture;
}

function callbacks(overrides: Record<string, unknown> = {}) {
  return {
    onPrompt: async () => "n",
    onProgress: () => {},
    onSelect: async () => XAI_BROWSER_LOGIN_METHOD,
    onDeviceCode: () => {
      throw new Error("device UI called");
    },
    ...overrides,
  } as any;
}

function trackDriver(
  controller: AbortController,
  task: Promise<void>,
): Promise<void> {
  void task.catch(() => controller.abort());
  return task;
}

afterEach(() => vi.unstubAllGlobals());

describe("browser OAuth state and manual callbacks", () => {
  it("keeps browser first, rejects bad HTTP state, exchanges only the matching code, and retains the exact verified ID token", async () => {
    const fixture = browserFixture();
    const oauth = createXaiOAuth({ getExistingCredentials: () => null });
    const controller = new AbortController();
    let callbackDriver = Promise.resolve();

    const login = oauth.login(
      callbacks({
        signal: controller.signal,
        onSelect: async (prompt: any) => {
          expect(prompt.options.map(({ id }: any) => id)).toEqual([
            "browser",
            "device",
          ]);
          return "browser";
        },
        onAuth(auth: any) {
          fixture.authUrl = new URL(auth.url);
          callbackDriver = trackDriver(
            controller,
            (async () => {
              const redirect = new URL(
                fixture.authUrl!.searchParams.get("redirect_uri")!,
              );
              const state = fixture.authUrl!.searchParams.get("state")!;
              const missing = new URL(redirect);
              missing.searchParams.set("code", "missing");
              expect((await nativeFetch(missing)).status).toBe(400);
              const bad = new URL(redirect);
              bad.searchParams.set("code", "bad");
              bad.searchParams.set("state", "wrong");
              expect((await nativeFetch(bad)).status).toBe(400);
              const good = new URL(redirect);
              good.searchParams.set("code", "good");
              good.searchParams.set("state", state);
              await nativeFetch(good);
            })(),
          );
        },
      }),
    );

    const credentials = await login;
    await callbackDriver;
    expect(credentials.access).toBe("access-good");
    expect(credentials.idToken).toBe(fixture.lastIdToken);
    expect(fixture.authUrl?.searchParams.get("scope")?.split(" ")).toEqual(
      EXPECTED_SCOPES,
    );
    expect(fixture.exchanges.map(({ code }) => code)).toEqual(["good"]);
    expect(fixture.exchangeHeaders[0].get("Accept")).toBe("application/json");
    expect(fixture.exchangeHeaders[0].get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(fixture.exchangeHeaders[0].get("User-Agent")).toBe(XAI_USER_AGENT);
    expect(fixture.exchangeHeaders[0].get("X-Grok-Client-Version")).toBe(
      packageMetadata.version,
    );
    expect(fixture.exchangeHeaders[0].get("X-Grok-Client-Surface")).toBe(
      resolveXaiOAuthClientSurface(),
    );
    expect(fixture.exchangeHeaders[0].get("X-XAI-Token-Auth")).toBeNull();
  });

  it("accepts a complete matching-state callback URL pasted manually and retains its exact ID token", async () => {
    const fixture = browserFixture();
    const oauth = createXaiOAuth({ getExistingCredentials: () => null });
    let manual = "";
    const credentials = await oauth.login(
      callbacks({
        onAuth(auth: any) {
          fixture.authUrl = new URL(auth.url);
          const url = new URL(
            fixture.authUrl.searchParams.get("redirect_uri")!,
          );
          url.searchParams.set("code", "manual");
          url.searchParams.set(
            "state",
            fixture.authUrl.searchParams.get("state")!,
          );
          manual = url.toString();
        },
        onManualCodeInput: async () => manual,
      }),
    );

    expect(credentials.access).toBe("access-manual");
    expect(credentials.idToken).toBe(fixture.lastIdToken);
    expect(fixture.exchanges.map(({ code }) => code)).toEqual(["manual"]);
  });

  it("rejects raw codes with migration guidance before exchange", async () => {
    const fixture = browserFixture();
    const progress: string[] = [];
    const oauth = createXaiOAuth({ getExistingCredentials: () => null });
    await expect(
      oauth.login(
        callbacks({
          onProgress: (message: string) => progress.push(message),
          onAuth(auth: any) {
            fixture.authUrl = new URL(auth.url);
          },
          onManualCodeInput: async () =>
            "bMmOusw8w9arz1aNEuDCY02jhiOs22O5j-92yEKTzMCbPShyToONJWSc2KITti2CgoM0clOeFMUosJm76y_2MA",
        }),
      ),
    ).rejects.toThrow(/Raw xAI authorization codes are not accepted/);

    expect(
      progress.some((message) => /complete redirect URL/.test(message)),
    ).toBe(true);
    expect(fixture.exchanges).toHaveLength(0);
  });

  it.each([
    ["wrong", "code=bad&state=wrong", /matching OAuth state/],
    ["missing", "code=bad", /missing the matching OAuth state/],
  ])(
    "ignores %s pasted state and later accepts the matching HTTP callback",
    async (_label, pasted, notice) => {
      const fixture = browserFixture();
      const progress: string[] = [];
      const oauth = createXaiOAuth({ getExistingCredentials: () => null });
      const controller = new AbortController();
      let callbackDriver = Promise.resolve();

      const login = oauth.login(
        callbacks({
          signal: controller.signal,
          onProgress: (message: string) => progress.push(message),
          onAuth(auth: any) {
            fixture.authUrl = new URL(auth.url);
            callbackDriver = trackDriver(
              controller,
              (async () => {
                await vi.waitFor(() => {
                  expect(progress.some((message) => notice.test(message))).toBe(true);
                });
                const good = new URL(
                  fixture.authUrl!.searchParams.get("redirect_uri")!,
                );
                good.searchParams.set("code", "fallback-good");
                good.searchParams.set(
                  "state",
                  fixture.authUrl!.searchParams.get("state")!,
                );
                await nativeFetch(good);
              })(),
            );
          },
          onManualCodeInput: async () => pasted,
        }),
      );

      const credentials = await login;
      await callbackDriver;
      expect(credentials.access).toBe("access-fallback-good");
      expect(progress.some((message) => notice.test(message))).toBe(true);
      expect(fixture.exchanges.map(({ code }) => code)).toEqual([
        "fallback-good",
      ]);
    },
  );

  it("redacts authorization and token endpoint error details", async () => {
    const authFixture = browserFixture();
    const oauth = createXaiOAuth({ getExistingCredentials: () => null });
    const authError = await oauth
      .login(
        callbacks({
          onAuth(auth: any) {
            authFixture.authUrl = new URL(auth.url);
          },
          onManualCodeInput: async () =>
            `error=AUTHORIZATION_SECRET&state=${authFixture.authUrl?.searchParams.get("state")}`,
        }),
      )
      .then(
        () => undefined,
        (error: Error) => error,
      );
    expect(authError?.message).toBe("xAI authorization failed");
    expect(authError?.message).not.toContain("AUTHORIZATION_SECRET");
    expect(authFixture.exchanges).toHaveLength(0);

    vi.unstubAllGlobals();
    const tokenFixture = browserFixture(400, {
      error_description: "TOKEN_SECRET",
    });
    const tokenError = await oauth
      .login(
        callbacks({
          onAuth(auth: any) {
            tokenFixture.authUrl = new URL(auth.url);
          },
          onManualCodeInput: async () =>
            `code=bad-token&state=${tokenFixture.authUrl?.searchParams.get("state")}`,
        }),
      )
      .then(
        () => undefined,
        (error: Error) => error,
      );
    expect(tokenError?.message).toMatch(/status 400/);
    expect(tokenError?.message).not.toContain("TOKEN_SECRET");
  });

  it.each([
    ["refresh token", { refresh_token: "" }, /did not include a refresh token/],
    ["ID token", { id_token: "" }, /did not include an ID token/],
  ] as const)(
    "rejects an authorization-code response that omits a %s",
    async (_label, tokenBody, message) => {
      const fixture = browserFixture(200, tokenBody);
      const error = await createXaiOAuth({ getExistingCredentials: () => null })
        .login(
          callbacks({
            onAuth(auth: any) {
              fixture.authUrl = new URL(auth.url);
            },
            onManualCodeInput: async () =>
              `code=incomplete&state=${fixture.authUrl?.searchParams.get("state")}`,
          }),
        )
        .then(
          () => undefined,
          (value: Error) => value,
        );
      expect(error?.message).toMatch(message);
    },
  );
});
