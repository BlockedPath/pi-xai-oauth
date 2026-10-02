import { XAI_GROK_NATIVE_TOOL_NAME_MAP } from "./constants";

/** Public Grok tool name -> private pi dispatcher name, for the tools exposed in one request. */
export type GrokNativeToolRoutes = Readonly<Record<string, string>>;

function rewriteGrokDispatchObject(value: unknown, expectedType: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  if (item.type !== expectedType || typeof item.name !== "string") return value;
  const publicName = XAI_GROK_NATIVE_TOOL_NAME_MAP[
    item.name as keyof typeof XAI_GROK_NATIVE_TOOL_NAME_MAP
  ];
  return publicName ? { ...item, name: publicName } : value;
}

function rewriteGrokPublicObject(
  value: unknown,
  expectedType: string,
  routes: GrokNativeToolRoutes,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  if (item.type !== expectedType || typeof item.name !== "string") return value;
  const dispatchName = routes[item.name];
  return dispatchName ? { ...item, name: dispatchName } : value;
}

/** Return the public-to-private routes exposed by this package in the current request. */
export function xaiPayloadGrokNativeToolRoutes(
  payload: Record<string, unknown>,
): Record<string, string> {
  const routes: Record<string, string> = {};
  if (!Array.isArray(payload.tools)) return routes;
  for (const tool of payload.tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    const item = tool as Record<string, unknown>;
    if (item.type !== "function" || typeof item.name !== "string") continue;
    const publicName = XAI_GROK_NATIVE_TOOL_NAME_MAP[
      item.name as keyof typeof XAI_GROK_NATIVE_TOOL_NAME_MAP
    ];
    if (publicName) routes[publicName] = item.name;
  }
  return routes;
}

/**
 * Expose private Grok dispatchers under their official model-facing names.
 *
 * A same-named public definition from another extension is removed only from
 * this outbound xAI request when this package exposes its private equivalent.
 * Pi's active-tool registry is never mutated, so the foreign tool remains
 * available for other providers.
 */
export function exposeGrokNativeToolNames(payload: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const body: Record<string, unknown> = { ...payload };
  const routes = xaiPayloadGrokNativeToolRoutes(payload);
  if (Array.isArray(payload.tools)) {
    const tools: unknown[] = [];
    const emittedRoutedNames = new Set<string>();
    for (const tool of payload.tools) {
      if (tool && typeof tool === "object" && !Array.isArray(tool)) {
        const item = tool as Record<string, unknown>;
        if (item.type === "function" && typeof item.name === "string") {
          const routedPublicName = XAI_GROK_NATIVE_TOOL_NAME_MAP[
            item.name as keyof typeof XAI_GROK_NATIVE_TOOL_NAME_MAP
          ];
          if (routedPublicName) {
            if (emittedRoutedNames.has(routedPublicName)) {
              changed = true;
              continue;
            }
            emittedRoutedNames.add(routedPublicName);
          } else if (routes[item.name]) {
            changed = true;
            continue;
          }
        }
      }
      const rewritten = rewriteGrokDispatchObject(tool, "function");
      if (rewritten !== tool) changed = true;
      tools.push(rewritten);
    }
    body.tools = tools;
  }
  if (Array.isArray(payload.input)) {
    body.input = payload.input.map((item) => {
      const rewritten = rewriteGrokDispatchObject(item, "function_call");
      if (rewritten !== item) changed = true;
      return rewritten;
    });
  }
  const toolChoice = rewriteGrokDispatchObject(payload.tool_choice, "function");
  if (toolChoice !== payload.tool_choice) {
    body.tool_choice = toolChoice;
    changed = true;
  }
  return changed ? body : payload;
}

/** Map public Grok tool calls back to the private pi dispatchers exposed for this request. */
export function internalizeGrokNativeToolCalls(
  value: unknown,
  routes: GrokNativeToolRoutes = {},
): unknown {
  const directToolCall = rewriteGrokPublicObject(value, "toolCall", routes);
  if (directToolCall !== value) return directToolCall;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.content)) return value;
  let changed = false;
  const content = source.content.map((block) => {
    const rewritten = rewriteGrokPublicObject(block, "toolCall", routes);
    if (rewritten !== block) changed = true;
    return rewritten;
  });
  return changed ? { ...source, content } : value;
}
