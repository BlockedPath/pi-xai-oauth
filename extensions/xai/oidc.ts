import { createPublicKey, verify as verifySignature, webcrypto } from "crypto";
import {
  XAI_OAUTH_AUTHORIZATION_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_ID_TOKEN_ALGORITHM,
  XAI_OAUTH_ISSUER,
  XAI_OAUTH_JWKS_URL,
  XAI_OAUTH_PKCE_METHOD,
  XAI_OAUTH_TOKEN_URL,
} from "./constants";
import { requestXaiOAuthJson } from "./oauth-http";

const ID_TOKEN_CLOCK_SKEW_SECONDS = 60;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type XaiOidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported: string[];
  code_challenge_methods_supported: string[];
};

type XaiIdTokenHeader = {
  alg?: unknown;
  kid?: unknown;
  crit?: unknown;
  jku?: unknown;
  jwk?: unknown;
  x5u?: unknown;
};

type XaiIdTokenClaims = {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  iat?: unknown;
  nonce?: unknown;
};

type XaiJwk = {
  kty?: unknown;
  crv?: unknown;
  use?: unknown;
  alg?: unknown;
  kid?: unknown;
  x?: unknown;
  y?: unknown;
  d?: unknown;
  key_ops?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePinnedMetadataValue(
  metadata: Record<string, unknown>,
  field: string,
  expected: string,
  label: string,
): string {
  if (metadata[field] !== expected) {
    throw new Error(`xAI OIDC discovery ${label} did not match the pinned first-party value`);
  }
  return expected;
}

/** Validate xAI OIDC metadata against the package's pinned first-party policy. */
export function validateXaiDiscovery(metadata: unknown): XaiOidcDiscovery {
  if (!isRecord(metadata)) {
    throw new Error("xAI OIDC discovery returned an invalid document");
  }

  const issuer = requirePinnedMetadataValue(metadata, "issuer", XAI_OAUTH_ISSUER, "issuer");
  const authorizationEndpoint = requirePinnedMetadataValue(
    metadata,
    "authorization_endpoint",
    XAI_OAUTH_AUTHORIZATION_URL,
    "authorization endpoint",
  );
  const tokenEndpoint = requirePinnedMetadataValue(metadata, "token_endpoint", XAI_OAUTH_TOKEN_URL, "token endpoint");
  const jwksUri = requirePinnedMetadataValue(metadata, "jwks_uri", XAI_OAUTH_JWKS_URL, "JWKS endpoint");

  const signingAlgorithms = metadata.id_token_signing_alg_values_supported;
  if (!Array.isArray(signingAlgorithms) || !signingAlgorithms.includes(XAI_OAUTH_ID_TOKEN_ALGORITHM)) {
    throw new Error(`xAI OIDC discovery did not advertise ${XAI_OAUTH_ID_TOKEN_ALGORITHM} ID-token signing`);
  }

  const pkceMethods = metadata.code_challenge_methods_supported;
  if (!Array.isArray(pkceMethods) || !pkceMethods.includes(XAI_OAUTH_PKCE_METHOD)) {
    throw new Error(`xAI OIDC discovery did not advertise ${XAI_OAUTH_PKCE_METHOD} PKCE`);
  }

  return {
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    jwks_uri: jwksUri,
    id_token_signing_alg_values_supported: [XAI_OAUTH_ID_TOKEN_ALGORITHM],
    code_challenge_methods_supported: [XAI_OAUTH_PKCE_METHOD],
  };
}

/** Fetch and validate xAI's pinned OpenID Provider metadata. */
export async function discoverXaiOidc(signal?: AbortSignal): Promise<XaiOidcDiscovery> {
  return validateXaiDiscovery(await requestXaiOAuthJson({ kind: "discovery", signal }));
}

function decodeJwtJson(segment: string, label: string): Record<string, unknown> {
  if (!BASE64URL_PATTERN.test(segment)) {
    throw new Error(`xAI ID token ${label} was not valid base64url`);
  }

  try {
    const decoded = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    if (!isRecord(decoded)) throw new Error("not an object");
    return decoded;
  } catch {
    throw new Error(`xAI ID token ${label} was not valid JSON`);
  }
}

function decodeBase64UrlBytes(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    throw new Error(`xAI JWKS ${label} was invalid`);
  }
  return Buffer.from(value, "base64url");
}

async function fetchXaiJwks(discovery: XaiOidcDiscovery, signal?: AbortSignal): Promise<XaiJwk[]> {
  if (discovery.jwks_uri !== XAI_OAUTH_JWKS_URL || discovery.issuer !== XAI_OAUTH_ISSUER) {
    throw new Error("xAI JWKS request was not bound to the pinned issuer");
  }

  const document = await requestXaiOAuthJson({ kind: "jwks", signal });
  if (
    !isRecord(document) ||
    !Array.isArray(document.keys) ||
    document.keys.length === 0 ||
    document.keys.length > 100 ||
    !document.keys.every(isRecord)
  ) {
    throw new Error("xAI JWKS returned an invalid key set");
  }
  return document.keys;
}

