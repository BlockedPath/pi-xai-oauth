import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createXaiOAuth } from "../../extensions/xai/oauth";
import {
  discoverXaiOidc,
  validateXaiDiscovery,
  validateXaiIdToken,
} from "../../extensions/xai/oidc";
import { discovery, OIDC_PUBLIC_JWK, signIdToken } from "../fixtures/oauth";
import { jsonResponse } from "../fixtures/http";

const nonce = "expected-nonce";
afterEach(() => vi.useRealTimers());

describe("pinned OIDC discovery", () => {
  it("fetches the pinned document without redirects", async () => {
    const fetchMock = vi.fn(async (..._args: any[]) =>
      jsonResponse(discovery()),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(discoverXaiOidc()).resolves.toEqual(discovery());
    const firstCall = fetchMock.mock.calls[0] as any[];
    expect(firstCall[0]).toBe(
      "https://auth.x.ai/.well-known/openid-configuration",
    );
    expect(firstCall[1]).toMatchObject({ redirect: "error" });
  });
  it("bounds the discovery response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ...discovery(), padding: "x".repeat(70 * 1024) })));
    await expect(discoverXaiOidc()).rejects.toThrow(/too large/);
  });
  it("times out a stalled discovery request without a caller signal", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>(() => {})));
    const result = Promise.race([
      discoverXaiOidc().then(() => "resolved", () => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 15_001)),
    ]);
    await vi.advanceTimersByTimeAsync(15_001);
    await expect(result).resolves.toBe("rejected");
  });
  it.each([
    ["issuer", { issuer: "https://auth.x.ai/" }, /issuer did not match/],
    [
      "authorization endpoint",
      { authorization_endpoint: "https://accounts.x.ai/oauth2/authorize" },
      /authorization endpoint did not match/,
    ],
    [
      "token endpoint",
      { token_endpoint: "https://evil.x.ai/oauth2/token" },
      /token endpoint did not match/,
    ],
    [
      "JWKS endpoint",
      { jwks_uri: "https://evil.x.ai/jwks" },
      /JWKS endpoint did not match/,
    ],
    [
      "algorithm",
      { id_token_signing_alg_values_supported: ["RS256"] },
      /ES256 ID-token signing/,
    ],
    ["PKCE", { code_challenge_methods_supported: ["plain"] }, /S256 PKCE/],
  ])("rejects unpinned %s metadata", (_label, override, pattern) =>
    expect(() => validateXaiDiscovery(discovery(override))).toThrow(pattern),
  );
});

describe("OIDC policy in the browser login flow", () => {
  it.each([
    ["issuer", { issuer: "https://auth.x.ai/" }, /issuer did not match/],
    [
      "authorization endpoint",
      { authorization_endpoint: "https://accounts.x.ai/oauth2/authorize" },
      /authorization endpoint did not match/,
    ],
    [
      "token endpoint",
      { token_endpoint: "https://evil.x.ai/oauth2/token" },
      /token endpoint did not match/,
    ],
    [
      "JWKS endpoint",
      { jwks_uri: "https://evil.x.ai/jwks" },
      /JWKS endpoint did not match/,
    ],
    [
      "algorithm",
      { id_token_signing_alg_values_supported: ["RS256"] },
      /ES256 ID-token signing/,
    ],
    ["PKCE", { code_challenge_methods_supported: ["plain"] }, /S256 PKCE/],
  ])(
    "rejects invalid %s discovery before browser authorization",
    async (_label, override, pattern) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(discovery(override))),
      );
      let browserOpened = false;
      const oauth = createXaiOAuth({ getExistingCredentials: () => null });

      await expect(
        oauth.login({
          onPrompt: async () => "n",
          onProgress: () => {},
          onSelect: async () => "browser",
          onDeviceCode: () => {},
          onAuth: () => {
            browserOpened = true;
          },
        } as any),
      ).rejects.toThrow(pattern);
      expect(browserOpened).toBe(false);
    },
  );

  it.each([
    ["malformed", { id_token: "not-a-compact-jwt" }, /compact signed JWT/],
    ["missing", {}, /did not include an ID token/],
  ])(
    "rejects a %s ID token only after one matching-code exchange",
    async (_label, tokenBody, pattern) => {
      const exchanges: string[] = [];
      let manualCallback = "";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: any, init: RequestInit = {}) => {
          const url = String(input);
          if (url.endsWith("openid-configuration"))
            return jsonResponse(discovery());
          if (url.endsWith("oauth2/token")) {
            const body = Object.fromEntries(
              new URLSearchParams(String(init.body)),
            );
            exchanges.push(body.code);
            return jsonResponse({
              access_token: "access",
              refresh_token: "refresh",
              ...tokenBody,
            });
          }
          throw new Error(`Unexpected request origin: ${new URL(url).origin}`);
        }),
      );
      const oauth = createXaiOAuth({ getExistingCredentials: () => null });

      await expect(
        oauth.login({
          onPrompt: async () => "n",
          onProgress: () => {},
          onSelect: async () => "browser",
          onDeviceCode: () => {},
          onAuth(auth: any) {
            const authorizeUrl = new URL(auth.url);
            const callback = new URL(
              authorizeUrl.searchParams.get("redirect_uri")!,
            );
            callback.searchParams.set("code", `bound-${_label}`);
            callback.searchParams.set(
              "state",
              authorizeUrl.searchParams.get("state")!,
            );
            manualCallback = callback.toString();
          },
          onManualCodeInput: async () => manualCallback,
        } as any),
      ).rejects.toThrow(pattern);
      expect(exchanges).toEqual([`bound-${_label}`]);
    },
  );
});

