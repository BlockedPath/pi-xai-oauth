import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { throwIfAborted } from "../abort";
import { IMAGE_EDIT_OUTPUT_DIRECTORY_MODE, IMAGE_EDIT_OUTPUT_FILE_MODE } from "./constants";
import type { SavedImageOutput, VerifiedImageBytes } from "./types";

interface ReadonlySessionLocation {
  getSessionDir(): string;
  getSessionId(): string;
}

function isWithin(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === "" || (
    difference !== ".."
    && !difference.startsWith(`..${sep}`)
    && !isAbsolute(difference)
  );
}

async function ensurePrivateOutputDirectory(outputRoot: string, sessionRoot: string): Promise<string> {
  const absoluteSessionRoot = resolve(sessionRoot);
  const absoluteOutputRoot = resolve(outputRoot);
  if (!isWithin(absoluteSessionRoot, absoluteOutputRoot) || absoluteSessionRoot === absoluteOutputRoot) {
    throw new Error("Image output directory is outside Pi session storage.");
  }

  const realSessionRoot = await realpath(absoluteSessionRoot);
  const components = relative(absoluteSessionRoot, absoluteOutputRoot).split(sep).filter(Boolean);
  let current = realSessionRoot;

  for (const component of components) {
    const candidate = join(current, component);
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("Image output path contains an unsafe filesystem entry.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      try {
        await mkdir(candidate, { mode: IMAGE_EDIT_OUTPUT_DIRECTORY_MODE });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException)?.code !== "EEXIST") throw mkdirError;
      }
      const created = await lstat(candidate);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error("Image output path contains an unsafe filesystem entry.");
      }
    }

    const realCandidate = await realpath(candidate);
    if (!isWithin(realSessionRoot, realCandidate)) {
      throw new Error("Image output directory resolves outside Pi session storage.");
    }
    await chmod(realCandidate, IMAGE_EDIT_OUTPUT_DIRECTORY_MODE);
    current = realCandidate;
  }

  return current;
}

/** Derive a package-owned, session-specific image-edit output directory. */
function sessionOutputRoot(sessionManager: ReadonlySessionLocation, category: string): string {
  const sessionDir = sessionManager?.getSessionDir?.();
  const sessionId = sessionManager?.getSessionId?.();
  if (typeof sessionDir !== "string" || !isAbsolute(sessionDir) || typeof sessionId !== "string" || !sessionId) {
    throw new Error("A safe Pi session output directory is unavailable.");
  }
  const sessionKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return join(sessionDir, "pi-xai-oauth", sessionKey, category);
}

/** Derive a package-owned, session-specific image-edit output directory. */
export function imageEditOutputRoot(sessionManager: ReadonlySessionLocation): string {
  return sessionOutputRoot(sessionManager, "image-edits");
}

/** Derive a package-owned, session-specific video output directory. */
export function videoOutputRoot(sessionManager: ReadonlySessionLocation): string {
  return sessionOutputRoot(sessionManager, "videos");
}

/** Atomically save a verified image to controlled session storage with 0700/0600 modes. */
export interface PrivateOutputWriter {
  write(chunk: Uint8Array): Promise<void>;
}

/** Stream one verified output into a private temporary file and atomically publish it. */
export async function savePrivateStreamedOutput<T>(options: {
  outputRoot: string;
  sessionRoot: string;
  extension: string;
  stemPrefix: string;
  signal?: AbortSignal;
  invalidPathMessage?: string;
  write: (writer: PrivateOutputWriter) => Promise<T>;
}): Promise<{ path: string; value: T }> {
  throwIfAborted(options.signal);
  if (!isAbsolute(options.outputRoot) || !isAbsolute(options.sessionRoot)) {
    throw new Error(options.invalidPathMessage ?? "Output path is invalid.");
  }
  const realOutputRoot = await ensurePrivateOutputDirectory(options.outputRoot, options.sessionRoot);
  const stem = `${options.stemPrefix}-${Date.now()}-${randomUUID()}`;
  const finalPath = join(realOutputRoot, `${stem}.${options.extension}`);
  const temporaryPath = join(realOutputRoot, `.${stem}.${options.extension}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let finalCreated = false;
  try {
    handle = await open(temporaryPath, "wx", IMAGE_EDIT_OUTPUT_FILE_MODE);
    const currentHandle = handle;
    const value = await options.write({
      async write(chunk) {
        throwIfAborted(options.signal);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await currentHandle.write(
            chunk,
            offset,
            chunk.byteLength - offset,
          );
          if (bytesWritten <= 0) throw new Error("Private output write made no progress.");
          offset += bytesWritten;
        }
      },
    });
    await handle.sync();
    await handle.close();
    handle = undefined;
    throwIfAborted(options.signal);
    await rename(temporaryPath, finalPath);
    finalCreated = true;
    throwIfAborted(options.signal);
    await chmod(finalPath, IMAGE_EDIT_OUTPUT_FILE_MODE);
    throwIfAborted(options.signal);
    return { path: finalPath, value };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (finalCreated) await rm(finalPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Atomically save a verified image to controlled session storage with 0700/0600 modes. */
export async function saveVerifiedOutputImage(
  image: VerifiedImageBytes,
  options: { outputRoot: string; sessionRoot: string; signal?: AbortSignal },
): Promise<SavedImageOutput> {
  const saved = await savePrivateStreamedOutput({
    outputRoot: options.outputRoot,
    sessionRoot: options.sessionRoot,
    signal: options.signal,
    extension: image.mimeType === "image/png" ? "png" : "jpg",
    stemPrefix: "xai-edit",
    invalidPathMessage: "Image output path is invalid.",
    write: (writer) => writer.write(image.bytes),
  });
  return {
    path: saved.path,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    byteLength: image.bytes.length,
  };
}
