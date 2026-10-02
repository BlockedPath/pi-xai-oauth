import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { throwIfAborted as assertNotAborted } from "../abort";
import { safeWorkspacePath } from "./grok-native-args";

/** Shared ceiling for package-owned text file reads (grep + negative-offset read/replace). */
export const MAX_GROK_NATIVE_TEXT_FILE_BYTES = 5_000_000;

/** Throw the Grok-native adapters' "Operation aborted" error when the signal is aborted. */
export function throwIfAborted(signal: AbortSignal | undefined) {
  assertNotAborted(signal, () => new Error("Operation aborted"));
}

function pathIsWithin(rootPath: string, candidatePath: string): boolean {
  const candidateRelativePath = relative(rootPath, candidatePath);
  return candidateRelativePath === ""
    || (candidateRelativePath !== ".."
      && !candidateRelativePath.startsWith(`..${sep}`)
      && !isAbsolute(candidateRelativePath));
}

/** Resolve a search path whose physical location stays inside the workspace. */
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

/** Read a bounded UTF-8 text file without following a final symlink. */
export async function readContainedTextFile(
  absolutePath: string,
  requestedPath: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | noFollow | nonBlock);
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
