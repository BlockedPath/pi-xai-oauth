import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "fs/promises";
import { dirname, join } from "path";
import { validateCachedXaiCatalogModels } from "./catalog-normalize";
import {
  XAI_MODEL_CATALOG_CACHE_SCHEMA,
  XAI_MODEL_CATALOG_MAX_BYTES,
  XAI_MODEL_CATALOG_MAX_STALE_MS,
} from "./constants";
import type { XaiCatalogModel } from "./models";
import { objectValue } from "./validate";

/** A validated last-known-good catalog cache entry. */
export type CacheRecord = {
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

/** Read and validate the cache, returning `undefined` for any missing, invalidated, stale, or untrusted entry. */
export async function readCache(cachePath: string, now: number): Promise<CacheRecord | undefined> {
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
    const models = validateCachedXaiCatalogModels(obj.models, obj.schemaVersion as number);
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

/** Serialize cache writes per path so overlapping refreshes commit in order. */
export async function withCacheWriteQueue(cachePath: string, operation: () => Promise<void>): Promise<void> {
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

/** Atomically write a cache record or tombstone, honoring the commit guard before rename. */
export async function writeAtomicJson(
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

/** Whether the on-disk cache still holds exactly this record. */
export async function cacheMatchesRecord(cachePath: string, expected: CacheRecord): Promise<boolean> {
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

/** Restore the previous cache contents, or remove the cache when there was none. */
export async function restorePreviousCache(cachePath: string, previous: CacheRecord | undefined): Promise<void> {
  if (previous?.rollbackContents !== undefined) {
    await writeAtomicContents(cachePath, previous.rollbackContents, () => true, true);
  } else if (previous) {
    await writeAtomicJson(cachePath, previous, () => true, true);
  } else {
    await unlink(cachePath).catch(() => {});
  }
}

/** Replace the cache with a tombstone, falling back to removal or an invalidation marker. */
export async function invalidateCache(
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