describe("ID token validation", () => {
  async function validate(token: string, keys: any[] = [OIDC_PUBLIC_JWK]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ keys })),
    );
    return validateXaiIdToken(token, discovery(), nonce);
  }
  it("accepts a valid ES256 nonce-bound token", async () => {
    await expect(validate(signIdToken({ nonce }))).resolves.toBeUndefined();
  });
  it("bounds the JWKS response body", async () => {
    await expect(validate(signIdToken({ nonce }), [{ ...OIDC_PUBLIC_JWK, padding: "x".repeat(70 * 1024) }])).rejects.toThrow(/too large/);
  });
  it.each([
    ["issuer", { iss: "https://accounts.x.ai" }, /issuer did not match/],
    ["audience", { aud: "another-client" }, /audience did not match/],
    [
      "authorized party",
      { azp: "another-client" },
      /authorized party did not match/,
    ],
    [
      "multi-audience without azp",
      {
        aud: ["b1a00492-073a-47ea-816f-4c329264a828", "other"],
        azp: undefined,
      },
      /authorized party did not match/,
    ],
    ["nonce", { nonce: "wrong" }, /nonce did not match/],
    ["subject", { sub: undefined }, /subject was invalid/],
    ["expiry", { exp: undefined }, /expiry was invalid/],
    [
      "future issued-at",
      { iat: Math.floor(Date.now() / 1000) + 120 },
      /issued in the future/,
    ],
  ])("rejects invalid %s claims", async (_label, claims, pattern) => {
    await expect(validate(signIdToken({ nonce, claims }))).rejects.toThrow(
      pattern,
    );
  });
  it("rejects expired tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      validate(signIdToken({ nonce, now, claims: { exp: now - 120 } })),
    ).rejects.toThrow(/has expired/);
  });
  it("requires azp and accepts it for multiple audiences", async () => {
    const token = signIdToken({
      nonce,
      claims: {
        aud: ["b1a00492-073a-47ea-816f-4c329264a828", "other"],
        azp: "b1a00492-073a-47ea-816f-4c329264a828",
      },
    });
    await expect(validate(token)).resolves.toBeUndefined();
  });
  it("rejects wrong algorithms, unknown keys, and signatures", async () => {
    await expect(
      validate(signIdToken({ nonce, header: { alg: "RS256" } })),
    ).rejects.toThrow(/did not use ES256/);
    await expect(
      validate(signIdToken({ nonce, header: { kid: "unknown" } })),
    ).rejects.toThrow(/unknown signing key/);
    const wrong = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await expect(
      validate(signIdToken({ nonce, key: wrong.privateKey })),
    ).rejects.toThrow(/signature was invalid/);
  });
  it.each([
    ["wrong use", [{ ...OIDC_PUBLIC_JWK, use: "enc" }], /public-key policy/],
    [
      "wrong curve",
      [{ ...OIDC_PUBLIC_JWK, crv: "P-384" }],
      /public-key policy/,
    ],
    [
      "duplicate",
      [OIDC_PUBLIC_JWK, { ...OIDC_PUBLIC_JWK }],
      /ambiguous signing key/,
    ],
  ])("rejects %s JWK policy", async (_label, keys, pattern) => {
    await expect(validate(signIdToken({ nonce }), keys)).rejects.toThrow(
      pattern,
    );
  });
  it("allows optional JWK use and alg hints", async () => {
    const { use: _use, alg: _alg, ...key } = OIDC_PUBLIC_JWK;
    await expect(
      validate(signIdToken({ nonce }), [key]),
    ).resolves.toBeUndefined();
  });
  it.each(["not-a-jwt", "a.b", "a.b.c.d"])(
    "rejects malformed compact token %s",
    async (token) => {
      await expect(validate(token)).rejects.toThrow(
        /compact signed JWT|valid base64url|valid JSON/,
      );
    },
  );
  it("rejects discovery not bound to the pinned issuer", async () => {
    await expect(
      validateXaiIdToken(
        signIdToken({ nonce }),
        { ...discovery(), issuer: "https://evil.test" },
        nonce,
      ),
    ).rejects.toThrow(/not bound to trusted discovery/);
  });
});
