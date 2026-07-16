import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { registerXaiUsage } from "../usage";
import { registerXaiToolsCommand } from "./commands";
import { registerCursorToolShims, syncCursorToolShimsForModel } from "./cursor-shims";
import { registerCustomXaiTools } from "./custom-tools";
import { syncXaiNetworkToolsForModel } from "./model-scope";

const xaiToolRegistrations = new WeakSet<object>();

/** Register all xAI tools once per pi API object. */
export function registerXaiTools(pi: ExtensionAPI) {
  if (xaiToolRegistrations.has(pi as object)) return;
  xaiToolRegistrations.add(pi as object);

  registerCursorToolShims(pi);
  registerCustomXaiTools(pi);
  registerXaiToolsCommand(pi);
  registerXaiUsage(pi);
}

/** Synchronize all model-scoped xAI tool availability without making network requests. */
export function syncXaiToolsForModel(pi: ExtensionAPI, model?: Model<Api>, options?: { resetNetworkTools?: boolean }) {
  syncCursorToolShimsForModel(pi, model);
  syncXaiNetworkToolsForModel(pi, model, { reset: options?.resetNetworkTools });
}
