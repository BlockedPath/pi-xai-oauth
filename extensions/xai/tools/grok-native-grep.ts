import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { extname, join, relative, sep } from "node:path";
import { grepArgsForLocalSearch, safeWorkspacePath } from "./grok-native-args";
import {
  nonBlockFlag,
  openUnfollowedFile,
  physicalWorkspaceSearchPath,
  throwIfAborted,
} from "./grok-native-paths";

export const DEFAULT_GROK_GREP_LIMIT = 200;
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

/** Run bounded local grep against workspace-contained paths. */
export async function runLocalGrep(
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
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let rawContent: string | undefined;
    try {
      handle = await openUnfollowedFile(
        filePath,
        constants.O_RDONLY | nonBlockFlag(),
      );
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_GROK_GREP_FILE_BYTES) continue;
      if (totalScannedBytes + info.size > MAX_GROK_GREP_TOTAL_BYTES) {
        scanLimitReached = true;
        break;
      }
      totalScannedBytes += info.size;
      rawContent = await handle.readFile("utf8");
    } catch (error) {
      skipUnreadableSearchEntry(error);
      continue;
    } finally {
      await handle?.close().catch(() => undefined);
    }
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
