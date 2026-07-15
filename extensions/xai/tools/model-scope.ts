import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { XAI_PROVIDER_ID } from "../constants";
import { isGrokCliProxyModel } from "../models";

/** Network-backed xAI tools that make an additional authenticated API request. */
export const XAI_NETWORK_TOOL_NAMES = [
  "xai_generate_text",
  "xai_web_search",
  "xai_x_search",
  "xai_multi_agent",
  "xai_deep_research",
  "xai_code_execution",
  "xai_generate_image",
  "xai_analyze_image",
  "xai_critique",
  "WebSearch",
] as const;

export type XaiNetworkToolName = (typeof XAI_NETWORK_TOOL_NAMES)[number];

export interface XaiNetworkToolUpdateResult {
  ok: boolean;
  active: boolean;
  error?: string;
}

const explicitlyEnabledXaiNetworkTools = new WeakMap<object, Set<XaiNetworkToolName>>();
const xaiNetworkToolNameSet = new Set<string>(XAI_NETWORK_TOOL_NAMES);

function activeToolsWithExplicitNetworkSelection(
  activeTools: readonly string[],
  enabledNetworkTools: ReadonlySet<XaiNetworkToolName>,
): string[] {
  return [
    ...activeTools.filter((name) => !xaiNetworkToolNameSet.has(name)),
    ...XAI_NETWORK_TOOL_NAMES.filter((name) => enabledNetworkTools.has(name)),
  ];
}

/** Return the active xAI model, or undefined when the session is using another provider. */
export function activeXaiModel(ctx: Pick<ExtensionContext, "model"> | undefined): Model<Api> | undefined {
  const model = ctx?.model;
  if (model?.provider !== XAI_PROVIDER_ID || typeof model.id !== "string" || !model.id.trim()) return undefined;
  return model as Model<Api>;
}

/** Return whether a network-backed xAI tool is deliberately active in pi's current tool set. */
export function isXaiNetworkToolActive(api: any, toolName: XaiNetworkToolName): boolean {
  if (typeof api?.getActiveTools !== "function") return false;
  try {
    if (!explicitlyEnabledXaiNetworkTools.get(api as object)?.has(toolName)) return false;
    const activeTools = api.getActiveTools();
    return Array.isArray(activeTools) && activeTools.includes(toolName);
  } catch {
    return false;
  }
}

/** Deliberately enable or disable one network-backed xAI tool for the current model scope. */
export function setXaiNetworkToolActive(
  api: any,
  model: Model<Api> | undefined,
  toolName: XaiNetworkToolName,
  active: boolean,
): XaiNetworkToolUpdateResult {
  const xaiModel = activeXaiModel(model ? { model } : undefined);
  if (active && !xaiModel) {
    return {
      ok: false,
      active: false,
      error: "Select an xAI/Grok model before enabling a network-backed xAI tool.",
    };
  }
  if (active && toolName === "WebSearch" && !isGrokCliProxyModel(xaiModel!.id)) {
    return {
      ok: false,
      active: false,
      error: "WebSearch is available only with xAI Grok Build or Composer models.",
    };
  }
  if (typeof api?.getActiveTools !== "function" || typeof api?.setActiveTools !== "function") {
    return {
      ok: false,
      active: false,
      error: "pi's active-tool registry is unavailable; no tools were changed.",
    };
  }

  const scope = api as object;
  const previousSelection = new Set(explicitlyEnabledXaiNetworkTools.get(scope) ?? []);
  // Always copy the prior opt-in set. Disable without an active xAI model must
  // remove only the named tool — never replace the whole authorization set with
  // an empty set or delete every remaining opt-in.
  const nextSelection = new Set(previousSelection);
  if (xaiModel && !isGrokCliProxyModel(xaiModel.id)) nextSelection.delete("WebSearch");
  if (active) nextSelection.add(toolName);
  else nextSelection.delete(toolName);

  let activeTools: string[];
  try {
    const current = api.getActiveTools();
    if (!Array.isArray(current)) throw new Error("invalid active-tool registry response");
    activeTools = current as string[];
  } catch {
    return {
      ok: false,
      active: previousSelection.has(toolName),
      error: "pi's active-tool registry could not be read; no tools were changed.",
    };
  }

  const nextTools = activeToolsWithExplicitNetworkSelection(activeTools, nextSelection);
  try {
    const unchanged = nextTools.length === activeTools.length
      && nextTools.every((name, index) => name === activeTools[index]);
    if (!unchanged) api.setActiveTools(nextTools);
    if (nextSelection.size > 0) explicitlyEnabledXaiNetworkTools.set(scope, nextSelection);
    else explicitlyEnabledXaiNetworkTools.delete(scope);
    return { ok: true, active };
  } catch {
    return {
      ok: false,
      active: previousSelection.has(toolName),
      error: "pi's active-tool registry could not be updated; no tools were changed.",
    };
  }
}

/**
 * Keep network-backed xAI tools opt-in and remove them immediately outside xAI models.
 *
 * A session start resets them even for xAI models so installing or reloading the
 * extension cannot silently expose a credit-gated tool. Users can deliberately
 * enable an individual tool through this package's `/xai-tools` command while
 * an xAI model is active.
 */
export function syncXaiNetworkToolsForModel(api: any, model?: Model<Api>, options?: { reset?: boolean }) {
  if (typeof api?.getActiveTools !== "function" || typeof api?.setActiveTools !== "function") return;
  const scope = api as object;
  const xaiModel = activeXaiModel(model ? { model } : undefined);
  let enabledNetworkTools: Set<XaiNetworkToolName>;
  if (options?.reset || !xaiModel) {
    explicitlyEnabledXaiNetworkTools.delete(scope);
    enabledNetworkTools = new Set();
  } else {
    enabledNetworkTools = new Set(explicitlyEnabledXaiNetworkTools.get(scope) ?? []);
    if (!isGrokCliProxyModel(xaiModel.id)) enabledNetworkTools.delete("WebSearch");
    explicitlyEnabledXaiNetworkTools.set(scope, enabledNetworkTools);
  }

  let activeTools: string[];
  try {
    const current = api.getActiveTools();
    activeTools = Array.isArray(current) ? (current as string[]) : [];
  } catch {
    return;
  }

  const nextTools = activeToolsWithExplicitNetworkSelection(activeTools, enabledNetworkTools);
  const unchanged = nextTools.length === activeTools.length
    && nextTools.every((name, index) => name === activeTools[index]);
  if (unchanged) return;

  try {
    api.setActiveTools(nextTools);
  } catch {
    // The registry can be transiently unavailable during startup. The
    // before_agent_start synchronization retries before any model request.
  }
}
