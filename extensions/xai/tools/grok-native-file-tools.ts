import { createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { extname } from "node:path";
import {
  prepareReadFileArgs,
  readFileArgsForPi,
  searchReplaceArgsForPi,
} from "./grok-native-args";
import {
  containedWorkspacePath,
  readContainedTextFile,
  throwIfAborted,
  toWorkspaceToolPath,
  writeContainedTextFile,
} from "./grok-native-paths";

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

/** Execute Grok-native search_replace through pi's per-file mutation queue. */
export async function executeSearchReplace(
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
  const oldText = normalized.oldText;
  const newText = normalized.newText;
  if (oldText === newText) {
    throw new Error("search_replace requires different old_string and new_string values");
  }

  const absolutePath = await containedWorkspacePath(ctx.cwd, normalized.path);
  const toolPath = await toWorkspaceToolPath(ctx.cwd, absolutePath);

  if (oldText === "") {
    return createWriteToolDefinition(ctx.cwd).execute(
      toolCallId,
      { path: toolPath, content: newText },
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
          oldText,
          newText,
          normalized.replaceAll,
          normalized.path,
        );
        throwIfAborted(signal);
        await writeContainedTextFile(queuedPath, replacementContent, normalized.path, signal);
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

/** Execute Grok-native read_file through pi's read adapter. */
export async function executeReadFile(
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
