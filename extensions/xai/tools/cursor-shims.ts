import type { ExtensionAPI, FindOperations } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { readdir, readFile, rm, stat } from "fs/promises";
import { join, relative, sep } from "path";
import { Type } from "typebox";
import { resolveXaiAuthToken } from "../auth";
import { DEFAULT_XAI_MODEL, XAI_CURSOR_TOOL_NAMES, XAI_PROVIDER_ID } from "../constants";
import { isGrokCliProxyModel } from "../models";
import { createXaiResponse } from "../responses";
import { extractResponsesText, messageFromError, statusFromError } from "../text";
import { xaiToolError } from "./common";
import {
  firstString,
  normalizeDeleteArgs,
  normalizeEditArgs,
  normalizeGlobArgs,
  normalizeGrepArgs,
  normalizeLsArgs,
  normalizeReadArgs,
  normalizeShellArgs,
  normalizeWriteArgs,
  objectFromCursorArgs,
  safeWorkspacePath,
} from "./cursor-args";

const DEFAULT_CURSOR_GLOB_LIMIT = 1000;
const DEFAULT_CURSOR_GREP_LIMIT = 1000;
const MAX_CURSOR_REGEX_LENGTH = 500;
const MAX_CURSOR_GREP_CONTEXT_LINES = 20;
const SKIPPED_SEARCH_DIRS = new Set([".git", ".omp", "node_modules"]);

/**
 * TypeBox schema for the Grep shim.
 * `pattern` is required (same as native pi grep) so models cannot omit the search text.
 * `query` remains an optional Cursor/Grok CLI alias and is mapped in prepareArguments.
 */
