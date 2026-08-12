import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "fs/promises";
import { dirname, join } from "path";
import { composeTimeoutSignal } from "./abort";
import { readBoundedResponseText } from "./bounded-body";
import {
  XAI_CLI_MODELS_URL,
  XAI_MODEL_CATALOG_CACHE_SCHEMA,
  XAI_MODEL_CATALOG_FRESH_TTL_MS,
  XAI_MODEL_CATALOG_MAX_BYTES,
  XAI_MODEL_CATALOG_MAX_STALE_MS,
  XAI_MODEL_CATALOG_TIMEOUT_MS,
} from "./constants";
import {
  cloneXaiCatalogModels,
  CURATED_FALLBACK_MODELS,
  knownXaiModelMetadata,
  XaiModelInputProvenance,
  type XaiCatalogModel,
} from "./models";
import { xaiCatalogHeaders } from "./wire";

const MAX_CATALOG_ENTRIES = 256;
const MAX_MODEL_ID_LENGTH = 128;
const MAX_MODEL_NAME_LENGTH = 200;
const MAX_CONTEXT_WINDOW = 10_000_000;
const MAX_OUTPUT_TOKENS = 1_000_000;
const DEFAULT_UNKNOWN_MAX_TOKENS = 16_384;
const API_KEY_ONLY_MODEL_IDS = new Set(["grok-build-0.1"]);
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type XaiInputModality = XaiCatalogModel["input"][number];

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

type CacheRecord = {
  schemaVersion: number;
  fetchedAt: number;
  models: XaiCatalogModel[];
  /** Exact validated schema-1 contents used only if an atomic refresh must roll back. */
  rollbackContents?: string;
};

type CacheTombstone = {
  schemaVersion: number;
  invalidatedAt: number;
  invalidated: true;
};

type FetchOutcome =
  | { kind: "success"; models: XaiCatalogModel[] }
  | { kind: "auth" | "permanent" | "transient" | "invalid-success" | "cancelled" };

export class XaiCatalogCancelledError extends Error {
  constructor() {
    super("xAI model catalog refresh was cancelled");
    this.name = "XaiCatalogCancelledError";
  }
}

export class XaiCatalogValidationError extends Error {
  constructor() {
    super("xAI model catalog response was invalid");
    this.name = "XaiCatalogValidationError";
  }
}

/** Return the token-free last-known-good catalog cache path. */
export function defaultXaiCatalogCachePath(): string {
  return join(getAgentDir(), "cache", "pi-xai-oauth", "models-v2.json");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = nonEmptyString(value);
    if (result) return result;
  }
  return undefined;
}

function firstValue(obj: Record<string, unknown>, meta: Record<string, unknown> | undefined, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  if (meta) {
    for (const key of keys) {
      if (meta[key] !== undefined) return meta[key];
    }
  }
  return undefined;
}

function positiveInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : undefined;
}

function safeModelId(value: unknown): string | undefined {
  const id = nonEmptyString(value);
  if (!id || id.length > MAX_MODEL_ID_LENGTH || !MODEL_ID_PATTERN.test(id)) return undefined;
  return id;
}

function safeDisplayName(value: unknown, fallback: string): string | undefined {
  const name = nonEmptyString(value) ?? fallback;
  if (name.length > MAX_MODEL_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) return undefined;
  return name;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function parseAcceptsImages(value: unknown): XaiInputModality[] | undefined {
  if (typeof value !== "boolean") return undefined;
  return value ? ["text", "image"] : ["text"];
}

function parseInputModalities(value: unknown): XaiInputModality[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) return undefined;
  if (!value.every((entry): entry is XaiInputModality => entry === "text" || entry === "image")) {
    return undefined;
  }
  if (new Set(value).size !== value.length) return undefined;
  return (["text", "image"] as const).filter((modality) => value.includes(modality));
}

