import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME,
  XAI_GROK_NATIVE_WEB_SEARCH_NAME,
} from "../constants";
import {
  XAI_VISION_ROUTING_NAME,
  type XaiVisionRoutingController,
} from "../vision-routing";
import {
  activeXaiModel,
  isXaiNetworkToolActive,
  setXaiNetworkToolActive,
  type XaiNetworkToolName,
} from "./model-scope";

interface NetworkToolOption {
  name: XaiNetworkToolName;
  displayName?: string;
  category: string;
  costRisk: string;
  summary: string;
}

const NETWORK_TOOL_OPTIONS: readonly NetworkToolOption[] = [
  { name: "xai_generate_text", category: "generation", costRisk: "token usage", summary: "separate Grok response" },
  { name: "xai_x_search", category: "search", costRisk: "token + tool", summary: "native xAI X search" },
  { name: "xai_multi_agent", category: "research", costRisk: "high/variable", summary: "4- or 16-agent web/X research" },
  { name: "xai_deep_research", category: "research", costRisk: "high/variable", summary: "multi-step web/X research" },
  { name: "xai_code_execution", category: "execution", costRisk: "token + tool", summary: "xAI code interpreter" },
  { name: "xai_generate_image", category: "image", costRisk: "per image", summary: "generate 1-4 images" },
  { name: "xai_edit_image", category: "image", costRisk: "Imagine usage", summary: "edit 1-3 local image references" },
  { name: "xai_image_to_video", category: "video", costRisk: "high; long-running", summary: "animate one local image; remote job survives local cancellation" },
  { name: "xai_text_to_speech", category: "voice", costRisk: "per character", summary: "speak text with a Grok voice; saves audio to session storage" },
  { name: "xai_transcribe_audio", category: "voice", costRisk: "audio usage", summary: "transcribe one local audio file with Grok speech-to-text" },
  { name: "xai_analyze_image", category: "vision", costRisk: "token usage", summary: "analyze an image with Grok" },
  { name: "xai_critique", category: "reasoning", costRisk: "token usage", summary: "separate high-reasoning critique" },
  {
    name: XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME,
    displayName: XAI_GROK_NATIVE_WEB_SEARCH_NAME,
    category: "search",
    costRisk: "token + tool",
    summary: "Grok-native web_search",
  },
];

const XAI_TOOLS_USAGE =
  "Usage: /xai-tools [status | enable <tool> | disable <tool>]";

/** Event channel used by pi-clickable-menu (and other extensions) to drive /xai-tools. */
export const XAI_TOOLS_MENU_CHANNEL = "pi-clickable-menu:xai-tools";

const xaiToolsMenuUnsubscribeByApi = new WeakMap<ExtensionAPI, () => void>();

type XaiToolsCommandResult = { ok: true } | { ok: false; error: string };

type XaiToolsMenuDone = (result: XaiToolsCommandResult) => void;

function commandToolName(value: string | undefined): XaiNetworkToolName | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "xai_web_search") return XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME;
  return NETWORK_TOOL_OPTIONS.find(
    ({ name, displayName }) =>
      name.toLowerCase() === normalized || displayName?.toLowerCase() === normalized,
  )?.name;
}

function networkToolDisplayName(toolName: XaiNetworkToolName): string {
  return NETWORK_TOOL_OPTIONS.find(({ name }) => name === toolName)?.displayName ?? toolName;
}

function eligibleToolOptions(): readonly NetworkToolOption[] {
  return NETWORK_TOOL_OPTIONS;
}

function visionRoutingStatus(
  visionRouting: XaiVisionRoutingController | undefined,
  model?: Model<Api>,
): string {
  if (!visionRouting) return `${XAI_VISION_ROUTING_NAME}=unavailable`;
  const status = visionRouting.status(model);
  if (status.state === "enabled") {
    return `${XAI_VISION_ROUTING_NAME}=enabled (${status.sourceModelId} -> ${status.targetModelId})`;
  }
  if (status.state === "eligible") return `${XAI_VISION_ROUTING_NAME}=disabled (eligible target ${status.targetModelId})`;
  if (status.state === "unavailable") return `${XAI_VISION_ROUTING_NAME}=unavailable (${status.reason})`;
  return `${XAI_VISION_ROUTING_NAME}=disabled`;
}

function activeToolStatus(
  pi: ExtensionAPI,
  visionRouting?: XaiVisionRoutingController,
  model?: Model<Api>,
): string {
  return [
    ...NETWORK_TOOL_OPTIONS.map(({ name, displayName }) =>
      `${displayName ?? name}=${isXaiNetworkToolActive(pi, name) ? "enabled" : "disabled"}`
    ),
    visionRoutingStatus(visionRouting, model),
  ].join(", ");
}

