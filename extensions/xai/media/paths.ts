import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { open, realpath, stat as fsStat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { throwIfAborted } from "../abort";
import { MEDIA_MAX_SOURCE_BYTES, MEDIA_MAX_SOURCE_PIXELS } from "./constants";
import { inspectSupportedImageBytes } from "./image-info";
import type { VerifiedImageBytes } from "./types";

const READ_CHUNK_BYTES = 64 * 1024;

function isContainedPath(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference !== "" && difference !== ".." && !difference.startsWith(`..${sep}`)
    && !isAbsolute(difference);
}

function validateWorkspacePathInputs(inputPath: string, workspaceRoot: string) {
  if (typeof inputPath !== "string" || !inputPath.trim() || inputPath.includes("\0")) {
    throw new Error("Image reference path is invalid.");
  }
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new Error("Workspace root is unavailable.");
  }
}

function shouldPreserveImageReadError(error: unknown): error is Error {
  return error instanceof Error
    && /^(?:Image reference|Image |Only byte-validated|PNG image|JPEG image)/.test(error.message);
}

function hasSameFileIdentity(
  expected: Readonly<{ dev: bigint; ino: bigint }>,
  actual: Readonly<{ dev: bigint; ino: bigint }>,
): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}

/** One over-read chunk buffer sized so the byte bound is always detectable. */
function nextReadChunk(maxBytes: number, total: number): Buffer {
  return Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
}

function assembleBoundedRead(chunks: readonly Buffer[], total: number, maxBytes: number): Buffer {
  if (total > maxBytes) throw new Error("Image reference exceeds the source-byte limit.");
  return Buffer.concat(chunks, total);
}

function readDescriptorBounded(fd: number, maxBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = nextReadChunk(maxBytes, total);
    const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return assembleBoundedRead(chunks, total, maxBytes);
}

/** Reject non-regular, empty, and over-sized image sources after the handle is open. */
function assertReadableImageStat(stat: { isFile(): boolean; size: bigint }): void {
  if (!stat.isFile()) throw new Error("Image reference must be a regular file.");
  if (stat.size <= 0n) throw new Error("Image reference contains no data.");
  if (stat.size > BigInt(MEDIA_MAX_SOURCE_BYTES)) {
    throw new Error("Image reference exceeds the source-byte limit.");
  }
}

/** Resolve the read-only, symlink-free open flags for image source files. */
function imageOpenFlags(): number {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  return constants.O_RDONLY | noFollow | nonBlock;
}

export interface BoundedWorkspaceFileOptions {
  /** Maximum accepted file size in bytes. */
  maxBytes: number;
  /** User-facing subject that prefixes every sanitized error message. */
  label: string;
  /** Caller cancellation checked between bounded reads. */
  signal?: AbortSignal;
}

/**
 * Read a byte-bounded regular file whose resolved path remains inside the
 * workspace. Symlinks are resolved once, the final open refuses symlinks, the
 * opened handle must match the inspected file identity, and every failure is
 * reduced to a stable `label`-prefixed message.
 */
export async function readBoundedWorkspaceFile(
  inputPath: string,
  workspaceRoot: string,
  options: BoundedWorkspaceFileOptions,
): Promise<Buffer> {
  const { label, maxBytes, signal } = options;
  if (typeof inputPath !== "string" || !inputPath.trim() || inputPath.includes("\0")) {
    throw new Error(`${label} path is invalid.`);
  }
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new Error("Workspace root is unavailable.");
  }
  throwIfAborted(signal);

  const unreadable = () => new Error(`${label} is not a readable workspace file.`);
  let root: string;
  let target: string;
  let initialStat: Awaited<ReturnType<typeof fsStat>>;
  try {
    root = await realpath(workspaceRoot);
    const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
    initialStat = await fsStat(candidate, { bigint: true });
    target = await realpath(candidate);
  } catch {
    throw unreadable();
  }
  if (!isContainedPath(root, target)) throw new Error(`${label} resolves outside the workspace.`);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!initialStat.isFile()) throw new Error(`${label} must be a regular file.`);
    handle = await open(target, imageOpenFlags());
    const stat = await handle.stat({ bigint: true });
    if (!hasSameFileIdentity(initialStat, stat)) {
      throw new Error(`${label} changed while being opened.`);
    }
    if (!stat.isFile()) throw new Error(`${label} must be a regular file.`);
    if (stat.size <= 0n) throw new Error(`${label} contains no data.`);
    if (stat.size > BigInt(maxBytes)) throw new Error(`${label} exceeds the source-byte limit.`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      throwIfAborted(signal);
      const chunk = nextReadChunk(maxBytes, total);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error(`${label} exceeds the source-byte limit.`);
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (error instanceof Error && error.message.startsWith(`${label} `)) throw error;
    throw unreadable();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Read a byte-bounded regular image whose resolved path remains inside the workspace. */
export async function readBoundedWorkspaceImageFile(
  inputPath: string,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<VerifiedImageBytes> {
  const bytes = await readBoundedWorkspaceFile(inputPath, workspaceRoot, {
    maxBytes: MEDIA_MAX_SOURCE_BYTES,
    label: "Image reference",
    signal,
  });
  try {
    const inspected = inspectSupportedImageBytes(bytes, { maxPixels: MEDIA_MAX_SOURCE_PIXELS });
    return { bytes, ...inspected, source: "workspace-path" };
  } catch (error) {
    if (shouldPreserveImageReadError(error)) throw error;
    throw new Error("Image reference is not a readable workspace file.");
  }
}

/** Synchronously read a byte-bounded regular image whose resolved path remains inside the workspace. */
export function readBoundedWorkspaceImageFileSync(
  inputPath: string,
  workspaceRoot: string,
): VerifiedImageBytes {
  validateWorkspacePathInputs(inputPath, workspaceRoot);

  let root: string;
  let target: string;
  let initialStat: ReturnType<typeof statSync>;
  try {
    root = realpathSync(workspaceRoot);
    const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
    initialStat = statSync(candidate, { bigint: true });
    target = realpathSync(candidate);
  } catch {
    throw new Error("Image reference is not a readable workspace file.");
  }
  if (!isContainedPath(root, target)) throw new Error("Image reference resolves outside the workspace.");

  let fd: number | undefined;
  try {
    if (!initialStat.isFile()) throw new Error("Image reference must be a regular file.");
    fd = openSync(target, imageOpenFlags());
    const stat = fstatSync(fd, { bigint: true });
    if (!hasSameFileIdentity(initialStat, stat)) {
      throw new Error("Image reference changed while being opened.");
    }
    assertReadableImageStat(stat);
    const bytes = readDescriptorBounded(fd, MEDIA_MAX_SOURCE_BYTES);
    const inspected = inspectSupportedImageBytes(bytes, { maxPixels: MEDIA_MAX_SOURCE_PIXELS });
    return { bytes, ...inspected, source: "workspace-path" };
  } catch (error) {
    if (shouldPreserveImageReadError(error)) throw error;
    throw new Error("Image reference is not a readable workspace file.");
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The read result or sanitized read failure remains authoritative.
      }
    }
  }
}
