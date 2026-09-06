import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "fs/promises";
import { dirname, join } from "path";
import {
  XAI_MODEL_CATALOG_CACHE_SCHEMA,
  XAI_MODEL_CATALOG_MAX_BYTES,
  XAI_MODEL_CATALOG_MAX_STALE_MS,
} from "../constants";
import { cloneXaiCatalogModels, type XaiCatalogModel } from "../models";
import { decodeCachedXaiCatalogModels } from "./model-codec";

export type XaiCatalogCacheRecord = {
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

type CommitGuard = () => boolean;

export class XaiCatalogCancelledError extends Error {
  constructor() {
    super("xAI model catalog refresh was cancelled");
    this.name = "XaiCatalogCancelledError";
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

/** Read and validate an eligible token-free catalog cache record. */
export async function readXaiCatalogCache(
  cachePath: string,
  now: number,
): Promise<XaiCatalogCacheRecord | undefined> {
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
    const models = decodeCachedXaiCatalogModels(obj.models, obj.schemaVersion as number);
    if (!models) return undefined;
    return {
      schemaVersion: XAI_MODEL_CATALOG_CACHE_SCHEMA,
      fetchedAt,
      models,
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
  commitAllowed: CommitGuard = () => true,
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
  value: XaiCatalogCacheRecord | CacheTombstone,
  commitAllowed: CommitGuard = () => true,
  clearInvalidationMarker = false,
): Promise<void> {
  const { rollbackContents: _rollbackContents, ...persisted } = value as XaiCatalogCacheRecord;
  await writeAtomicContents(
    cachePath,
    `${JSON.stringify(persisted)}\n`,
    commitAllowed,
    clearInvalidationMarker,
  );
}

async function cacheMatchesRecord(cachePath: string, expected: XaiCatalogCacheRecord): Promise<boolean> {
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

async function restorePreviousCache(
  cachePath: string,
  previous: XaiCatalogCacheRecord | undefined,
): Promise<void> {
  if (previous?.rollbackContents !== undefined) {
    await writeAtomicContents(cachePath, previous.rollbackContents, () => true, true);
  } else if (previous) {
    await writeAtomicJson(cachePath, previous, () => true, true);
  } else {
    await unlink(cachePath).catch(() => {});
  }
}

/** Invalidate a cache without reviving a prior entitlement snapshot after cancellation. */
export async function invalidateXaiCatalogCache(options: {
  cachePath: string;
  now: number;
  commitAllowed?: CommitGuard;
  previous?: XaiCatalogCacheRecord;
}): Promise<void> {
  const commitAllowed = options.commitAllowed ?? (() => true);
  try {
    await withCacheWriteQueue(options.cachePath, async () => {
      await writeAtomicJson(options.cachePath, {
        schemaVersion: XAI_MODEL_CATALOG_CACHE_SCHEMA,
        invalidatedAt: options.now,
        invalidated: true,
      }, commitAllowed);
      if (!commitAllowed()) {
        await restorePreviousCache(options.cachePath, options.previous);
        throw new XaiCatalogCancelledError();
      }
    });
  } catch (error) {
    if (!(error instanceof XaiCatalogCancelledError)) {
      const removed = await unlink(options.cachePath).then(() => true).catch(() => false);
      if (!removed) await writeInvalidationMarker(options.cachePath, options.now).catch(() => {});
    }
  }
  if (!commitAllowed()) throw new XaiCatalogCancelledError();
}

/** Atomically commit a remote catalog or report that an older cache remains readable. */
export async function commitXaiCatalogCache(options: {
  cachePath: string;
  now: number;
  models: readonly XaiCatalogModel[];
  previous?: XaiCatalogCacheRecord;
  commitAllowed?: CommitGuard;
}): Promise<"committed" | "unsafe-old-cache"> {
  const commitAllowed = options.commitAllowed ?? (() => true);
  const record: XaiCatalogCacheRecord = {
    schemaVersion: XAI_MODEL_CATALOG_CACHE_SCHEMA,
    fetchedAt: options.now,
    models: cloneXaiCatalogModels(options.models),
  };
  try {
    await withCacheWriteQueue(options.cachePath, async () => {
      await writeAtomicJson(options.cachePath, record, commitAllowed, true);
      if (!commitAllowed()) {
        await restorePreviousCache(options.cachePath, options.previous);
        throw new XaiCatalogCancelledError();
      }
    });
  } catch (error) {
    if (error instanceof XaiCatalogCancelledError) throw error;
    // Never leave a previous account's cache looking fresh after a successful
    // response that could not be committed atomically.
    await invalidateXaiCatalogCache({
      cachePath: options.cachePath,
      now: options.now,
      commitAllowed,
      previous: options.previous,
    });
    // Invalidation is best-effort. Refuse to advertise remote success if an
    // older readable entitlement cache could still be revived on reload.
    if (await readXaiCatalogCache(options.cachePath, options.now)) {
      await unlink(options.cachePath).catch(() => {});
    }
    if (await readXaiCatalogCache(options.cachePath, options.now)) return "unsafe-old-cache";
  }
  if (!commitAllowed()) {
    await withCacheWriteQueue(options.cachePath, async () => {
      if (await cacheMatchesRecord(options.cachePath, record)) {
        await restorePreviousCache(options.cachePath, options.previous);
      }
    });
    throw new XaiCatalogCancelledError();
  }
  return "committed";
}
