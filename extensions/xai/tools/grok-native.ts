import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  writeFile as writeFileUtf8,
} from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { Type } from "typebox";
import { throwIfAborted as assertNotAborted } from "../abort";
import { resolveXaiCredential } from "../auth";
import {
  XAI_GROK_NATIVE_AUTO_TOOL_NAMES,
  XAI_GROK_NATIVE_TOOL_NAME_MAP,
  XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME,
  XAI_GROK_NATIVE_WEB_SEARCH_NAME,
  XAI_PROVIDER_ID,
} from "../constants";
import { createXaiResponse } from "../responses";
import { extractStrictResponsesText, messageFromError, statusFromError } from "../text";
import { xaiToolError } from "./common";
import {
  grepArgsForLocalSearch,
  listDirArgsForPi,
  prepareGrepArgs,
  prepareListDirArgs,
  prepareReadFileArgs,
  prepareSearchReplaceArgs,
  prepareTerminalCommandArgs,
  prepareWebSearchArgs,
  readFileArgsForPi,
  safeWorkspacePath,
  searchReplaceArgsForPi,
  terminalCommandArgsForPi,
} from "./grok-native-args";
import { activeXaiModel, isXaiNetworkToolActive } from "./model-scope";

const DEFAULT_GROK_GREP_LIMIT = 200;
const MAX_GROK_GREP_LIMIT = 2_000;
const DEFAULT_GROK_GREP_ENTRY_LIMIT = 500;
const MAX_GROK_GREP_ENTRY_LIMIT = 10_000;
const MAX_GROK_REGEX_LENGTH = 500;
const MAX_GROK_GREP_CONTEXT_LINES = 20;
const MAX_GROK_GREP_FILE_BYTES = 5_000_000;
const MAX_GROK_GREP_TOTAL_BYTES = 100_000_000;
const MAX_GROK_GREP_OUTPUT_BYTES = 40 * 1024;
const MAX_GROK_GREP_LINE_CHARS = 1_000;
const GROK_GREP_TIMEOUT_MS = 20_000;
/** Shared ceiling for package-owned text file reads (grep + negative-offset read/replace). */
const MAX_GROK_NATIVE_TEXT_FILE_BYTES = MAX_GROK_GREP_FILE_BYTES;
const SKIPPED_SEARCH_DIRS = new Set([".git", ".omp", "node_modules"]);

const GROK_GREP_FILE_TYPES: Readonly<Record<string, readonly string[]>> = {
  c: [".c", ".h"],
  cpp: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
  csharp: [".cs"],
  go: [".go"],
  java: [".java"],
  js: [".js", ".jsx", ".mjs", ".cjs"],
  json: [".json", ".jsonc"],
  kotlin: [".kt", ".kts"],
  markdown: [".md", ".mdx"],
  php: [".php"],
  py: [".py", ".pyi"],
  ruby: [".rb"],
  rust: [".rs"],
  shell: [".sh", ".bash", ".zsh", ".fish"],
  swift: [".swift"],
  toml: [".toml"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  yaml: [".yaml", ".yml"],
};

const readFileSchema = Type.Object({
  target_file: Type.String({
    minLength: 1,
    description:
      "Workspace-relative path or absolute path inside the workspace. Traversal and symlinks resolving outside are rejected.",
  }),
  offset: Type.Optional(Type.Integer({ description: "The line number to start reading from." })),
  limit: Type.Optional(Type.Integer({ description: "The number of lines to read." })),
  pages: Type.Optional(Type.String({
    description: "Page range for PDF files, such as 1-5, 3, or 10-.",
  })),
  format: Type.Optional(Type.String({
    description: "PDF output format: image (default) or text.",
  })),
});

const searchReplaceSchema = Type.Object({
  file_path: Type.String({
    minLength: 1,
    description:
      "Workspace-relative path or absolute path inside the workspace. Traversal and symlinks resolving outside are rejected.",
  }),
  old_string: Type.String({
    description:
      "Exact text to replace. An empty string overwrites an existing file or creates a missing leaf under a workspace-contained physical parent.",
  }),
  new_string: Type.String({ description: "Replacement text." }),
  replace_all: Type.Optional(Type.Boolean({
    description: "Replace every non-overlapping occurrence instead of requiring one unique match.",
  })),
});

const listDirSchema = Type.Object({
  target_directory: Type.String({
    minLength: 1,
    description:
      "Workspace-relative directory or absolute directory inside the workspace. Traversal and symlinks resolving outside are rejected.",
  }),
});

const grepSchema = Type.Object({
  pattern: Type.String({
    minLength: 1,
    description: "Regular expression to search for in file contents.",
  }),
  path: Type.Optional(Type.String({ description: "File or directory to search; defaults to the workspace." })),
  glob: Type.Optional(Type.String({ description: "Glob filter such as *.ts or src/**/*.ts." })),
  "-B": Type.Optional(Type.Integer({ minimum: 0, description: "Context lines before each match." })),
  "-A": Type.Optional(Type.Integer({ minimum: 0, description: "Context lines after each match." })),
  "-C": Type.Optional(Type.Integer({ minimum: 0, description: "Context lines before and after each match." })),
  "-i": Type.Optional(Type.Boolean({ description: "Use case-insensitive matching." })),
  type: Type.Optional(Type.String({
    description: "Common file type filter: ts, js, py, rust, go, java, json, yaml, and similar.",
  })),
  head_limit: Type.Optional(Type.Integer({
    minimum: 0,
    description: `Maximum output lines (default ${DEFAULT_GROK_GREP_LIMIT}).`,
  })),
  multiline: Type.Optional(Type.Boolean({
    description: "Enable multiline mode where . matches newlines.",
  })),
});

const terminalCommandSchema = Type.Object({
  command: Type.String({
    minLength: 1,
    description:
      "Shell command passed to pi bash. Unlike direct file adapters, command filesystem access is not workspace-contained.",
  }),
  timeout: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 300_000,
    description: "Timeout in milliseconds (default 120000; maximum 300000).",
  })),
  description: Type.String({
    minLength: 1,
    description: "One sentence explaining why the command contributes to the goal.",
  }),
  background: Type.Optional(Type.Boolean({
    description: "Must be false: pi has no managed background-task lifecycle for extension tools.",
  })),
});