function notifyUpdate(
  ctx: ExtensionCommandContext,
  toolName: XaiNetworkToolName,
  active: boolean,
  error?: string,
) {
  if (error) {
    ctx.ui.notify(error, "error");
    return;
  }
  const displayName = networkToolDisplayName(toolName);
  const enabledMessage = toolName === "xai_image_to_video"
    ? `Enabled ${displayName} for this xAI session. Video generation can be high-cost and take up to five minutes; local cancellation does not cancel a submitted remote job.`
    : `Enabled ${displayName} for this xAI session. Calls may use xAI credits.`;
  ctx.ui.notify(
    active
      ? enabledMessage
      : `Disabled ${displayName}.`,
    active ? "warning" : "info",
  );
}

function handleVisionRoutingUpdate(
  visionRouting: XaiVisionRoutingController | undefined,
  action: "enable" | "disable",
  model: Model<Api> | undefined,
  ctx: ExtensionCommandContext,
): XaiToolsCommandResult {
  if (!visionRouting) {
    const error = "xAI vision routing is unavailable.";
    ctx.ui.notify(error, "error");
    return { ok: false, error };
  }

  const result = action === "enable" ? visionRouting.enable(model) : visionRouting.disable();
  if (result.state === "enabled") {
    ctx.ui.notify(
      `Enabled vision routing for this xAI session: images are sent to ${result.targetModelId} in a separate authenticated request that may consume additional usage or credits; its generated description becomes sensitive session content. No cross-request image or description cache is created.`,
      "warning",
    );
    return { ok: true };
  }
  if (action === "disable") {
    ctx.ui.notify("Disabled vision routing.", "info");
    return { ok: true };
  }

  const error = result.reason ?? "xAI vision routing is unavailable.";
  ctx.ui.notify(error, "error");
  return { ok: false, error };
}

async function showXaiToolSelectLoop(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  model: Model<Api>,
) {
  while (true) {
    const labels = new Map<string, XaiNetworkToolName>();
    for (const option of eligibleToolOptions()) {
      const active = isXaiNetworkToolActive(pi, option.name);
      const displayName = option.displayName ?? option.name;
      labels.set(
        `${active ? "[x]" : "[ ]"} ${displayName} — ${option.category}; ${option.costRisk}; ${option.summary}`,
        option.name,
      );
    }
    const done = "Done";
    const selected = await ctx.ui.select(
      "xAI API tools — explicit opt-in; enabled calls may use xAI credits",
      [...labels.keys(), done],
    );
    if (!selected || selected === done) return;

    const toolName = labels.get(selected);
    if (!toolName) continue;
    const nextActive = !isXaiNetworkToolActive(pi, toolName);
    const result = setXaiNetworkToolActive(pi, model, toolName, nextActive);
    notifyUpdate(ctx, toolName, result.active, result.error);
    if (!result.ok) return;
  }
}