function resolveCatalogModelInput(
  obj: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
  known: XaiCatalogModel | undefined,
): Pick<XaiCatalogModel, "input" | "inputProvenance"> {
  const candidates: Array<{
    source: Record<string, unknown> | undefined;
    key: "acceptsImages" | "inputModalities";
    parse: (value: unknown) => XaiInputModality[] | undefined;
    provenance: XaiModelInputProvenance;
  }> = [
    {
      source: obj,
      key: "acceptsImages",
      parse: parseAcceptsImages,
      provenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
    },
    {
      source: meta,
      key: "acceptsImages",
      parse: parseAcceptsImages,
      provenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
    },
    {
      source: obj,
      key: "inputModalities",
      parse: parseInputModalities,
      provenance: XaiModelInputProvenance.AuthenticatedInputModalities,
    },
    {
      source: meta,
      key: "inputModalities",
      parse: parseInputModalities,
      provenance: XaiModelInputProvenance.AuthenticatedInputModalities,
    },
  ];
  for (const candidate of candidates) {
    if (!candidate.source || !hasOwn(candidate.source, candidate.key)) continue;
    const input = candidate.parse(candidate.source[candidate.key]);
    if (input) return { input, inputProvenance: candidate.provenance };
  }
  if (known) {
    return { input: [...known.input], inputProvenance: XaiModelInputProvenance.Known };
  }
  return { input: ["text"], inputProvenance: XaiModelInputProvenance.Default };
}

function canonicalReasoningLevel(value: unknown): ThinkingLevel | undefined {
  const level = nonEmptyString(value)?.toLowerCase();
  if (!level) return undefined;
  if (level === "none") return "off";
  if (level === "max") return "xhigh";
  return THINKING_LEVELS.includes(level as ThinkingLevel) ? (level as ThinkingLevel) : undefined;
}

function parseReasoningLevels(value: unknown): ThinkingLevel[] | undefined {
  if (value === undefined || !Array.isArray(value) || value.length === 0) return undefined;
  const result: ThinkingLevel[] = [];
  for (const entry of value) {
    const level = canonicalReasoningLevel(
      typeof entry === "string" ? entry : objectValue(entry)?.value,
    );
    if (level && !result.includes(level)) result.push(level);
  }
  return result.length > 0 ? result : undefined;
}

function thinkingLevelMap(levels: ThinkingLevel[], modelId: string): XaiCatalogModel["thinkingLevelMap"] {
  const map: Record<ThinkingLevel, string | null> = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };
  for (const level of levels) {
    if (level === "off") map.off = "none";
    else if (level === "max") map.max = "max";
    else map[level] = level;
  }
  // Preserve pi-xai-oauth's Grok 4.x compatibility: pi's minimal level is sent
  // as xAI low when low is in the authenticated catalog.
  if (
    (modelId === "grok-4.5" || modelId === "grok-4.6") &&
    map.low === "low"
  ) {
    map.minimal = "low";
  }
  return map;
}

function hasApiKeyOnlyIndicator(obj: Record<string, unknown>, meta: Record<string, unknown> | undefined): boolean {
  if (["apiKey", "api_key", "envKey", "env_key"].some((key) => obj[key] !== undefined || meta?.[key] !== undefined)) {
    return true;
  }
  const authScheme = firstString(
    obj.authScheme,
    obj.auth_scheme,
    obj.authType,
    obj.auth_type,
    meta?.authScheme,
    meta?.auth_scheme,
  )?.toLowerCase();
  return !!authScheme && ["api-key", "api_key", "apikey", "bearer-api-key"].includes(authScheme);
}

type EntryResult = { kind: "model"; model: XaiCatalogModel } | { kind: "excluded" } | { kind: "malformed" };