const webSearchSchema = Type.Object({
  query: Type.String({ minLength: 1, description: "The search query to perform." }),
  allowed_domains: Type.Optional(Type.Array(
    Type.String(),
    { description: "Optional domains to restrict the search to." },
  )),
});

function toPosixPath(filePath: string): string {
  return filePath.split(sep).join("/");
}

function escapeRegExpChar(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExpChar(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function globMatches(pattern: string | undefined, relativePath: string): boolean {
  const normalizedPattern = toPosixPath(pattern || "**/*");
  const normalizedPath = toPosixPath(relativePath);
  const matchTarget = normalizedPattern.includes("/")
    ? normalizedPath
    : normalizedPath.split("/").pop() || normalizedPath;
  return globToRegExp(normalizedPattern).test(matchTarget);
}

function throwIfAborted(signal: AbortSignal | undefined) {
  assertNotAborted(signal, () => new Error("Operation aborted"));
}

function isRegexQuantifierStart(char: string | undefined): boolean {
  return char === "*" || char === "+" || char === "?" || char === "{";
}

function hasUnsafeRegexStructure(pattern: string): boolean {
  let inCharacterClass = false;
  const groupStack: Array<{ hasQuantifier: boolean; hasAlternation: boolean }> = [];

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      if (/\d/.test(pattern[index + 1] || "")) return true;
      index += 1;
      continue;
    }
    if (inCharacterClass) {
      if (char === "]") inCharacterClass = false;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      continue;
    }
    if (char === "(") {
      groupStack.push({ hasQuantifier: false, hasAlternation: false });
      continue;
    }
    if (char === "|") {
      const current = groupStack[groupStack.length - 1];
      if (current) current.hasAlternation = true;
      continue;
    }
    if (char === ")") {
      const group = groupStack.pop();
      if (group && (group.hasQuantifier || group.hasAlternation) && isRegexQuantifierStart(pattern[index + 1])) {
        return true;
      }
      continue;
    }
    if (isRegexQuantifierStart(char)) {
      const current = groupStack[groupStack.length - 1];
      if (current) current.hasQuantifier = true;
    }
  }

  return false;
}

