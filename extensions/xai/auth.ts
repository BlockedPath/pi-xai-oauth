import type { OAuthCredentials } from "@earendil-works/pi-ai";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  DEFAULT_XAI_MODEL,
  XAI_BUNDLED_PROVIDER_ID,
  XAI_GROK_CLI_AUTH_SCOPE_KEY,
  XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY,
  XAI_OAUTH_ISSUER,
  XAI_OAUTH_REFRESH_SKEW_MS,
  XAI_PROVIDER_ID,
  XAI_TOOL_COMPATIBLE_PROVIDER_IDS,
  isXaiToolCompatibleProvider,
  type XaiToolCompatibleProviderId,
} from "./constants";
import { getXaiRuntimeModels } from "./models";
import { ensureFreshXaiCredentials } from "./oauth";
import type { XaiCredential } from "./routing";

function readPiStoredCredential(providerId: string, authPath: string): any {
  const codingAgent = PiCodingAgent as any;
  if (typeof codingAgent.readStoredCredential === "function") {
    return codingAgent.readStoredCredential(providerId, authPath);
  }
  try {
    return JSON.parse(readFileSync(authPath, "utf8"))?.[providerId];
  } catch {
    return undefined;
  }
}

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Load reusable OAuth credentials from the official Grok CLI auth file. */
export function getGrokAuthCredentials(): OAuthCredentials | null {
  const authPath = join(homedir(), ".grok", "auth.json");
  if (!existsSync(authPath)) return null;

  try {
    const data = JSON.parse(readFileSync(authPath, "utf8"));

    // Official Grok CLI stores OAuth2 credentials under
    // "https://auth.x.ai::<client_id>" as { key, refresh_token, expires_at }.
    const oidc = data?.[XAI_GROK_CLI_AUTH_SCOPE_KEY];
    if (oidc && typeof oidc === "object") {
      const access = String(oidc.key || oidc.access_token || oidc.token || "");
      if (access) {
        const expires = parseExpiry(oidc.expires_at) || Date.now() + 6 * 60 * 60 * 1000;
        return {
          refresh: String(oidc.refresh_token || oidc.refresh || ""),
          access,
          expires: expires - XAI_OAUTH_REFRESH_SKEW_MS,
          tokenEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/token`,
          tokenType: "Bearer",
        };
      }
    }

    // Older Grok builds stored a bearer at the sign-in URL scope.
    const legacy = data?.[XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY];
    const legacyAccess = legacy && typeof legacy === "object" ? legacy.key || legacy.access_token || legacy.token : "";
    if (legacyAccess) {
      return {
        refresh: "",
        access: String(legacyAccess),
        expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
      };
    }

    // Back-compat with early pi-xai-oauth guesses.
    const topLevelAccess = data?.access_token || data?.token;
    if (topLevelAccess) {
      return {
        refresh: String(data.refresh_token || data.refresh || ""),
        access: String(topLevelAccess),
        expires: parseExpiry(data.expires_at || data.expires) || Date.now() + 30 * 24 * 60 * 60 * 1000,
        tokenEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/token`,
        tokenType: String(data.token_type || "Bearer"),
      };
    }
  } catch {
    return null;
  }

  return null;
}

export interface StartupXaiCatalogAuth {
  credential: { access: string } | null;
  /** True when pi has an expired stored OAuth token that session_start should refresh under pi's credential lock. */
  needsRegistryRefresh: boolean;
  credentialChangedAt?: number;
}

/**
 * Resolve a fresh startup-only OAuth bearer without refreshing or modifying
 * pi's credential store. Expired pi credentials still defer lock-protected
 * refresh to the bound model registry, while a fresh official Grok CLI bearer
 * may be reused read-only for startup catalog selection.
 */
export function getStartupXaiCatalogAuth(now = Date.now()): StartupXaiCatalogAuth {
  let needsRegistryRefresh = false;
  let credentialChangedAt: number | undefined;
  try {
    const authPath = join(getAgentDir(), "auth.json");
    const stored = readPiStoredCredential(XAI_PROVIDER_ID, authPath);
    credentialChangedAt = existsSync(authPath) ? statSync(authPath).mtimeMs : undefined;
    if (stored?.type === "oauth" && typeof stored.access === "string" && stored.access) {
      if (typeof stored.expires === "number" && stored.expires > now) {
        return { credential: { access: stored.access }, needsRegistryRefresh: false, credentialChangedAt };
      }
      needsRegistryRefresh = true;
    }
  } catch {
    // Fall through to read-only official Grok CLI credential reuse.
  }

  const grok = getGrokAuthCredentials();
  if (grok?.access && typeof grok.expires === "number" && grok.expires > now) {
    const grokPath = join(homedir(), ".grok", "auth.json");
    const grokChangedAt = existsSync(grokPath) ? statSync(grokPath).mtimeMs : undefined;
    const changedAt =
      typeof credentialChangedAt === "number" && typeof grokChangedAt === "number"
        ? Math.max(credentialChangedAt, grokChangedAt)
        : grokChangedAt ?? credentialChangedAt;
    return {
      credential: { access: grok.access },
      needsRegistryRefresh,
      credentialChangedAt: changedAt,
    };
  }
  return { credential: null, needsRegistryRefresh, credentialChangedAt };
}

/**
 * Providers to consult for managed credential resolution.
 *
 * When the active model is already an xAI-compatible provider, stay on that
 * provider only. Falling through to the sibling provider would silently reuse
 * another account's credential for network tools / usage and can mis-tag
 * `catalogScope: "host"` onto package `xai-auth` OAuth.
 *
 * Without an active compatible provider, keep scanning both for callers that
 * only supply a registry.
 */
function xaiRegistryProviderIds(ctx: any): XaiToolCompatibleProviderId[] {
  if (isXaiToolCompatibleProvider(ctx?.model?.provider)) {
    return [ctx.model.provider];
  }
  return [...XAI_TOOL_COMPATIBLE_PROVIDER_IDS];
}

function xaiRegistryCandidateIds(ctx: any, providerId: XaiToolCompatibleProviderId): string[] {
  return [
    ctx?.model?.provider === providerId ? ctx.model.id : undefined,
    DEFAULT_XAI_MODEL,
    ...getXaiRuntimeModels().map((model) => model.id),
  ].filter(
    (id, index, values): id is string =>
      typeof id === "string" && !!id && values.indexOf(id) === index,
  );
}

type LegacyStoredAuth =
  | { state: "unavailable" | "missing" | "non-oauth" }
  | { state: "oauth"; access: string };

function legacyStoredAuth(registry: any, providerId: XaiToolCompatibleProviderId): LegacyStoredAuth {
  if (typeof registry?.authStorage?.get !== "function") return { state: "unavailable" };
  try {
    const stored = registry.authStorage.get(providerId);
    if (stored === undefined) return { state: "missing" };
    return stored?.type === "oauth"
      && typeof stored.access === "string"
      && stored.access
      ? { state: "oauth", access: stored.access }
      : { state: "non-oauth" };
  } catch {
    return { state: "non-oauth" };
  }
}

function hasRuntimeApiKeyOverride(registry: any, providerId: XaiToolCompatibleProviderId): boolean {
  if (typeof registry?.getProviderAuthStatus !== "function") return false;
  try {
    return registry.getProviderAuthStatus(providerId)?.source === "runtime";
  } catch {
    return true;
  }
}

function registryModelUsesOAuth(
  registry: any,
  providerId: XaiToolCompatibleProviderId,
  model: any,
): boolean {
  try {
    if (registry.isUsingOAuth(model) !== true) return false;
    const stored = legacyStoredAuth(registry, providerId);
    if (stored.state !== "unavailable") return stored.state === "oauth";
    if (typeof registry.getProviderAuthStatus !== "function") return false;
    const status = registry.getProviderAuthStatus(providerId);
    return status?.configured === true && status.source === "stored";
  } catch {
    return false;
  }
}

function providerHasNonOAuthCredential(
  registry: any,
  providerId: XaiToolCompatibleProviderId,
  models: readonly any[],
): boolean {
  if (hasRuntimeApiKeyOverride(registry, providerId)) return true;
  const stored = legacyStoredAuth(registry, providerId);
  if (stored.state === "non-oauth") return true;
  if (stored.state === "oauth") return false;
  if (typeof registry?.getProviderAuthStatus !== "function") return false;
  try {
    const status = registry.getProviderAuthStatus(providerId);
    return status?.configured === true
      && !models.some((model) => registryModelUsesOAuth(registry, providerId, model));
  } catch {
    return true;
  }
}

function credentialFromResolvedAuth(
  auth: any,
  kind: XaiCredential["kind"] = "oauth-session",
): XaiCredential | null {
  if (auth?.ok && typeof auth.apiKey === "string" && auth.apiKey) {
    return { kind, token: auth.apiKey };
  }
  const authorization =
    auth?.ok && typeof auth.headers?.Authorization === "string"
      ? auth.headers.Authorization
      : "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? { kind, token: authorization.slice("bearer ".length) }
    : null;
}

/**
 * Normalize a ModelRuntime.getAuth / getProviderAuth resolution into the stable
 * extension request-auth shape used by credential helpers.
 */
function requestAuthFromResolution(
  resolution: any,
  providerId = XAI_PROVIDER_ID,
): { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string } {
  if (!resolution?.auth) {
    return { ok: false, error: `No API key found for "${providerId}"` };
  }
  return {
    ok: true,
    apiKey: typeof resolution.auth.apiKey === "string" ? resolution.auth.apiKey : undefined,
    headers: resolution.auth.headers,
  };
}

function resolveAuthRuntime(registry: any, modelRuntime?: any): any | undefined {
  if (modelRuntime && typeof modelRuntime.getAuth === "function") return modelRuntime;
  if (registry && typeof registry.getAuth === "function") return registry;
  if (registry?.modelRuntime && typeof registry.modelRuntime.getAuth === "function") {
    return registry.modelRuntime;
  }
  if (registry?.runtime && typeof registry.runtime.getAuth === "function") {
    return registry.runtime;
  }
  return undefined;
}

/**
 * Resolve request auth preferring ModelRuntime.getAuth when the host exposes it.
 *
 * Extension event contexts historically only supply `ctx.modelRegistry`. On
 * Pi 0.80.8+, that registry projects `ModelRuntime.getAuth` through
 * `getApiKeyAndHeaders` / `getProviderAuth`. Prefer an explicit runtime
 * `getAuth` surface when present (including future `ctx.modelRuntime`), then
 * the registry projections so the 0.80.1 packed boundary keeps working.
 */
export async function resolveRegistryRequestAuth(
  registry: any,
  model?: any,
  modelRuntime?: any,
): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string } | null> {
  const runtime = resolveAuthRuntime(registry, modelRuntime);
  if (runtime) {
    try {
      return requestAuthFromResolution(
        await runtime.getAuth(model ?? XAI_PROVIDER_ID),
        typeof model?.provider === "string" ? model.provider : XAI_PROVIDER_ID,
      );
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (model && typeof registry?.getApiKeyAndHeaders === "function") {
    return await registry.getApiKeyAndHeaders(model);
  }
  if (typeof registry?.getProviderAuth === "function") {
    try {
      const providerId = typeof model?.provider === "string" ? model.provider : XAI_PROVIDER_ID;
      return requestAuthFromResolution(await registry.getProviderAuth(providerId), providerId);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return null;
}

function registrySupportsRequestAuth(registry: any, modelRuntime?: any): boolean {
  return !!resolveAuthRuntime(registry, modelRuntime)
    || typeof registry?.getApiKeyAndHeaders === "function"
    || typeof registry?.getProviderAuth === "function";
}

/** Resolve a tagged xAI credential through pi's managed model registry. */
export async function resolvePiManagedXaiCredential(ctx: any): Promise<XaiCredential | null> {
  const registry = ctx?.modelRegistry;
  const modelRuntime = ctx?.modelRuntime;
  if (typeof registry?.find !== "function" || !registrySupportsRequestAuth(registry, modelRuntime)) {
    return null;
  }
  for (const providerId of xaiRegistryProviderIds(ctx)) {
    for (const modelId of xaiRegistryCandidateIds(ctx, providerId)) {
      const registryModel = registry.find(providerId, modelId);
      if (!registryModel) continue;
      const auth = await resolveRegistryRequestAuth(registry, registryModel, modelRuntime);
      const kind = providerId === XAI_BUNDLED_PROVIDER_ID
        && !registryModelUsesOAuth(registry, providerId, registryModel)
        ? "api-key"
        : "oauth-session";
      const credential = credentialFromResolvedAuth(auth, kind);
      if (credential) {
        // Host catalog scope follows the credential's provider, not merely the
        // active model id — otherwise a cross-provider token could skip package
        // entitlement checks while riding the built-in model surface.
        return kind === "oauth-session" && providerId === XAI_BUNDLED_PROVIDER_ID
          ? { ...credential, catalogScope: "host" }
          : credential;
      }
    }
  }
  return null;
}

/**
 * Resolve only a Pi-stored xAI OAuth bearer, rejecting API-key credentials and
 * runtime API-key overrides even when Pi's generic request resolver returns one.
 */
export async function resolvePiManagedXaiOAuthCredential(ctx: any): Promise<XaiCredential | null> {
  const registry = ctx?.modelRegistry;
  const modelRuntime = ctx?.modelRuntime;
  if (
    typeof registry?.find !== "function"
    || !registrySupportsRequestAuth(registry, modelRuntime)
    || typeof registry?.isUsingOAuth !== "function"
  ) {
    return null;
  }
  for (const providerId of xaiRegistryProviderIds(ctx)) {
    const registryModels = xaiRegistryCandidateIds(ctx, providerId)
      .map((modelId) => registry.find(providerId, modelId))
      .filter(Boolean);
    if (registryModels.length === 0) continue;
    const activeProvider = ctx?.model?.provider === providerId;
    if (providerHasNonOAuthCredential(registry, providerId, registryModels)) {
      if (activeProvider) return null;
      continue;
    }
    for (const registryModel of registryModels) {
      if (!registryModelUsesOAuth(registry, providerId, registryModel)) continue;
      const storedBefore = legacyStoredAuth(registry, providerId);
      const credential = credentialFromResolvedAuth(
        await resolveRegistryRequestAuth(registry, registryModel, modelRuntime),
      );
      const storedAfter = legacyStoredAuth(registry, providerId);
      const storedCredentialMatches = storedAfter.state === "unavailable"
        || (storedAfter.state === "oauth" && credential?.token === storedAfter.access);
      if (
        credential
        && !hasRuntimeApiKeyOverride(registry, providerId)
        && registryModelUsesOAuth(registry, providerId, registryModel)
        && storedBefore.state !== "non-oauth"
        && storedBefore.state !== "missing"
        && storedCredentialMatches
      ) {
        return credential;
      }
    }
  }
  return null;
}

/**
 * Return whether Pi currently identifies an xAI registry model as stored OAuth.
 *
 * This uses the public registry facade available across Pi 0.80.1–0.81.1.
 */
export function hasPiManagedXaiOAuth(ctx: any): boolean {
  const registry = ctx?.modelRegistry;
  if (typeof registry?.find !== "function" || typeof registry?.isUsingOAuth !== "function") {
    return false;
  }
  for (const providerId of xaiRegistryProviderIds(ctx)) {
    const registryModels = xaiRegistryCandidateIds(ctx, providerId)
      .map((modelId) => registry.find(providerId, modelId))
      .filter(Boolean);
    if (registryModels.length === 0) continue;
    const activeProvider = ctx?.model?.provider === providerId;
    if (providerHasNonOAuthCredential(registry, providerId, registryModels)) {
      if (activeProvider) return false;
      continue;
    }
    if (registryModels.some((model) => registryModelUsesOAuth(registry, providerId, model))) {
      return true;
    }
  }
  return false;
}

/** Resolve a tagged xAI OAuth credential from pi context or reusable Grok CLI credentials. */
export async function resolveXaiCredential(ctx: any): Promise<XaiCredential | null> {
  const managedCredential = await resolvePiManagedXaiCredential(ctx);
  if (managedCredential) return managedCredential;
  if (ctx?.apiKey) {
    return {
      kind: ctx?.model?.provider === XAI_BUNDLED_PROVIDER_ID ? "api-key" : "oauth-session",
      token: ctx.apiKey,
    };
  }

  const credentials = getGrokAuthCredentials();
  if (!credentials?.access) return null;
  const credential: XaiCredential = {
    kind: "oauth-session",
    token: (await ensureFreshXaiCredentials(credentials)).access,
  };
  return ctx?.model?.provider === XAI_BUNDLED_PROVIDER_ID
    ? { ...credential, catalogScope: "host" }
    : credential;
}
