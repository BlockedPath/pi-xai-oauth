import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLsToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
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
import { executeReadFile, executeSearchReplace } from "./grok-native-file-tools";
import {
  DEFAULT_GROK_GREP_LIMIT,
  runLocalGrep,
} from "./grok-native-grep";
import {
  grepArgsForLocalSearch,
  listDirArgsForPi,
  prepareGrepArgs,
  prepareListDirArgs,
  prepareReadFileArgs,
  prepareSearchReplaceArgs,
  prepareTerminalCommandArgs,
  prepareWebSearchArgs,
  terminalCommandArgsForPi,
} from "./grok-native-args";
import { containedWorkspacePath, toWorkspaceToolPath } from "./grok-native-paths";
import { activeXaiModel, isXaiNetworkToolActive } from "./model-scope";

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
