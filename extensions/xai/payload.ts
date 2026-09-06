import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { XAI_GROK_NATIVE_TOOL_NAME_MAP } from "./constants";
import { grokSupportsReasoningEffort, isGrokCliCompatibilityModel } from "./models";
import { normalizeXaiResponsesInput } from "./payload-refactor/vision-input";
import { textFromResponsesContent } from "./text";

export {
  HISTORICAL_USER_IMAGE_PLACEHOLDER,
  normalizeXaiResponsesImageParts,
  omitConsumedXaiResponsesVisionImages,
  xaiResponsesPayloadContainsImage,
  xaiResponsesPayloadContainsLocalImageReference,
} from "./payload-refactor/vision-input";

export const XAI_PAYLOAD_CANONICALIZATION_ERROR =
  "xAI OAuth payload could not be safely canonicalized; no xAI request was sent";

/**
 * Materialize the exact JSON representation of a caller-controlled Responses
 * payload so custom serializers, accessors, prototypes, and functions cannot
 * change what later security checks and transport observe.
 */
export function canonicalizeXaiResponsesPayload(payload: unknown): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(payload);
    if (typeof serialized !== "string") throw new Error();
    const canonical = JSON.parse(serialized);
    if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) {
      throw new Error();
    }
    return canonical as Record<string, unknown>;
  } catch {
    throw new Error(XAI_PAYLOAD_CANONICALIZATION_ERROR);
  }
}

export type GrokNativeToolRoutes = Readonly<Record<string, string>>;

const XAI_ENCRYPTED_REASONING_INCLUDE = "reasoning.encrypted_content";

/** Apply the final request policy for the pinned OAuth Responses route. */
export function applyXaiOAuthResponsesPolicy(payload: Record<string, unknown>): Record<string, unknown> {
  const include = Array.isArray(payload.include) ? payload.include : [];
  const normalizedInclude: string[] = [];
  const seen = new Set<string>();
  for (const value of include) {
    if (typeof value !== "string" || seen.has(value)) continue;
    seen.add(value);
    normalizedInclude.push(value);
  }
  if (!seen.has(XAI_ENCRYPTED_REASONING_INCLUDE)) {
    normalizedInclude.push(XAI_ENCRYPTED_REASONING_INCLUDE);
  }
  return {
    ...payload,
    ...(payload.store === undefined ? { store: false } : {}),
    include: normalizedInclude,
  };
}

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

export interface XaiPayloadRewriteOptions extends SimpleStreamOptions {
  preserveCurrentToolImages?: boolean;
  omitConsumedVisionImages?: boolean;
}

/** Rewrite generic OpenAI Responses payloads into xAI-compatible payloads. */
export function rewriteXaiResponsesPayload(
  payload: unknown,
  model: Model<Api>,
  options?: XaiPayloadRewriteOptions,
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const body: Record<string, any> = { ...(payload as Record<string, any>) };
  const modelId = String(body.model || model.id);
  const usesGrokCliCompatibility = isGrokCliCompatibilityModel(modelId);

  // xAI's Responses API matches the OpenAI surface but has a few stricter
  // edges than pi's generic OpenAI Responses serializer. Hermes solves the
  // same Grok OAuth path with top-level instructions; xAI also rejects
  // image arrays in function_call_output.output, so normalize those here.
  if (Array.isArray(body.input)) {
    let input = normalizeXaiResponsesInput(
      [...body.input],
      model,
      options?.preserveCurrentToolImages,
      options?.omitConsumedVisionImages,
    ) as Record<string, any>[];
    const instructionParts: string[] = [];

    if (usesGrokCliCompatibility) {
      input = input.filter((item) => {
        if (!item || typeof item !== "object") return true;
        if (typeof item.content === "string" && item.content.length === 0) return false;
        if (item.role !== "developer" && item.role !== "system") return true;
        const text = textFromResponsesContent(item.content).trim();
        if (text) instructionParts.push(text);
        return false;
      });
    } else {
      while (input.length > 0) {
        const first = input[0];
        if (!first || typeof first !== "object" || (first.role !== "developer" && first.role !== "system")) break;
        const text = textFromResponsesContent(first.content).trim();
        if (text) instructionParts.push(text);
        input.shift();
      }
    }

    if (instructionParts.length > 0) {
      body.instructions = [body.instructions, ...instructionParts].filter((part) => typeof part === "string" && part).join("\n\n");
    }
    body.input = input;
  } else if (typeof body.input === "string") {
    // String input is valid and should stay string-shaped.
  }

  if (body.response_format && !body.text) {
    body.text = { format: body.response_format };
    delete body.response_format;
  }

  if (body.reasoning && typeof body.reasoning === "object") {
    const effort = body.reasoning.effort;
    if (typeof effort === "string" && effort !== "none" && grokSupportsReasoningEffort(modelId)) {
      body.reasoning = { effort: effort === "minimal" ? "low" : effort };
    } else {
      delete body.reasoning;
    }
  }

  // xAI doesn't implement OpenAI's prompt_cache_retention knobs. Keep the
  // cache key (Responses API body field), but remove retention.
  // Docs: https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits
  // prompt_cache_key routes a conversation to the same server so cache hits
  // are reliable; without it multi-turn agent loops often pay full input price.
  delete body.prompt_cache_retention;
  const cacheKey =
    (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) ||
    (typeof options?.sessionId === "string" && options.sessionId.trim()) ||
    "";
  if (cacheKey) body.prompt_cache_key = cacheKey;
  else delete body.prompt_cache_key;

  return body;
}