const grepShimSchema = Type.Object({
  pattern: Type.String({
    description: "REQUIRED search text (regex or literal). This is the string to find in files — not a file glob.",
  }),
  query: Type.Optional(
    Type.String({
      description: "Alias for pattern (Cursor/Grok CLI style). Mapped to pattern before execution.",
    }),
  ),
  path: Type.Optional(Type.String({ description: "Directory or file to search" })),
  include: Type.Optional(
    Type.String({ description: "Glob filter for which files to search, e.g. *.ts (NOT the search text)" }),
  ),
  glob: Type.Optional(
    Type.String({ description: "Glob filter for which files to search, e.g. *.ts (NOT the search text)" }),
  ),
  glob_filter: Type.Optional(Type.String({ description: "Cursor-style alias for glob" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string instead of regex" })),
  context: Type.Optional(Type.Number({ description: "Number of context lines before/after each match" })),
  limit: Type.Optional(Type.Number({ description: "Maximum matches" })),
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
  const matchTarget = normalizedPattern.includes("/") ? normalizedPath : normalizedPath.split("/").pop() || normalizedPath;
  return globToRegExp(normalizedPattern).test(matchTarget);
}

function throwIfAborted(signal: any) {
  if (signal?.aborted) throw new Error("Operation aborted");
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

function createSafeRegexMatcher(pattern: string, ignoreCase: boolean): RegExp {
  if (pattern.length > MAX_CURSOR_REGEX_LENGTH) {
    throw new Error(`Regex pattern exceeds maximum length of ${MAX_CURSOR_REGEX_LENGTH} characters`);
  }
  if (hasUnsafeRegexStructure(pattern)) {
    throw new Error("Unsafe regex pattern: nested quantifiers, quantified alternation, and backreferences are not supported");
  }
  try {
    return new RegExp(pattern, ignoreCase ? "i" : undefined);
  } catch (error) {
    throw new Error(`Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function localGlob(pattern: string, searchPath: string, options: { ignore: string[]; limit: number }): Promise<string[]> {
  const results: string[] = [];
  const limit = Math.max(1, options.limit || DEFAULT_CURSOR_GLOB_LIMIT);

  async function visit(directory: string): Promise<void> {
    if (results.length >= limit) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.isDirectory() && SKIPPED_SEARCH_DIRS.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const relativePath = toPosixPath(relative(searchPath, absolutePath));
        if (globMatches(pattern, relativePath)) results.push(absolutePath);
      }
    }
  }

  await visit(searchPath);
  return results;
}

const localFindOperations: FindOperations = {
  exists: pathExists,
  glob: localGlob,
};

async function collectLocalFiles(searchPath: string, rootPath: string, globPattern: string | undefined, signal: any): Promise<string[]> {
  throwIfAborted(signal);
  const info = await stat(searchPath);
  if (info.isFile()) return [searchPath];
  if (!info.isDirectory()) return [];

  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    throwIfAborted(signal);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      throwIfAborted(signal);
      if (entry.isDirectory() && SKIPPED_SEARCH_DIRS.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const relativePath = toPosixPath(relative(rootPath, absolutePath));
        if (!globPattern || globMatches(globPattern, relativePath)) files.push(absolutePath);
      }
    }
  }

  await visit(searchPath);
  return files;
}

async function runLocalGrep(cwd: string, params: ReturnType<typeof normalizeGrepArgs>, signal: any) {
  throwIfAborted(signal);
  const searchPath = safeWorkspacePath(cwd, params.path || ".");
  const searchInfo = await stat(searchPath).catch(() => undefined);
  if (!searchInfo) throw new Error(`Path not found: ${searchPath}`);

  const pattern = params.pattern || "";
  if (!pattern) {
    throw new Error("Grep requires a non-empty pattern (or query alias)");
  }

  const ignoreCase = !!params.ignoreCase;
  const literalPattern = ignoreCase ? pattern.toLowerCase() : pattern;
  const matcher = params.literal ? undefined : createSafeRegexMatcher(pattern, ignoreCase);
  const limit = Math.max(1, params.limit || DEFAULT_CURSOR_GREP_LIMIT);
  const contextLines = Math.min(
    MAX_CURSOR_GREP_CONTEXT_LINES,
    Math.max(0, Math.floor(params.context || 0)),
  );
  const files = await collectLocalFiles(searchPath, searchPath, params.glob, signal);
  const outputLines: string[] = [];
  let matchCount = 0;
  let limitReached = false;

  for (const filePath of files) {
    if (matchCount >= limit) {
      limitReached = true;
      break;
    }
    const content = await readFile(filePath, "utf8").catch(() => undefined);
    if (content === undefined) continue;
    const displayPath = searchInfo.isDirectory()
      ? toPosixPath(relative(searchPath, filePath))
      : toPosixPath(relative(cwd, filePath));
    const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      throwIfAborted(signal);
      const line = lines[index];
      const matched = params.literal
        ? (ignoreCase ? line.toLowerCase() : line).includes(literalPattern)
        : matcher!.test(line);
      if (!matched) continue;

      const start = Math.max(0, index - contextLines);
      const end = Math.min(lines.length - 1, index + contextLines);
      for (let current = start; current <= end; current += 1) {
        const isMatchLine = current === index;
        const separator = isMatchLine ? ":" : "-";
        outputLines.push(`${displayPath}${separator}${current + 1}${separator} ${lines[current]}`);
      }

      matchCount++;
      if (matchCount >= limit) {
        limitReached = true;
        break;
      }
    }
  }

  if (matchCount === 0) {
    return { content: [{ type: "text", text: "No matches found" }], details: undefined };
  }

  let text = outputLines.join("\n");
  const details: { matchLimitReached?: number } = {};
  if (limitReached) {
    text += `\n\n[${limit} matches limit reached]`;
    details.matchLimitReached = limit;
  }

  return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
}

function uniqueToolNames(toolNames: string[]): string[] {
  return [...new Set(toolNames)];
}

type ActiveToolsApi = {
  getActiveTools?: () => string[];
  setActiveTools?: (toolNames: string[]) => void;
};

type ShimModelRef = {
  id: string;
  provider: string;
};

function resolveActiveToolsApi(primary?: ActiveToolsApi, fallback?: ActiveToolsApi): ActiveToolsApi | undefined {
  for (const candidate of [primary, fallback]) {
    if (typeof candidate?.getActiveTools === "function" && typeof candidate?.setActiveTools === "function") {
      return candidate;
    }
  }
  return undefined;
}

/** Enable Cursor/Grok CLI shims only for Grok CLI proxy models. */
export function syncCursorToolShimsForModel(
  primaryApi: ActiveToolsApi,
  model?: ShimModelRef,
  fallbackApi?: ActiveToolsApi,
) {
  const api = resolveActiveToolsApi(primaryApi, fallbackApi);
  if (!api?.getActiveTools || !api?.setActiveTools) return;

  let activeTools: string[];
  try {
    const listed = api.getActiveTools();
    activeTools = Array.isArray(listed) ? listed : [];
  } catch (error) {
    throw new Error(`Cursor shim sync: failed to read active tools: ${error instanceof Error ? error.message : String(error)}`);
  }

  const withoutCursorShims = activeTools.filter((toolName) => !XAI_CURSOR_TOOL_NAMES.includes(toolName));
  const shouldEnableCursorShims = model?.provider === XAI_PROVIDER_ID && isGrokCliProxyModel(model.id);
  const nextTools = shouldEnableCursorShims ? uniqueToolNames([...withoutCursorShims, ...XAI_CURSOR_TOOL_NAMES]) : withoutCursorShims;

  if (nextTools.length !== activeTools.length || nextTools.some((toolName, index) => toolName !== activeTools[index])) {
    try {
      api.setActiveTools(nextTools);
    } catch (error) {
      throw new Error(`Cursor shim sync: failed to apply active tools: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Register Cursor/Grok CLI compatibility shims. */
export function registerCursorToolShims(pi: ExtensionAPI) {
    pi.registerTool({
      name: "Read",
      label: "Read",
      description: "Cursor/Grok CLI compatibility shim for pi's read tool. Reads a file by path/file_path with optional offset and limit.",
      promptSnippet: "Cursor-style alias for read; accepts path/file_path plus optional offset/limit",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to read" },
          file_path: { type: "string", description: "Cursor-style alias for path" },
          offset: { type: "number", description: "1-indexed line offset" },
          limit: { type: "number", description: "Maximum lines to read" },
        },
      },
      prepareArguments: normalizeReadArgs,
      execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
        return createReadToolDefinition(ctx.cwd).execute(toolCallId, normalizeReadArgs(params) as any, signal, onUpdate, ctx);
      },
    } as any);

    pi.registerTool({
      name: "Write",
      label: "Write",
      description: "Cursor/Grok CLI compatibility shim for pi's write tool. Writes content/contents to path/file_path.",
      promptSnippet: "Cursor-style alias for write; accepts path/file_path and content/contents",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to write" },
          file_path: { type: "string", description: "Cursor-style alias for path" },
          content: { type: "string", description: "Content to write" },
          contents: { type: "string", description: "Cursor-style alias for content" },
        },
      },
      prepareArguments: normalizeWriteArgs,
      execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
        return createWriteToolDefinition(ctx.cwd).execute(toolCallId, normalizeWriteArgs(params) as any, signal, onUpdate, ctx);
      },
    } as any);

    pi.registerTool({
      name: "StrReplace",
      label: "StrReplace",
      description: "Cursor/Grok CLI compatibility shim for exact string replacement. Accepts old_string/new_string or oldText/newText.",
      promptSnippet: "Cursor-style exact string replacement; accepts old_string/new_string",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to edit" },
          file_path: { type: "string", description: "Cursor-style alias for path" },
          old_string: { type: "string", description: "Text to replace" },
          new_string: { type: "string", description: "Replacement text" },
          oldText: { type: "string", description: "pi-style alias for old_string" },
          newText: { type: "string", description: "pi-style alias for new_string" },
        },
      },
      prepareArguments: normalizeEditArgs,
      execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
        return createEditToolDefinition(ctx.cwd).execute(toolCallId, normalizeEditArgs(params) as any, signal, onUpdate, ctx);
      },
    } as any);

    pi.registerTool({
      name: "Edit",
      label: "Edit",
      description: "Cursor/Grok CLI compatibility shim for pi's edit tool. Accepts edits or old_string/new_string aliases.",
      promptSnippet: "Cursor-style alias for edit; accepts edits or old_string/new_string",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to edit" },
          file_path: { type: "string", description: "Cursor-style alias for path" },
          edits: { type: "array", description: "Array of { oldText/old_string, newText/new_string } replacements" },
          old_string: { type: "string", description: "Text to replace" },
          new_string: { type: "string", description: "Replacement text" },
        },
      },
      prepareArguments: normalizeEditArgs,
      execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
        return createEditToolDefinition(ctx.cwd).execute(toolCallId, normalizeEditArgs(params) as any, signal, onUpdate, ctx);
      },
    } as any);

    pi.registerTool({
      name: "Delete",
      label: "Delete",
      description: "Cursor/Grok CLI compatibility shim for deleting a workspace file. Directories require recursive=true.",
      promptSnippet: "Cursor-style delete for workspace files; directories require recursive=true",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to delete" },
          file_path: { type: "string", description: "Cursor-style alias for path" },
          recursive: { type: "boolean", description: "Allow recursive directory deletion" },
        },
      },
      prepareArguments: normalizeDeleteArgs,
      execute: async (_toolCallId: string, params: any, signal: any, _onUpdate: any, ctx: any) => {
        if (signal?.aborted) throw new Error("Operation aborted");
        const { path, recursive } = normalizeDeleteArgs(params);
        if (!path) throw new Error("Delete requires a path");
        const absolutePath = safeWorkspacePath(ctx.cwd, path);
        await rm(absolutePath, { recursive: !!recursive, force: false });
        return { content: [{ type: "text", text: `Deleted ${path}` }], details: undefined };
      },
    } as any);

    pi.registerTool({
      name: "LS",
      label: "LS",
      description: "Cursor/Grok CLI compatibility shim for pi's ls tool. Lists files under path.",
      promptSnippet: "Cursor-style alias for ls; lists files under path",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory or file path" },
          limit: { type: "number", description: "Maximum entries to return" },
        },
      },
      prepareArguments: normalizeLsArgs,
      execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
        return createLsToolDefinition(ctx.cwd).execute(toolCallId, normalizeLsArgs(params) as any, signal, onUpdate, ctx);
      },
    } as any);

    pi.registerTool({
      name: "Grep",
      label: "Grep",
      description:
        "Search file contents for a required pattern (search regex/string). query is an optional alias for pattern. include/glob only filter which files are searched — they are not the search text.",
      promptSnippet: "Search file contents; requires pattern (query alias ok); optional include/glob file filters",
      parameters: grepShimSchema,
      prepareArguments: normalizeGrepArgs,
      execute: async (_toolCallId: string, params: any, signal: any, _onUpdate: any, ctx: any) => {
        // Re-normalize so direct execute() callers (and query-only args) still work.
        return runLocalGrep(ctx.cwd, normalizeGrepArgs(params), signal);
      },
    } as any);

    pi.registerTool({
      name: "Glob",
      label: "Glob",
      description: "Cursor/Grok CLI compatibility shim for pi's find tool. Finds files matching pattern/glob.",
      promptSnippet: "Cursor-style alias for find; accepts pattern/glob",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. **/*.ts" },
          glob: { type: "string", description: "Cursor-style alias for pattern" },
          path: { type: "string", description: "Directory to search" },
          limit: { type: "number", description: "Maximum results" },
        },
      },
      prepareArguments: normalizeGlobArgs,
      execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
        return createFindToolDefinition(ctx.cwd, { operations: localFindOperations }).execute(toolCallId, normalizeGlobArgs(params) as any, signal, onUpdate, ctx);
      },
    } as any);

    pi.registerTool({
      name: "Shell",
      label: "Shell",
      description: "Cursor/Grok CLI compatibility shim for pi's bash tool. Executes command/cmd in the workspace shell.",
      promptSnippet: "Cursor-style alias for bash; executes command/cmd in the workspace shell",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          cmd: { type: "string", description: "Alias for command" },
          timeout: { type: "number", description: "Timeout in milliseconds" },
        },
      },
      prepareArguments: normalizeShellArgs,
      execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
        return createBashToolDefinition(ctx.cwd).execute(toolCallId, normalizeShellArgs(params) as any, signal, onUpdate, ctx);
      },
    } as any);

    pi.registerTool({
      name: "WebSearch",
      label: "WebSearch",
      description: "Cursor/Grok CLI compatibility shim for xAI web search. Searches the web with xAI's native web_search tool.",
      promptSnippet: "Cursor-style web search backed by xAI native web_search",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          search_term: { type: "string", description: "Alias for query" },
        },
      },
      prepareArguments: (args: unknown) => {
        const params = objectFromCursorArgs(args);
        return { query: firstString(params.query, params.search_term, params.value) || "" };
      },
      execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
        const query = firstString(params?.query, params?.search_term, params?.value);
        if (!query) return xaiToolError("Error: WebSearch requires a query.");
        const apiKey = await resolveXaiAuthToken(ctx);
        if (!apiKey) return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.");

        try {
          const data = await createXaiResponse(
            apiKey,
            {
              model: DEFAULT_XAI_MODEL,
              input: `Search the web for: ${query}\n\nSummarize the key results with sources where available.`,
              tools: [{ type: "web_search", enable_image_understanding: true }],
            },
            _signal,
          );
          return { content: [{ type: "text", text: extractResponsesText(data) }], details: { response_id: data.id } };
        } catch (error) {
          const status = statusFromError(error);
          return xaiToolError(`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`, { error: true, status });
        }
      },
    } as any);


}