async function showXaiToolTuiPicker(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  model: Model<Api>,
) {
  const options = eligibleToolOptions();
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    let selectedIndex = 0;
    const maxVisible = 10;

    const refresh = () => tui.requestRender();
    const moveSelection = (offset: number) => {
      if (options.length === 0) return;
      // When offset is a multiple of the list length (e.g. page size === 10
      // tools), bare `%` is a no-op. Keep paging moving by one step in the
      // requested direction so Page Up/Down still wrap.
      let step = offset % options.length;
      if (step === 0 && offset !== 0) {
        step = Math.sign(offset);
      }
      selectedIndex = ((selectedIndex + step) % options.length + options.length) % options.length;
      refresh();
    };
    const toggleSelected = () => {
      const option = options[selectedIndex];
      if (!option) return;
      const nextActive = !isXaiNetworkToolActive(pi, option.name);
      const result = setXaiNetworkToolActive(pi, model, option.name, nextActive);
      notifyUpdate(ctx, option.name, result.active, result.error);
      refresh();
    };

    return {
      render(width: number) {
        const lines = [
          theme.fg("accent", theme.bold("xAI API tools — explicit opt-in; calls may use xAI credits")),
          "",
        ];
        const startIndex = Math.max(
          0,
          Math.min(selectedIndex - Math.floor(maxVisible / 2), options.length - maxVisible),
        );
        const endIndex = Math.min(startIndex + maxVisible, options.length);
        const maxRowWidth = Math.max(1, width - 2);

        for (let index = startIndex; index < endIndex; index += 1) {
          const option = options[index];
          if (!option) continue;
          const active = isXaiNetworkToolActive(pi, option.name);
          const marker = index === selectedIndex ? "> " : "  ";
          const displayName = option.displayName ?? option.name;
          const text = `${marker}${active ? "[x]" : "[ ]"} ${displayName} — ${option.category}; ${option.costRisk}; ${option.summary}`
            .slice(0, maxRowWidth);
          lines.push(
            index === selectedIndex
              ? theme.bg("selectedBg", theme.fg("accent", text))
              : theme.fg(active ? "success" : "text", text),
          );
        }

        if (startIndex > 0 || endIndex < options.length) {
          lines.push(theme.fg("dim", `  (${selectedIndex + 1}/${options.length})`));
        }
        lines.push("", theme.fg("muted", "  ↑/↓ move · Enter/Space toggle · Esc done"));
        return lines;
      },
      invalidate() {},
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.up")) {
          moveSelection(-1);
        } else if (keybindings.matches(data, "tui.select.down")) {
          moveSelection(1);
        } else if (keybindings.matches(data, "tui.select.pageUp")) {
          moveSelection(-maxVisible);
        } else if (keybindings.matches(data, "tui.select.pageDown")) {
          moveSelection(maxVisible);
        } else if (keybindings.matches(data, "tui.select.confirm") || data === " ") {
          toggleSelected();
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done();
        }
      },
    };
  });
}

async function showXaiToolPicker(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  model: Model<Api>,
): Promise<XaiToolsCommandResult> {
  if (!ctx.hasUI) {
    const error = `${XAI_TOOLS_USAGE} Interactive selection requires TUI or RPC mode.`;
    ctx.ui.notify(error, "error");
    return { ok: false, error };
  }
  if (ctx.mode === "tui") {
    await showXaiToolTuiPicker(pi, ctx, model);
    return { ok: true };
  }
  await showXaiToolSelectLoop(pi, ctx, model);
  return { ok: true };
}