function selectSigningKey(keys: XaiJwk[], kid: string): XaiJwk {
  const matches = keys.filter((key) => key.kid === kid);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? "xAI ID token used an unknown signing key" : "xAI JWKS contained an ambiguous signing key");
  }

  const key = matches[0];
  if (
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    (key.use !== undefined && key.use !== "sig") ||
    (key.alg !== undefined && key.alg !== XAI_OAUTH_ID_TOKEN_ALGORITHM) ||
    key.d !== undefined ||
    (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify")))
  ) {
    throw new Error("xAI ID token signing key did not match the required ES256 public-key policy");
  }

  if (decodeBase64UrlBytes(key.x, "x coordinate").length !== 32 || decodeBase64UrlBytes(key.y, "y coordinate").length !== 32) {
    throw new Error("xAI ID token signing key had invalid P-256 coordinates");
  }
  return key;
}

function validateIdTokenClaims(claims: XaiIdTokenClaims, expectedNonce: string, nowSeconds: number): void {
  if (claims.iss !== XAI_OAUTH_ISSUER) {
    throw new Error("xAI ID token issuer did not match the pinned issuer");
  }

  if (
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.sub.length > 255 ||
    !/^[\x20-\x7e]+$/.test(claims.sub)
  ) {
    throw new Error("xAI ID token subject was invalid");
  }

  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (
    !Array.isArray(audiences) ||
    audiences.length === 0 ||
    audiences.some((audience) => typeof audience !== "string") ||
    !audiences.includes(XAI_OAUTH_CLIENT_ID)
  ) {
    throw new Error("xAI ID token audience did not match this OAuth client");
  }
  if (
    (audiences.length > 1 && claims.azp !== XAI_OAUTH_CLIENT_ID) ||
    (claims.azp !== undefined && claims.azp !== XAI_OAUTH_CLIENT_ID)
  ) {
    throw new Error("xAI ID token authorized party did not match this OAuth client");
  }

  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new Error("xAI ID token expiry was invalid");
  }
  if (nowSeconds >= claims.exp + ID_TOKEN_CLOCK_SKEW_SECONDS) {
    throw new Error("xAI ID token has expired");
  }
  if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) {
    throw new Error("xAI ID token issued-at time was invalid");
  }
  if (claims.iat > nowSeconds + ID_TOKEN_CLOCK_SKEW_SECONDS) {
    throw new Error("xAI ID token was issued in the future");
  }
  if (claims.nonce !== expectedNonce) {
    throw new Error("xAI ID token nonce did not match this login attempt");
  }
}

/** Validate and verify a fresh-login xAI ID token before it is retained. */
export async function validateXaiIdToken(
  idToken: string,
  discovery: XaiOidcDiscovery,
  expectedNonce: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!idToken || !expectedNonce) {
    throw new Error("xAI token response did not include a verifiable ID token");
  }
  if (
    discovery.issuer !== XAI_OAUTH_ISSUER ||
    discovery.jwks_uri !== XAI_OAUTH_JWKS_URL ||
    discovery.id_token_signing_alg_values_supported.length !== 1 ||
    discovery.id_token_signing_alg_values_supported[0] !== XAI_OAUTH_ID_TOKEN_ALGORITHM
  ) {
    throw new Error("xAI ID token validation was not bound to trusted discovery metadata");
  }

  const segments = idToken.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    throw new Error("xAI ID token was not a compact signed JWT");
  }

  const [encodedHeader, encodedClaims, encodedSignature] = segments;
  const header = decodeJwtJson(encodedHeader, "header") as XaiIdTokenHeader;
  const claims = decodeJwtJson(encodedClaims, "claims") as XaiIdTokenClaims;
  if (header.alg !== XAI_OAUTH_ID_TOKEN_ALGORITHM) {
    throw new Error(`xAI ID token did not use ${XAI_OAUTH_ID_TOKEN_ALGORITHM}`);
  }
  if (typeof header.kid !== "string" || !header.kid) {
    throw new Error("xAI ID token did not identify a signing key");
  }
  if (header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) {
    throw new Error("xAI ID token used unsupported JOSE header parameters");
  }

  if (!BASE64URL_PATTERN.test(encodedSignature)) {
    throw new Error("xAI ID token signature was not valid base64url");
  }
  const signature = Buffer.from(encodedSignature, "base64url");
  if (signature.length !== 64) {
    throw new Error("xAI ID token signature had an invalid ES256 length");
  }

  const signingKey = selectSigningKey(await fetchXaiJwks(discovery, signal), header.kid);
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: signingKey.x as string,
        y: signingKey.y as string,
      } as webcrypto.JsonWebKey,
      format: "jwk",
    });
  } catch {
    throw new Error("xAI ID token signing key could not be imported");
  }

  const validSignature = verifySignature(
    "sha256",
    Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    signature,
  );
  if (!validSignature) {
    throw new Error("xAI ID token signature was invalid");
  }

  validateIdTokenClaims(claims, expectedNonce, Math.floor(Date.now() / 1000));
}