function normalizeCatalogEntry(value: unknown): EntryResult {
  const obj = objectValue(value);
  if (!obj) return { kind: "malformed" };
  const meta = objectValue(obj._meta);
  const id = safeModelId(firstString(obj.model, obj.modelId, obj.id, meta?.model, meta?.modelId));
  if (!id) return { kind: "malformed" };
  const normalizedId = id.toLowerCase();
  if (API_KEY_ONLY_MODEL_IDS.has(normalizedId) || hasApiKeyOnlyIndicator(obj, meta)) return { kind: "excluded" };
  if (booleanValue(firstValue(obj, meta, ["hidden"])) === true) return { kind: "excluded" };

  const backend = firstString(obj.apiBackend, obj.api_backend, meta?.apiBackend, meta?.api_backend)?.toLowerCase();
  if (!backend) return { kind: "malformed" };
  if (backend !== "responses") return { kind: "excluded" };

  const contextValue = firstValue(obj, meta, ["contextWindow", "context_window", "totalContextTokens"]);
  const contextWindow = positiveInteger(contextValue, MAX_CONTEXT_WINDOW);
  if (!contextWindow) return { kind: "malformed" };

  const maxValue = firstValue(obj, meta, ["maxCompletionTokens", "max_completion_tokens"]);
  const suppliedMaxTokens = maxValue === undefined ? undefined : positiveInteger(maxValue, MAX_OUTPUT_TOKENS);
  if (maxValue !== undefined && (!suppliedMaxTokens || suppliedMaxTokens > contextWindow)) {
    return { kind: "malformed" };
  }

  const name = safeDisplayName(firstValue(obj, meta, ["name"]), id);
  if (!name) return { kind: "malformed" };

  const known = knownXaiModelMetadata(normalizedId);
  const input = resolveCatalogModelInput(obj, meta, known);
  const supportsReasoningEffort = booleanValue(
    firstValue(obj, meta, ["supportsReasoningEffort", "supports_reasoning_effort"]),
  );
  const explicitReasoning = booleanValue(firstValue(obj, meta, ["reasoning", "supportsReasoning"]));
  const defaultReasoningLevel = canonicalReasoningLevel(
    firstValue(obj, meta, ["reasoningEffort", "reasoning_effort"]),
  );
  const suppliedReasoningLevels = parseReasoningLevels(
    firstValue(obj, meta, ["reasoningEfforts", "reasoning_efforts"]),
  );
  const reasoning =
    explicitReasoning ??
    (supportsReasoningEffort === false
      ? false
      : supportsReasoningEffort === true || !!defaultReasoningLevel || !!suppliedReasoningLevels?.length
        ? true
        : known?.reasoning ?? false);

  let levelMap: XaiCatalogModel["thinkingLevelMap"];
  if (!reasoning) {
    levelMap = known?.reasoning === false ? known.thinkingLevelMap : { off: "none" };
  } else if (supportsReasoningEffort === false) {
    levelMap = thinkingLevelMap([], normalizedId);
  } else if (suppliedReasoningLevels !== undefined) {
    levelMap = thinkingLevelMap(suppliedReasoningLevels, normalizedId);
  } else if (defaultReasoningLevel) {
    levelMap = thinkingLevelMap([defaultReasoningLevel], normalizedId);
  } else if (supportsReasoningEffort === true) {
    levelMap = thinkingLevelMap(["low", "medium", "high"], normalizedId);
  } else {
    levelMap = known?.thinkingLevelMap;
  }

  return {
    kind: "model",
    model: {
      id,
      name,
      apiBackend: "responses",
      reasoning,
      ...input,
      cost: known ? { ...known.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: Math.min(
        suppliedMaxTokens ?? known?.maxTokens ?? DEFAULT_UNKNOWN_MAX_TOKENS,
        contextWindow,
      ),
      ...(levelMap ? { thinkingLevelMap: levelMap } : {}),
    },
  };
}

/** Normalize an official `/models-v2` response into exact pi model definitions. */
export function normalizeXaiCatalogPayload(payload: unknown): XaiCatalogModel[] {
  const root = objectValue(payload);
  if (!root || !Array.isArray(root.data) || root.data.length > MAX_CATALOG_ENTRIES) {
    throw new XaiCatalogValidationError();
  }

  const models: XaiCatalogModel[] = [];
  const seen = new Set<string>();
  let excluded = 0;
  let malformed = 0;
  for (const entry of root.data) {
    const result = normalizeCatalogEntry(entry);
    if (result.kind === "excluded") {
      excluded++;
      continue;
    }
    if (result.kind === "malformed") {
      malformed++;
      continue;
    }
    const key = result.model.id.toLowerCase();
    if (seen.has(key)) {
      excluded++;
      continue;
    }
    seen.add(key);
    models.push(result.model);
  }

  if (root.data.length > 0 && models.length === 0 && malformed > 0) {
    throw new XaiCatalogValidationError();
  }
  return models;
}

function fallbackSelection(needsAuthenticatedRefresh: boolean): XaiCatalogSelection {
  return {
    models: cloneXaiCatalogModels(CURATED_FALLBACK_MODELS),
    source: "curated-fallback",
    needsAuthenticatedRefresh,
  };
}

function equalInput(left: readonly XaiInputModality[], right: readonly XaiInputModality[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateCachedModel(value: unknown, schemaVersion: number): XaiCatalogModel | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const id = safeModelId(obj.id);
  const name = id ? safeDisplayName(obj.name, id) : undefined;
  const contextWindow = positiveInteger(obj.contextWindow, MAX_CONTEXT_WINDOW);
  const maxTokens = positiveInteger(obj.maxTokens, MAX_OUTPUT_TOKENS);
  const cost = objectValue(obj.cost);
  const parsedInput = parseInputModalities(obj.input);
  if (
    !id ||
    !name ||
    obj.apiBackend !== "responses" ||
    typeof obj.reasoning !== "boolean" ||
    !contextWindow ||
    !maxTokens ||
    maxTokens > contextWindow ||
    !cost ||
    !parsedInput
  ) return undefined;
  const rates = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
  if (!rates.every((rate) => typeof rate === "number" && Number.isFinite(rate) && rate >= 0)) return undefined;

  let map: XaiCatalogModel["thinkingLevelMap"];
  if (obj.thinkingLevelMap !== undefined) {
    const rawMap = objectValue(obj.thinkingLevelMap);
    if (!rawMap) return undefined;
    const normalized: Partial<Record<ThinkingLevel, string | null>> = {};
    for (const level of THINKING_LEVELS) {
      const mapped = rawMap[level];
      if (mapped === undefined) continue;
      if (mapped !== null && (typeof mapped !== "string" || !mapped.trim() || mapped.length > 32)) return undefined;
      normalized[level] = mapped;
    }
    map = normalized;
  }

  const known = knownXaiModelMetadata(id);
  let input: XaiInputModality[];
  let inputProvenance: XaiModelInputProvenance;
  if (schemaVersion === 1) {
    // Schema 1 inputs came from package metadata/defaults and carried no
    // authenticated provenance. Preserve membership and rederive that policy
    // instead of promoting a legacy text input to an authenticated denial.
    input = known ? [...known.input] : ["text"];
    inputProvenance = known ? XaiModelInputProvenance.Known : XaiModelInputProvenance.Default;
  } else {
    const provenance = obj.inputProvenance;
    if (
      provenance !== XaiModelInputProvenance.AuthenticatedAcceptsImages &&
      provenance !== XaiModelInputProvenance.AuthenticatedInputModalities &&
      provenance !== XaiModelInputProvenance.Known &&
      provenance !== XaiModelInputProvenance.Default
    ) return undefined;
    if (!equalInput(parsedInput, obj.input as XaiInputModality[])) return undefined;
    if (provenance === XaiModelInputProvenance.AuthenticatedAcceptsImages) {
      // A boolean acceptsImages field always implies text input and can only
      // add or omit image; image-only cache entries are impossible evidence.
      if (!parsedInput.includes("text")) return undefined;
    } else if (provenance === XaiModelInputProvenance.Known) {
      if (!known || !equalInput(parsedInput, known.input)) return undefined;
    } else if (provenance === XaiModelInputProvenance.Default) {
      if (known || !equalInput(parsedInput, ["text"])) return undefined;
    }
    input = parsedInput;
    inputProvenance = provenance;
  }

  return {
    id,
    name,
    apiBackend: "responses",
    reasoning: obj.reasoning,
    input,
    inputProvenance,
    cost: {
      input: cost.input as number,
      output: cost.output as number,
      cacheRead: cost.cacheRead as number,
      cacheWrite: cost.cacheWrite as number,
    },
    contextWindow,
    maxTokens,
    ...(map ? { thinkingLevelMap: map } : {}),
  };
}

function invalidationMarkerPath(cachePath: string): string {
  return `${cachePath}.invalidated`;
}

async function hasInvalidationMarker(cachePath: string): Promise<boolean> {
  try {
    const info = await lstat(invalidationMarkerPath(cachePath));
    return info.isFile();
  } catch {
    return false;
  }
}

async function writeInvalidationMarker(cachePath: string, now: number): Promise<void> {
  const markerPath = invalidationMarkerPath(cachePath);
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  const handle = await open(markerPath, "w", 0o600);
  try {
    await handle.writeFile(`${XAI_MODEL_CATALOG_CACHE_SCHEMA}:${now}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(markerPath, 0o600);
}

async function readCache(cachePath: string, now: number): Promise<CacheRecord | undefined> {
  try {
    if (await hasInvalidationMarker(cachePath)) return undefined;
    const info = await lstat(cachePath);
    if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > XAI_MODEL_CATALOG_MAX_BYTES) return undefined;
    if ((info.mode & 0o077) !== 0) await chmod(cachePath, 0o600);
    await chmod(dirname(cachePath), 0o700).catch(() => {});
    const contents = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(contents) as unknown;
    const obj = objectValue(parsed);
    if (
      !obj ||
      (obj.schemaVersion !== 1 && obj.schemaVersion !== XAI_MODEL_CATALOG_CACHE_SCHEMA) ||
      obj.invalidated === true
    ) return undefined;
    const fetchedAt = typeof obj.fetchedAt === "number" && Number.isFinite(obj.fetchedAt) ? obj.fetchedAt : undefined;
    if (!fetchedAt || fetchedAt > now + 5 * 60 * 1000 || now - fetchedAt > XAI_MODEL_CATALOG_MAX_STALE_MS) return undefined;
    if (!Array.isArray(obj.models) || obj.models.length > MAX_CATALOG_ENTRIES) return undefined;
    const models = obj.models.map((model) => validateCachedModel(model, obj.schemaVersion as number));
    if (models.some((model) => !model)) return undefined;
    const ids = new Set<string>();
    for (const model of models as XaiCatalogModel[]) {
      const key = model.id.toLowerCase();
      if (ids.has(key) || API_KEY_ONLY_MODEL_IDS.has(key)) return undefined;
      ids.add(key);
    }
    return {
      schemaVersion: XAI_MODEL_CATALOG_CACHE_SCHEMA,
      fetchedAt,
      models: models as XaiCatalogModel[],
      ...(obj.schemaVersion === 1 ? { rollbackContents: contents } : {}),
    };
  } catch {
    return undefined;
  }
}

const cacheWriteQueues = new Map<string, Promise<void>>();

async function withCacheWriteQueue(cachePath: string, operation: () => Promise<void>): Promise<void> {
  const previous = cacheWriteQueues.get(cachePath) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  cacheWriteQueues.set(cachePath, current);
  try {
    await current;
  } finally {
    if (cacheWriteQueues.get(cachePath) === current) cacheWriteQueues.delete(cachePath);
  }
}

async function writeAtomicContents(
  cachePath: string,
  contents: string,
  commitAllowed: () => boolean = () => true,
  clearInvalidationMarker = false,
): Promise<void> {
  const directory = dirname(cachePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tempPath = join(directory, `.models-v2-${process.pid}-${crypto.randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!commitAllowed()) throw new XaiCatalogCancelledError();
    await rename(tempPath, cachePath);
    await chmod(cachePath, 0o600);
    if (clearInvalidationMarker) {
      await unlink(invalidationMarkerPath(cachePath)).catch(() => {});
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function writeAtomicJson(
  cachePath: string,
  value: CacheRecord | CacheTombstone,
  commitAllowed: () => boolean = () => true,
  clearInvalidationMarker = false,
): Promise<void> {
  const { rollbackContents: _rollbackContents, ...persisted } = value as CacheRecord;
  await writeAtomicContents(
    cachePath,
    `${JSON.stringify(persisted)}\n`,
    commitAllowed,
    clearInvalidationMarker,
  );
}

async function cacheMatchesRecord(cachePath: string, expected: CacheRecord): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
    const obj = objectValue(value);
    return !!obj &&
      obj.schemaVersion === expected.schemaVersion &&
      obj.fetchedAt === expected.fetchedAt &&
      JSON.stringify(obj.models) === JSON.stringify(expected.models);
  } catch {
    return false;
  }
}

async function restorePreviousCache(cachePath: string, previous: CacheRecord | undefined): Promise<void> {
  if (previous?.rollbackContents !== undefined) {
    await writeAtomicContents(cachePath, previous.rollbackContents, () => true, true);
  } else if (previous) {
    await writeAtomicJson(cachePath, previous, () => true, true);
  } else {
    await unlink(cachePath).catch(() => {});
  }
}

async function invalidateCache(
  cachePath: string,
  now: number,
  commitAllowed: () => boolean = () => true,
  previous?: CacheRecord,
): Promise<void> {
  try {
    await withCacheWriteQueue(cachePath, async () => {
      await writeAtomicJson(cachePath, {
        schemaVersion: XAI_MODEL_CATALOG_CACHE_SCHEMA,
        invalidatedAt: now,
        invalidated: true,
      }, commitAllowed);
      if (!commitAllowed()) {
        await restorePreviousCache(cachePath, previous);
        throw new XaiCatalogCancelledError();
      }
    });
  } catch (error) {
    if (error instanceof XaiCatalogCancelledError) return;
    const removed = await unlink(cachePath).then(() => true).catch(() => false);
    if (!removed) await writeInvalidationMarker(cachePath, now).catch(() => {});
  }
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
  const cache = await readCache(cachePath, now);
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
    const record: CacheRecord = {
      schemaVersion: XAI_MODEL_CATALOG_CACHE_SCHEMA,
      fetchedAt: now,
      models: cloneXaiCatalogModels(outcome.models),
    };
    try {
      await withCacheWriteQueue(cachePath, async () => {
        await writeAtomicJson(cachePath, record, commitAllowed, true);
        if (!commitAllowed()) {
          await restorePreviousCache(cachePath, cache);
          throw new XaiCatalogCancelledError();
        }
      });
    } catch (error) {
      if (error instanceof XaiCatalogCancelledError) throw error;
      // Never leave a previous account's cache looking fresh after a successful
      // response that could not be committed atomically.
      await invalidateCache(
        cachePath,
        now,
        commitAllowed,
        cache,
      );
      if (!commitAllowed()) throw new XaiCatalogCancelledError();
      // Invalidation is best-effort. Refuse to advertise remote success if an
      // older readable entitlement cache could still be revived on reload.
      if (await readCache(cachePath, now)) await unlink(cachePath).catch(() => {});
      if (await readCache(cachePath, now)) return fallbackSelection(true);
    }
    if (!commitAllowed()) {
      await withCacheWriteQueue(cachePath, async () => {
        if (await cacheMatchesRecord(cachePath, record)) {
          await restorePreviousCache(cachePath, cache);
        }
      });
      throw new XaiCatalogCancelledError();
    }
    return {
      models: cloneXaiCatalogModels(outcome.models),
      source: "remote",
      needsAuthenticatedRefresh: refreshWhenCredentialsAvailable,
    };
  }

  if (!commitAllowed()) throw new XaiCatalogCancelledError();
  if (outcome.kind === "auth" || outcome.kind === "permanent") {
    await invalidateCache(cachePath, now, commitAllowed, cache);
    if (!commitAllowed()) throw new XaiCatalogCancelledError();
    return fallbackSelection(false);
  }
  if (forceRefresh) {
    // Forced refresh never reuses stale account data, but transient failures
    // remain retryable once pi has a bound, lock-refreshed credential.
    await invalidateCache(cachePath, now, commitAllowed, cache);
    if (!commitAllowed()) throw new XaiCatalogCancelledError();
    return fallbackSelection(true);
  }
  if (cache) {
    return { models: cloneXaiCatalogModels(cache.models), source: "stale-cache", needsAuthenticatedRefresh: false };
  }
  return fallbackSelection(true);
}