/** Shared /xai-tools argument handler (slash command + menu bridge). */
async function handleXaiToolsArgs(
	pi: ExtensionAPI,
	visionRouting: XaiVisionRoutingController | undefined,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<XaiToolsCommandResult> {
	const [action, rawToolName, ...extra] = args.trim().split(/\s+/).filter(Boolean);
	const model = activeXaiModel(ctx);

	if (!action) {
		if (!model) {
			const error = "Select an xAI/Grok model before opening /xai-tools.";
			ctx.ui.notify(error, "error");
			return { ok: false, error };
		}
		return showXaiToolPicker(pi, ctx, model);
	}

	if (action.toLowerCase() === "status" && !rawToolName) {
		ctx.ui.notify(
			`xAI API tools${model ? ` for ${model.id}` : " (no active xAI model)"}: ${activeToolStatus(pi, visionRouting, model)}`,
			"info",
		);
		return { ok: true };
	}

	const normalizedAction = action.toLowerCase();
	const requestedName = rawToolName?.toLowerCase();
	if (
		requestedName === XAI_VISION_ROUTING_NAME &&
		(normalizedAction === "enable" || normalizedAction === "disable") &&
		extra.length === 0
	) {
		return handleVisionRoutingUpdate(visionRouting, normalizedAction, model, ctx);
	}

	const toolName = commandToolName(rawToolName);
	if (
		(normalizedAction !== "enable" && normalizedAction !== "disable") ||
		!toolName ||
		extra.length > 0
	) {
		ctx.ui.notify(XAI_TOOLS_USAGE, "error");
		return { ok: false, error: XAI_TOOLS_USAGE };
	}

	const result = setXaiNetworkToolActive(
		pi,
		model,
		toolName,
		normalizedAction === "enable",
	);
	if (result.ok) {
		notifyUpdate(ctx, toolName, result.active);
		return { ok: true };
	}
	const error = result.error ?? "The xAI tool request failed.";
	notifyUpdate(ctx, toolName, result.active, error);
	return { ok: false, error };
}

/** Register the package-owned command for explicitly managing network-backed xAI tools. */
export function registerXaiToolsCommand(
	pi: ExtensionAPI,
	visionRouting?: XaiVisionRoutingController,
) {
	pi.registerCommand("xai-tools", {
		description: "Enable or disable network-backed xAI tools for this session",
		handler: async (args, ctx) => {
			await handleXaiToolsArgs(pi, visionRouting, args, ctx);
		},
	});

	// Bridge for pi-clickable-menu (and peers): emit on XAI_TOOLS_MENU_CHANNEL.
	// Guard: unit fixtures / older Pi builds may omit events.on.
	const on =
		pi.events && typeof pi.events.on === "function"
			? pi.events.on.bind(pi.events)
			: null;
	xaiToolsMenuUnsubscribeByApi.get(pi)?.();
	xaiToolsMenuUnsubscribeByApi.delete(pi);
	if (!on) return;

	const unsubscribe = on(XAI_TOOLS_MENU_CHANNEL, async (raw) => {
		let source: Record<string, unknown> | undefined;
		let done: XaiToolsMenuDone | undefined;
		try {
			if (raw !== null && (typeof raw === "object" || typeof raw === "function")) {
				source = raw as Record<string, unknown>;
				const candidate = source.done;
				if (typeof candidate === "function") done = candidate as XaiToolsMenuDone;
			}
		} catch {
			// A throwing done accessor cannot provide a callable reply path.
			return;
		}

		// A response is impossible without a callable callback. Never dispatch an
		// unacknowledgeable request or throw back through the shared event bus.
		if (!done) return;

		let replied = false;
		const reply = (result: XaiToolsCommandResult) => {
			if (replied) return;
			replied = true;
			try {
				done(result);
			} catch {
				// Ignore host callback failures after the listener has completed its reply.
			}
		};

		try {
			if (!source || Array.isArray(raw) || typeof raw !== "object") {
				reply({ ok: false, error: "xAI tools bridge request must be an object." });
				return;
			}

			const rawAction = source.action;
			if (rawAction !== undefined && typeof rawAction !== "string") {
				reply({ ok: false, error: "xAI tools bridge action must be a string." });
				return;
			}
			const action = (rawAction ?? "open").trim().toLowerCase();

			const rawTool = source.tool;
			if (rawTool !== undefined && typeof rawTool !== "string") {
				reply({ ok: false, error: "xAI tools bridge tool must be a string." });
				return;
			}

			const rawCtx = source.ctx;
			if (!rawCtx || typeof rawCtx !== "object") {
				reply({ ok: false, error: "xAI tools bridge requires a command UI context." });
				return;
			}
			const ctx = rawCtx as ExtensionCommandContext;
			if (!ctx.ui || typeof ctx.ui.notify !== "function") {
				reply({ ok: false, error: "xAI tools bridge requires a command UI context." });
				return;
			}

			if (action === "open") {
				// Menu hosts (pi-clickable-menu) treat a missing done within ~4s as
				// bridge failure. Acknowledge once the interactive picker is accepted
				// for launch — do not wait for the user to close it.
				const model = activeXaiModel(ctx);
				if (!model) {
					const error = "Select an xAI/Grok model before opening /xai-tools.";
					ctx.ui.notify(error, "error");
					reply({ ok: false, error });
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`${XAI_TOOLS_USAGE} Interactive selection requires TUI or RPC mode.`,
						"error",
					);
					reply({ ok: false, error: "Interactive selection requires TUI or RPC mode." });
					return;
				}
				const picker = ctx.mode === "tui" ? ctx.ui.custom : ctx.ui.select;
				if (typeof picker !== "function") {
					reply({ ok: false, error: "xAI tools bridge requires an interactive picker UI." });
					return;
				}
				reply({ ok: true });
				try {
					await showXaiToolPicker(pi, ctx, model);
				} catch {
					// done already acknowledged launch; surface a bounded UI-only error.
					try {
						ctx.ui.notify("xAI tools picker failed.", "error");
					} catch {
						// Ignore notify failures after acknowledgement.
					}
				}
				return;
			}
			if (action === "status") {
				const result = await handleXaiToolsArgs(pi, visionRouting, "status", ctx);
				reply(result);
				return;
			}
			if (action === "enable" || action === "disable") {
				const tool = rawTool?.trim() ?? "";
				if (!tool) {
					reply({ ok: false, error: "xAI tools bridge enable/disable requires tool." });
					return;
				}
				const result = await handleXaiToolsArgs(pi, visionRouting, `${action} ${tool}`, ctx);
				reply(result);
				return;
			}
			reply({ ok: false, error: "Unknown xAI tools bridge action." });
		} catch {
			reply({ ok: false, error: "xAI tools bridge request failed." });
		}
	});
	if (typeof unsubscribe === "function") {
		xaiToolsMenuUnsubscribeByApi.set(pi, unsubscribe);
	}
}
