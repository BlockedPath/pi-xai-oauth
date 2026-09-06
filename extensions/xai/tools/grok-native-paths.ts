import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { throwIfAborted as assertNotAborted } from "../abort";
import { safeWorkspacePath } from "./grok-native-args";

/** Shared ceiling for package-owned text file reads (grep + negative-offset read/replace). */
export const MAX_GROK_NATIVE_TEXT_FILE_BYTES = 5_000_000;

/** Abort cooperative Grok-native local tool work with a stable message. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  assertNotAborted(signal, () => new Error("Operation aborted"));
}

function pathIsWithin(rootPath: string, candidatePath: string): boolean {
  const candidateRelativePath = relative(rootPath, candidatePath);
  return candidateRelativePath === ""
    || (candidateRelativePath !== ".."
      && !candidateRelativePath.startsWith(`..${sep}`)
      && !isAbsolute(candidateRelativePath));
}

/** Resolve a grep/search path that remains inside the workspace after symlink resolution. */
export async function physicalWorkspaceSearchPath(cwd: string, requestedPath: string): Promise<string> {
  const lexicalPath = safeWorkspacePath(cwd, requestedPath);
  const [workspacePath, physicalPath] = await Promise.all([realpath(cwd), realpath(lexicalPath)]);
  if (!pathIsWithin(workspacePath, physicalPath)) {
    throw new Error(`Refusing to operate outside the workspace: ${requestedPath}`);
  }
  return physicalPath;
}

/**
 * Resolve a read/write/list path that remains inside the workspace after symlink resolution.
 * Missing leaf files are allowed when their physical parent stays inside the workspace.
 * This is pathname-based defense in depth, not a race-resistant filesystem sandbox.
 */
export async function containedWorkspacePath(cwd: string, requestedPath: string): Promise<string> {
  const lexicalPath = safeWorkspacePath(cwd, requestedPath);
  const workspacePath = await realpath(cwd);
  try {
    const physicalPath = await realpath(lexicalPath);
    if (!pathIsWithin(workspacePath, physicalPath)) {
      throw new Error(`Refusing to operate outside the workspace: ${requestedPath}`);
    }
    return physicalPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }

  const unresolvedLeafExists = await lstat(lexicalPath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (unresolvedLeafExists) {
    throw new Error(`Refusing to operate through an unresolved existing path: ${requestedPath}`);
  }

  let physicalParent: string;
  try {
    physicalParent = await realpath(dirname(lexicalPath));
  } catch {
    throw new Error(`Path not found: ${requestedPath}`);
  }
  if (!pathIsWithin(workspacePath, physicalParent)) {
    throw new Error(`Refusing to operate outside the workspace: ${requestedPath}`);
  }
  return join(physicalParent, basename(lexicalPath));
}

/** Convert a contained absolute path into a cwd-relative tool path for pi builtins. */
export async function toWorkspaceToolPath(cwd: string, absolutePath: string): Promise<string> {
  const workspacePath = await realpath(cwd);
  const relativePath = relative(workspacePath, absolutePath);
  if (relativePath === "") return ".";
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("Refusing to pass a path outside the workspace to a direct file adapter");
  }
  return relativePath;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

/** Non-blocking open flag when supported by the platform. */
export function nonBlockFlag(): number {
  return typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
}

/** Open a path without following a leaf symlink. */
export async function openUnfollowedFile(
  absolutePath: string,
  flags: number,
): Promise<Awaited<ReturnType<typeof open>>> {
  return open(absolutePath, flags | noFollowFlag());
}

/** Read a bounded UTF-8 text file through an unfollowed handle. */
export async function readContainedTextFile(
  absolutePath: string,
  requestedPath: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await openUnfollowedFile(
      absolutePath,
      constants.O_RDONLY | nonBlockFlag(),
    );
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Not a file: ${requestedPath}`);
    if (info.size > MAX_GROK_NATIVE_TEXT_FILE_BYTES) {
      throw new Error(
        `Refusing to read more than ${MAX_GROK_NATIVE_TEXT_FILE_BYTES} bytes from ${requestedPath}`,
      );
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_GROK_NATIVE_TEXT_FILE_BYTES) {
      throwIfAborted(signal);
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, MAX_GROK_NATIVE_TEXT_FILE_BYTES + 1 - totalBytes),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_GROK_NATIVE_TEXT_FILE_BYTES) {
      throw new Error(
        `Refusing to read more than ${MAX_GROK_NATIVE_TEXT_FILE_BYTES} bytes from ${requestedPath}`,
      );
    }
    throwIfAborted(signal);
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Write bounded UTF-8 text through an unfollowed handle. */
export async function writeContainedTextFile(
  absolutePath: string,
  content: string,
  requestedPath: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await openUnfollowedFile(
      absolutePath,
      constants.O_WRONLY | constants.O_TRUNC,
    );
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Not a file: ${requestedPath}`);
    throwIfAborted(signal);
    await handle.writeFile(content, "utf8");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