function createSafeRegexMatcher(
  pattern: string,
  ignoreCase: boolean,
  multiline = false,
): RegExp {
  if (pattern.length > MAX_GROK_REGEX_LENGTH) {
    throw new Error(`Regex pattern exceeds maximum length of ${MAX_GROK_REGEX_LENGTH} characters`);
  }
  if (hasUnsafeRegexStructure(pattern)) {
    throw new Error(
      "Unsafe regex pattern: nested quantifiers, quantified alternation, and backreferences are not supported",
    );
  }
  try {
    const flags = `${ignoreCase ? "i" : ""}${multiline ? "gms" : ""}`;
    return new RegExp(pattern, flags || undefined);
  } catch (error) {
    throw new Error(`Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function matchesFileType(filePath: string, type: string | undefined): boolean {
  if (!type) return true;
  const extensions = GROK_GREP_FILE_TYPES[type.toLowerCase()];
  if (!extensions) {
    throw new Error(`Unsupported grep file type: ${type}`);
  }
  return extensions.includes(extname(filePath).toLowerCase());
}

function pathIsWithin(rootPath: string, candidatePath: string): boolean {
  const candidateRelativePath = relative(rootPath, candidatePath);
  return candidateRelativePath === ""
    || (candidateRelativePath !== ".."
      && !candidateRelativePath.startsWith(`..${sep}`)
      && !isAbsolute(candidateRelativePath));
}

async function physicalWorkspaceSearchPath(cwd: string, requestedPath: string): Promise<string> {
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
async function containedWorkspacePath(cwd: string, requestedPath: string): Promise<string> {
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
async function toWorkspaceToolPath(cwd: string, absolutePath: string): Promise<string> {
  const workspacePath = await realpath(cwd);
  const relativePath = relative(workspacePath, absolutePath);
  if (relativePath === "") return ".";
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("Refusing to pass a path outside the workspace to a direct file adapter");
  }
  return relativePath;
}

async function readContainedTextFile(
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

function checkGrepBudget(signal: AbortSignal | undefined, deadline: number): void {
  throwIfAborted(signal);
  if (Date.now() > deadline) throw new Error("grep timed out after 20 seconds");
}

const SKIPPABLE_SEARCH_ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"]);

/**
 * Skip a search entry that is legitimately unreadable, and rethrow every other
 * failure so a truncated search never looks like a complete one.
 */
function skipUnreadableSearchEntry(error: unknown): undefined {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code && SKIPPABLE_SEARCH_ERROR_CODES.has(code)) return undefined;
  throw error;
}

async function collectLocalFiles(
  searchPath: string,
  rootPath: string,
  globPattern: string | undefined,
  fileType: string | undefined,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<string[]> {
  checkGrepBudget(signal, deadline);
  const info = await lstat(searchPath);
  if (info.isFile()) return matchesFileType(searchPath, fileType) ? [searchPath] : [];
  if (!info.isDirectory()) return [];

  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    checkGrepBudget(signal, deadline);
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      skipUnreadableSearchEntry(error);
      return [];
    });
    for (const entry of entries) {
      checkGrepBudget(signal, deadline);
      if (entry.isDirectory() && SKIPPED_SEARCH_DIRS.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const relativePath = toPosixPath(relative(rootPath, absolutePath));
        if ((!globPattern || globMatches(globPattern, relativePath)) && matchesFileType(absolutePath, fileType)) {
          files.push(absolutePath);
          if (files.length > MAX_GROK_GREP_ENTRY_LIMIT) {
            throw new Error(`grep file limit exceeded (${MAX_GROK_GREP_ENTRY_LIMIT})`);
          }
        }
      }
    }
  }

  await visit(searchPath);
  return files;
}

function boundedContext(value: number | undefined): number {
  return Math.min(MAX_GROK_GREP_CONTEXT_LINES, Math.max(0, value ?? 0));
}

interface GrepMatchResult {
  count: number;
  ranges: Array<{ start: number; end: number }>;
}

interface GrepWorkerResponse {
  id: number;
  result?: GrepMatchResult;
  error?: boolean;
}

class GrokGrepMatcher {
  private readonly worker = new Worker(
    new URL("./grok-native-grep-worker.mjs", import.meta.url),
  );

  private requestId = 0;

  async find(
    content: string,
    pattern: string,
    ignoreCase: boolean,
    multiline: boolean,
    storedRangeLimit: number,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<GrepMatchResult> {
    checkGrepBudget(signal, deadline);
    const id = ++this.requestId;
    return new Promise<GrepMatchResult>((resolveMatch, rejectMatch) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.worker.off("message", onMessage);
        this.worker.off("error", onError);
        this.worker.off("exit", onExit);
      };
      const settle = (error: Error | undefined, result?: GrepMatchResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          void this.worker.terminate();
          rejectMatch(error);
        } else {
          resolveMatch(result ?? { count: 0, ranges: [] });
        }
      };
      const onMessage = (message: GrepWorkerResponse) => {
        if (message.id !== id) return;
        settle(
          message.error ? new Error("grep matcher rejected the regular expression") : undefined,
          message.result,
        );
      };
      const onError = () => settle(new Error("grep matcher worker failed"));
      const onExit = () => settle(new Error("grep matcher worker stopped unexpectedly"));
      const onAbort = () => settle(new Error("Operation aborted"));
      const timer = setTimeout(
        () => settle(new Error("grep timed out after 20 seconds")),
        Math.max(1, deadline - Date.now()),
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      this.worker.on("message", onMessage);
      this.worker.once("error", onError);
      this.worker.once("exit", onExit);
      try {
        this.worker.postMessage({
          id,
          content,
          pattern,
          ignoreCase,
          multiline,
          storedRangeLimit,
        });
      } catch {
        settle(new Error("grep matcher worker could not accept input"));
      }
    });
  }

  async close(): Promise<void> {
    await this.worker.terminate().catch(() => undefined);
  }
}

function truncateGrepLine(line: string): string {
  return line.length <= MAX_GROK_GREP_LINE_CHARS
    ? line
    : `${line.slice(0, MAX_GROK_GREP_LINE_CHARS - 1)}…`;
}

async function runLocalGrep(
  cwd: string,
  params: ReturnType<typeof grepArgsForLocalSearch>,
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + GROK_GREP_TIMEOUT_MS;
  checkGrepBudget(signal, deadline);
  const requestedPath = params.path || ".";
  const searchPath = await physicalWorkspaceSearchPath(cwd, requestedPath).catch((error) => {
    if (error instanceof Error && /outside the workspace/.test(error.message)) throw error;
    throw new Error(`Path not found: ${safeWorkspacePath(cwd, requestedPath)}`);
  });
  const searchInfo = await lstat(searchPath);
  const outputMode = params.outputMode ?? "content";
  if (!["content", "files_with_matches", "count"].includes(outputMode)) {
    throw new Error(`Unsupported grep output_mode: ${outputMode}`);
  }
  const entryMode = outputMode !== "content";
  const defaultLimit = entryMode ? DEFAULT_GROK_GREP_ENTRY_LIMIT : DEFAULT_GROK_GREP_LIMIT;
  const maximumLimit = entryMode ? MAX_GROK_GREP_ENTRY_LIMIT : MAX_GROK_GREP_LIMIT;
  const limit = Math.min(maximumLimit, params.limit ?? defaultLimit);
  const sharedContext = boundedContext(params.context);
  const beforeContext = boundedContext(params.beforeContext ?? sharedContext);
  const afterContext = boundedContext(params.afterContext ?? sharedContext);
  const files = await collectLocalFiles(
    searchPath,
    searchPath,
    params.glob,
    params.type,
    signal,
    deadline,
  );
  const outputLines: string[] = [];
  let outputBytes = 0;
  let outputCount = 0;
  let matched = false;
  let limitReached = false;
  let byteLimitReached = false;
  let scanLimitReached = false;
  let totalScannedBytes = 0;

  const appendOutputLine = (line: string): boolean => {
    const bytes = Buffer.byteLength(`${outputLines.length > 0 ? "\n" : ""}${line}`, "utf8");
    if (outputBytes + bytes > MAX_GROK_GREP_OUTPUT_BYTES) {
      byteLimitReached = true;
      return false;
    }
    outputLines.push(line);
    outputBytes += bytes;
    outputCount += 1;
    return true;
  };

  createSafeRegexMatcher(params.pattern, !!params.ignoreCase, !!params.multiline);
  const matcherWorker = new GrokGrepMatcher();
  try {
    for (const filePath of files) {
    checkGrepBudget(signal, deadline);
    if (limit > 0 && outputCount >= limit) {
      limitReached = true;
      break;
    }
    const info = await lstat(filePath).catch(skipUnreadableSearchEntry);
    if (!info?.isFile() || info.size > MAX_GROK_GREP_FILE_BYTES) continue;
    if (totalScannedBytes + info.size > MAX_GROK_GREP_TOTAL_BYTES) {
      scanLimitReached = true;
      break;
    }
    totalScannedBytes += info.size;
    const rawContent = await readFile(filePath, "utf8").catch(skipUnreadableSearchEntry);
    if (rawContent === undefined) continue;
    checkGrepBudget(signal, deadline);
    const content = rawContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = content.split("\n");
    const storedRangeLimit = outputMode === "content" ? limit + 1 : 1;
    const fileMatches = await matcherWorker.find(
      content,
      params.pattern,
      !!params.ignoreCase,
      !!params.multiline,
      storedRangeLimit,
      signal,
      deadline,
    );
    if (fileMatches.count === 0) continue;
    matched = true;
    const displayPath = searchInfo.isDirectory()
      ? toPosixPath(relative(searchPath, filePath))
      : toPosixPath(relative(await realpath(cwd), filePath));

    if (outputMode === "files_with_matches" || outputMode === "count") {
      if (outputCount >= limit) {
        limitReached = true;
        break;
      }
      const line = outputMode === "count" ? `${displayPath}:${fileMatches.count}` : displayPath;
      if (!appendOutputLine(line)) break;
      continue;
    }

    const matchingLines = new Set<number>();
    const outputIndexes = new Set<number>();
    for (const range of fileMatches.ranges) {
      for (let index = range.start; index <= range.end; index += 1) matchingLines.add(index);
      const start = Math.max(0, range.start - beforeContext);
      const end = Math.min(lines.length - 1, range.end + afterContext);
      for (let index = start; index <= end; index += 1) outputIndexes.add(index);
      if (outputIndexes.size > limit) break;
    }
    for (const index of [...outputIndexes].sort((left, right) => left - right)) {
      if (outputCount >= limit) {
        limitReached = true;
        break;
      }
      const separator = matchingLines.has(index) ? ":" : "-";
      const line = `${displayPath}${separator}${index + 1}${separator} ${truncateGrepLine(lines[index])}`;
      if (!appendOutputLine(line)) break;
    }
    if (limitReached || byteLimitReached) break;
    }
  } finally {
    await matcherWorker.close();
  }

  if (!matched) {
    return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
  }

  const notices: string[] = [];
  if (limitReached) notices.push(`[${limit} output line limit reached]`);
  if (byteLimitReached) notices.push(`[${MAX_GROK_GREP_OUTPUT_BYTES} byte output limit reached]`);
  if (scanLimitReached) notices.push(`[${MAX_GROK_GREP_TOTAL_BYTES} byte scan limit reached]`);
  const text = [...outputLines, ...(notices.length > 0 ? ["", ...notices] : [])].join("\n");
  return {
    content: [{ type: "text" as const, text }],
    details: notices.length > 0
      ? { outputLimitReached: limitReached, byteLimitReached, scanLimitReached }
      : undefined,
  };
}

function normalizeCrlfForExactMatch(value: string): {
  normalized: string;
  rawBoundaries: number[];
} {
  let normalized = "";
  const rawBoundaries = [0];
  for (let rawIndex = 0; rawIndex < value.length;) {
    if (value[rawIndex] === "\r" && value[rawIndex + 1] === "\n") {
      normalized += "\n";
      rawIndex += 2;
    } else {
      normalized += value[rawIndex];
      rawIndex += 1;
    }
    rawBoundaries.push(rawIndex);
  }
  return { normalized, rawBoundaries };
}

function replacementLineEnding(
  value: string,
  start: number,
  end: number,
): "\n" | "\r\n" {
  const inMatch = value.indexOf("\n", start);
  const newlineIndex = inMatch >= 0 && inMatch < end
    ? inMatch
    : value.indexOf("\n", end);
  if (newlineIndex >= 0) return value[newlineIndex - 1] === "\r" ? "\r\n" : "\n";
  const previous = value.lastIndexOf("\n", Math.max(0, start - 1));
  return previous >= 0 && value[previous - 1] === "\r" ? "\r\n" : "\n";
}

function adaptReplacementLineEndings(value: string, lineEnding: "\n" | "\r\n"): string {
  const normalized = value.replace(/\r\n/g, "\n");
  return lineEnding === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

/**
 * Apply one exact `old_string` → `new_string` replacement against current file
 * bytes. Callers must invoke this only after holding pi's per-file mutation
 * queue so sibling same-file hunks see each other's writes.
 */
function buildExactSearchReplaceContent(
  rawContent: string,
  oldTextRaw: string,
  newTextRaw: string,
  replaceAll: boolean | undefined,
  displayPath: string,
): string {
  const hasBom = rawContent.charCodeAt(0) === 0xfeff;
  const body = hasBom ? rawContent.slice(1) : rawContent;
  const { normalized: matchText, rawBoundaries } = normalizeCrlfForExactMatch(body);
  const oldText = oldTextRaw.replace(/\r\n/g, "\n");
  const positions: number[] = [];
  let searchOffset = 0;
  while (true) {
    const matchOffset = matchText.indexOf(oldText, searchOffset);
    if (matchOffset < 0) break;
    positions.push(matchOffset);
    searchOffset = matchOffset + oldText.length;
  }
  if (positions.length === 0) {
    throw new Error(`search_replace could not find old_string in ${displayPath}`);
  }
  if (!replaceAll && positions.length !== 1) {
    throw new Error(
      `search_replace found ${positions.length} occurrences; make old_string unique or set replace_all=true`,
    );
  }

  const selectedPositions = replaceAll ? positions : positions.slice(0, 1);
  const chunks: string[] = [];
  let rawCursor = 0;
  for (const position of selectedPositions) {
    const rawStart = rawBoundaries[position];
    const rawEnd = rawBoundaries[position + oldText.length];
    chunks.push(body.slice(rawCursor, rawStart));
    chunks.push(adaptReplacementLineEndings(
      newTextRaw,
      replacementLineEnding(body, rawStart, rawEnd),
    ));
    rawCursor = rawEnd;
  }
  chunks.push(body.slice(rawCursor));
  return `${hasBom ? "\ufeff" : ""}${chunks.join("")}`;
}

async function executeSearchReplace(
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  onUpdate: any,
  ctx: any,
) {
  const normalized = searchReplaceArgsForPi(params);
  if (!normalized.path) throw new Error("search_replace requires file_path");
  if (normalized.oldText === undefined) throw new Error("search_replace requires old_string");
  if (normalized.newText === undefined) throw new Error("search_replace requires new_string");
  if (normalized.oldText === normalized.newText) {
    throw new Error("search_replace requires different old_string and new_string values");
  }

  const absolutePath = await containedWorkspacePath(ctx.cwd, normalized.path);
  const toolPath = await toWorkspaceToolPath(ctx.cwd, absolutePath);

  if (normalized.oldText === "") {
    return createWriteToolDefinition(ctx.cwd).execute(
      toolCallId,
      { path: toolPath, content: normalized.newText },
      signal,
      onUpdate,
      ctx,
    );
  }

  // Re-read and re-apply under pi's per-file mutation queue. Computing the
  // patch from a pre-queue snapshot rejects independent same-file sibling
  // hunks after the first write, even when each old_string is still unique.
  const result = await createWriteToolDefinition(ctx.cwd, {
    operations: {
      mkdir: () => Promise.resolve(),
      async writeFile(queuedPath, _queuedContent) {
        throwIfAborted(signal);
        const rawContent = await readContainedTextFile(queuedPath, normalized.path, signal);
        throwIfAborted(signal);
        const replacementContent = buildExactSearchReplaceContent(
          rawContent,
          normalized.oldText,
          normalized.newText,
          normalized.replaceAll,
          normalized.path,
        );
        throwIfAborted(signal);
        await writeFileUtf8(queuedPath, replacementContent, "utf8");
      },
    },
  }).execute(
    toolCallId,
    // Content is computed under the queue lock; the write tool only needs a
    // path to join the per-file mutation queue.
    { path: toolPath, content: "" },
    signal,
    onUpdate,
    ctx,
  );
  return {
    ...result,
    content: [{ type: "text" as const, text: `Successfully replaced text in ${normalized.path}` }],
  };
}

async function executeReadFile(
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  onUpdate: any,
  ctx: any,
) {
  const prepared = prepareReadFileArgs(params);
  if (!prepared.target_file) throw new Error("read_file requires target_file");
  if (extname(prepared.target_file).toLowerCase() === ".pdf") {
    throw new Error(
      "read_file PDF pages/format are unavailable in this pi adapter; use a workspace text export",
    );
  }
  const absolutePath = await containedWorkspacePath(ctx.cwd, prepared.target_file);
  const toolPath = await toWorkspaceToolPath(ctx.cwd, absolutePath);
  const piArgs = {
    ...readFileArgsForPi(prepared),
    path: toolPath,
  };
  if (prepared.offset !== undefined && prepared.offset < 0) {
    throwIfAborted(signal);
    const content = await readContainedTextFile(absolutePath, prepared.target_file, signal);
    throwIfAborted(signal);
    const readableFields = content.split("\n").length;
    const totalFields = readableFields
      + (content.length > 0 && !content.endsWith("\n") ? 1 : 0);
    piArgs.offset = Math.max(1, totalFields + prepared.offset + 1);
    if (piArgs.offset > readableFields) {
      return { content: [{ type: "text" as const, text: "" }], details: undefined };
    }
  }
  return createReadToolDefinition(ctx.cwd).execute(
    toolCallId,
    piArgs as any,
    signal,
    onUpdate,
    ctx,
  );
}

/**
 * Pi session metadata that Pi 0.82+ injects into bash-tool child processes.
 *
 * Official semantics: https://github.com/earendil-works/pi/blob/v0.82.0/packages/coding-agent/docs/environment-variables.md#bash-tool-session-environment
 */
const PI_SESSION_ENVIRONMENT_KEYS = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;

/**
 * Session-environment policy for `xai_grok_run_terminal_command` (issue #145).
 *
 * Decision: **do not** inherit Pi's session metadata. The Grok-native terminal
 * adapter executes commands authored by a third-party model (xAI/Grok), not
 * commands authored directly by the local operator. Pi's built-in bash tool
 * exposes `PI_*` for the user's own agent; this adapter instead runs commands chosen by
 * a remote model, so the same values become a passive disclosure channel:
 * `PI_SESSION_FILE` points at the live transcript JSONL (which this package's
 * own docs note holds encrypted reasoning and full conversation state), and
 * `PI_PROVIDER`/`PI_MODEL`/`PI_REASONING_LEVEL` let a command fingerprint the
 * operator's configuration. The adapter already documents that its filesystem
 * access is intentionally unsandboxed, so a single `cat "$PI_SESSION_FILE"`
 * would turn "broad local shell" into "one-step transcript exfiltration".
 * Suppressing five variables costs nothing: no Grok tool contract references
 * them, and the shell keeps every other inherited variable.
 *
 * Implementation note: the 0.82-only `exposeSessionEnvironment: false` option is
 * deliberately not used. It does not exist in `BashToolOptions` on 0.80.1, so
 * passing it would be a silent no-op there rather than a policy. `spawnHook`
 * exists across the whole supported range and runs last, after Pi has populated
 * the environment, which makes deletion authoritative on every boundary: on
 * 0.82 it removes the values Pi just injected, and on 0.80.1 it removes any
 * stale `PI_*` inherited from the parent process instead of leaving them.
 */
function applyTerminalSessionEnvironmentPolicy<T extends { env: NodeJS.ProcessEnv }>(
  context: T,
): T {
  for (const key of PI_SESSION_ENVIRONMENT_KEYS) delete context.env[key];
  return context;
}

function uniqueToolNames(toolNames: string[]): string[] {
  return [...new Set(toolNames)];
}

/** Enable Grok-native local adapters for every active `xai-auth` model. */
export function syncGrokNativeToolsForModel(api: any, model?: Model<Api>) {
  if (typeof api?.getActiveTools !== "function" || typeof api?.setActiveTools !== "function") return;

  let activeTools: string[];
  try {
    const current = api.getActiveTools();
    activeTools = Array.isArray(current) ? (current as string[]) : [];
  } catch {
    // A later model/session hook retries when the registry becomes available.
    return;
  }

  const nativeNames = XAI_GROK_NATIVE_AUTO_TOOL_NAMES as readonly string[];
  const cleaned = activeTools.filter((toolName) => !nativeNames.includes(toolName));
  const nextTools = model?.provider === XAI_PROVIDER_ID
    ? uniqueToolNames([...cleaned, ...nativeNames])
    : cleaned;
  const unchanged = nextTools.length === activeTools.length
    && nextTools.every((toolName, index) => toolName === activeTools[index]);
  if (unchanged) return;

  try {
    api.setActiveTools(nextTools);
  } catch {
    // Ignore transient registry failures; a later synchronization retries.
  }
}

/** Register collision-free pi dispatchers exposed to xAI under Grok's official names. */
export function registerGrokNativeTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "xai_grok_read_file",
    label: XAI_GROK_NATIVE_TOOL_NAME_MAP.xai_grok_read_file,
    description:
      "Read a workspace-contained file using Grok's native target_file/offset/limit contract. Relative and in-workspace absolute paths are supported.",
    promptSnippet: "Read a file with target_file and optional offset/limit",
    parameters: readFileSchema,
    prepareArguments: prepareReadFileArgs,
    execute: executeReadFile,
  } as any);

  pi.registerTool({
    name: "xai_grok_search_replace",
    label: XAI_GROK_NATIVE_TOOL_NAME_MAP.xai_grok_search_replace,
    description:
      "Replace exact text in a workspace-contained file. old_string must be unique unless replace_all=true; an empty old_string overwrites an existing file or creates a safe contained leaf.",
    promptSnippet: "Replace exact text with file_path, old_string, and new_string",
    parameters: searchReplaceSchema,
    prepareArguments: prepareSearchReplaceArgs,
    execute: executeSearchReplace,
  } as any);

  pi.registerTool({
    name: "xai_grok_list_dir",
    label: XAI_GROK_NATIVE_TOOL_NAME_MAP.xai_grok_list_dir,
    description:
      "List a workspace-contained directory using Grok's native target_directory contract. Relative and in-workspace absolute paths are supported.",
    promptSnippet: "List a directory with target_directory",
    parameters: listDirSchema,
    prepareArguments: prepareListDirArgs,
    execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
      const prepared = prepareListDirArgs(params);
      const absolutePath = await containedWorkspacePath(ctx.cwd, prepared.target_directory);
      const toolPath = await toWorkspaceToolPath(ctx.cwd, absolutePath);
      return createLsToolDefinition(ctx.cwd).execute(
        toolCallId,
        { ...listDirArgsForPi(params), path: toolPath } as any,
        signal,
        onUpdate,
        ctx,
      );
    },
  } as any);

  pi.registerTool({
    name: "xai_grok_grep",
    label: XAI_GROK_NATIVE_TOOL_NAME_MAP.xai_grok_grep,
    description:
      "Search file contents with a bounded safe regular expression and Grok-compatible path/glob/context arguments.",
    promptSnippet: "Search file contents with pattern and optional path/glob/context filters",
    parameters: grepSchema,
    prepareArguments: prepareGrepArgs,
    execute: async (_toolCallId: string, params: any, signal: any, _onUpdate: any, ctx: any) =>
      runLocalGrep(ctx.cwd, grepArgsForLocalSearch(params), signal),
  } as any);

  pi.registerTool({
    name: "xai_grok_run_terminal_command",
    label: XAI_GROK_NATIVE_TOOL_NAME_MAP.xai_grok_run_terminal_command,
    description:
      "Run a foreground shell command through pi bash. Filesystem access is not workspace-contained; timeout is in milliseconds and background=true is rejected.",
    promptSnippet: "Run a foreground shell command with command, description, and optional timeout",
    promptGuidelines: [
      "Use run_terminal_command with background=false; this adapter cannot manage Grok background tasks.",
    ],
    parameters: terminalCommandSchema,
    prepareArguments: prepareTerminalCommandArgs,
    execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
      const normalized = terminalCommandArgsForPi(params);
      if (!normalized.command) throw new Error("run_terminal_command requires command");
      if (normalized.background) {
        throw new Error(
          "run_terminal_command background=true is unavailable: pi has no managed background-task lifecycle",
        );
      }
      return createBashToolDefinition(ctx.cwd, {
        spawnHook: applyTerminalSessionEnvironmentPolicy,
      }).execute(
        toolCallId,
        { command: normalized.command, timeout: normalized.timeout },
        signal,
        onUpdate,
        ctx,
      );
    },
  } as any);

  pi.registerTool({
    name: XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME,
    label: XAI_GROK_NATIVE_WEB_SEARCH_NAME,
    description:
      "Opt-in paid Grok-native web search. Enable via /xai-tools and call only when the user explicitly requests xAI web search.",
    promptSnippet: "Search the web through xAI with query and optional allowed_domains",
    promptGuidelines: ["Call web_search only when the user explicitly requests xAI web search."],
    parameters: webSearchSchema,
    prepareArguments: prepareWebSearchArgs,
    execute: async (_toolCallId: string, params: any, signal: any, _onUpdate: any, ctx: any) => {
      const { query, allowed_domains: allowedDomains } = prepareWebSearchArgs(params);
      if (!query) return xaiToolError("Error: web_search requires a query.");
      const activeModel = activeXaiModel(ctx);
      if (!activeModel) {
        return xaiToolError(
          "Error: web_search requires an active xAI/Grok model. No xAI request was sent.",
        );
      }
      if (!isXaiNetworkToolActive(pi, XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME)) {
        return xaiToolError(
          "Error: web_search is disabled. Run /xai-tools to enable it and request it explicitly. No xAI request was sent.",
        );
      }
      const credential = await resolveXaiCredential(ctx);
      if (!credential) {
        return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.");
      }

      try {
        const webSearchTool = {
          type: "web_search",
          enable_image_understanding: true,
          ...(allowedDomains ? { filters: { allowed_domains: allowedDomains } } : {}),
        };
        const data = await createXaiResponse(
          credential,
          {
            model: activeModel.id,
            input: `Search the web for: ${query}\n\nSummarize the key results with sources where available.`,
            tools: [webSearchTool],
          },
          signal,
        );
        const text = extractStrictResponsesText(data) || `No results for: ${query}`;
        return {
          content: [{ type: "text", text }],
          details: { response_id: data.id },
        };
      } catch (error) {
        const status = statusFromError(error);
        return xaiToolError(
          `xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
          { error: true, status },
        );
      }
    },
  } as any);
}
