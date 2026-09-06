import { composeTimeoutSignal } from "./abort";
import { readBoundedResponseText } from "./bounded-body";
import {
  commitXaiCatalogCache,
  defaultXaiCatalogCachePath,
  invalidateXaiCatalogCache,
  readXaiCatalogCache,
  XaiCatalogCancelledError,
} from "./catalog/cache";
import {
  normalizeXaiCatalogPayload,
  XaiCatalogValidationError,
} from "./catalog/model-codec";
import {
  XAI_CLI_MODELS_URL,
  XAI_MODEL_CATALOG_FRESH_TTL_MS,
  XAI_MODEL_CATALOG_MAX_BYTES,
  XAI_MODEL_CATALOG_TIMEOUT_MS,
} from "./constants";
import {
  cloneXaiCatalogModels,
  CURATED_FALLBACK_MODELS,
  type XaiCatalogModel,
} from "./models";
import { xaiCatalogHeaders } from "./wire";

export {
  defaultXaiCatalogCachePath,
  normalizeXaiCatalogPayload,
  XaiCatalogCancelledError,
  XaiCatalogValidationError,
};

export type XaiCatalogSource = "remote" | "fresh-cache" | "stale-cache" | "curated-fallback";

export interface XaiCatalogSelection {
  models: XaiCatalogModel[];
  source: XaiCatalogSource;
  /** True when session_start can safely ask pi's registry to refresh an expired stored credential. */
  needsAuthenticatedRefresh: boolean;
}

export interface XaiCatalogCredential {
  access: string;
}

export interface XaiCatalogOptions {
  credential?: XaiCatalogCredential | null;
  forceRefresh?: boolean;
  signal?: AbortSignal;
  cachePath?: string;
  now?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Set when pi has stored OAuth credentials that must be refreshed under its registry lock. */
  refreshWhenCredentialsAvailable?: boolean;
  /** Modification time of pi's credential store; newer-than-cache credentials force discovery. */
  credentialChangedAt?: number;
  /** Runtime ownership guard checked immediately before an atomic cache commit. */
  commitAllowed?: () => boolean;
}

type FetchOutcome =
  | { kind: "success"; models: XaiCatalogModel[] }
  | { kind: "auth" | "permanent" | "transient" | "invalid-success" | "cancelled" };

function fallbackSelection(needsAuthenticatedRefresh: boolean): XaiCatalogSelection {
  return {
    models: cloneXaiCatalogModels(CURATED_FALLBACK_MODELS),
    source: "curated-fallback",
    needsAuthenticatedRefresh,
  };
}

/** Fetch and normalize the authenticated OAuth-visible catalog from the pinned proxy. */
export async function fetchXaiModelCatalog(
  credential: XaiCatalogCredential,
  options: Pick<XaiCatalogOptions, "signal" | "fetchImpl" | "timeoutMs"> = {},
): Promise<FetchOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const abort = composeTimeoutSignal(options.signal, options.timeoutMs ?? XAI_MODEL_CATALOG_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(XAI_CLI_MODELS_URL, {
        method: "GET",
        headers: xaiCatalogHeaders(credential.access),
        redirect: "error",
        signal: abort.signal,
      });
    } catch {
      return { kind: options.signal?.aborted ? "cancelled" : "transient" };
    }

    if (options.signal?.aborted) return { kind: "cancelled" };
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) return { kind: "auth" };
      if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
        return { kind: "transient" };
      }
      return { kind: "permanent" };
    }

    try {
      const body = await readBoundedResponseText(response, {
        maxBytes: XAI_MODEL_CATALOG_MAX_BYTES,
        overflowError: () => new XaiCatalogValidationError(),
      });
      if (options.signal?.aborted) return { kind: "cancelled" };
      const models = normalizeXaiCatalogPayload(JSON.parse(body));
      if (options.signal?.aborted) return { kind: "cancelled" };
      return { kind: "success", models };
    } catch {
      return { kind: options.signal?.aborted ? "cancelled" : "invalid-success" };
    }
  } finally {
    abort.dispose();
  }
}

/**
 * Select a startup/login catalog from fresh cache, authenticated discovery,
 * stale-if-transient last-known-good data, or the curated fallback.
 */
export async function selectXaiModelCatalog(options: XaiCatalogOptions = {}): Promise<XaiCatalogSelection> {
  const now = options.now ?? Date.now();
  const cachePath = options.cachePath ?? defaultXaiCatalogCachePath();
  const cache = await readXaiCatalogCache(cachePath, now);
  const forceRefresh = options.forceRefresh === true;

  const refreshWhenCredentialsAvailable = options.refreshWhenCredentialsAvailable === true;
  if (!options.credential?.access && !refreshWhenCredentialsAvailable) {
    return fallbackSelection(false);
  }
  const credentialsChanged =
    typeof options.credentialChangedAt === "number" &&
    Number.isFinite(options.credentialChangedAt) &&
    !!cache &&
    options.credentialChangedAt > cache.fetchedAt;
  if (!forceRefresh && !credentialsChanged && cache && now - cache.fetchedAt < XAI_MODEL_CATALOG_FRESH_TTL_MS) {
    return {
      models: cloneXaiCatalogModels(cache.models),
      source: "fresh-cache",
      needsAuthenticatedRefresh: refreshWhenCredentialsAvailable,
    };
  }
  if (!options.credential?.access) return fallbackSelection(refreshWhenCredentialsAvailable);

  const commitAllowed = () => !options.signal?.aborted && options.commitAllowed?.() !== false;
  const outcome = await fetchXaiModelCatalog(options.credential, options);
  if (outcome.kind === "cancelled" || !commitAllowed()) {
    throw new XaiCatalogCancelledError();
  }
  if (outcome.kind === "success") {
    const commit = await commitXaiCatalogCache({
      cachePath,
      now,
      models: outcome.models,
      previous: cache,
      commitAllowed,
    });
    if (commit === "unsafe-old-cache") return fallbackSelection(true);
    return {
      models: cloneXaiCatalogModels(outcome.models),
      source: "remote",
      needsAuthenticatedRefresh: refreshWhenCredentialsAvailable,
    };
  }

  if (!commitAllowed()) throw new XaiCatalogCancelledError();
  if (outcome.kind === "auth" || outcome.kind === "permanent") {
    await invalidateXaiCatalogCache({ cachePath, now, commitAllowed, previous: cache });
    return fallbackSelection(false);
  }
  if (forceRefresh) {
    // Forced refresh never reuses stale account data, but transient failures
    // remain retryable once pi has a bound, lock-refreshed credential.
    await invalidateXaiCatalogCache({ cachePath, now, commitAllowed, previous: cache });
    return fallbackSelection(true);
  }
  if (cache) {
    return { models: cloneXaiCatalogModels(cache.models), source: "stale-cache", needsAuthenticatedRefresh: false };
  }
  return fallbackSelection(true);
}
