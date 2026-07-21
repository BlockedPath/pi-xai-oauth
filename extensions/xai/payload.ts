import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { XAI_GROK_NATIVE_TOOL_NAME_MAP } from "./constants";
import { normalizeXaiImageInput } from "./images";
import { grokSupportsReasoningEffort, isGrokCliCompatibilityModel } from "./models";
import { textFromResponsesContent } from "./text";

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

export function normalizeXaiResponsesImageParts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeXaiResponsesImageParts);
  if (!value || typeof value !== "object") return value;

  const obj: Record<string, any> = { ...(value as Record<string, any>) };
  if (obj.type === "image" && typeof obj.data === "string" && typeof obj.mimeType === "string") {
    return {
      type: "input_image",
      image_url: `data:${obj.mimeType};base64,${obj.data}`,
      detail: typeof obj.detail === "string" && obj.detail ? obj.detail : "auto",
    };
  }
  if (obj.type === "image_url") {
    const imageUrl = typeof obj.image_url === "object" && obj.image_url ? obj.image_url.url : obj.image_url;
    const detail = typeof obj.image_url === "object" && obj.image_url ? obj.image_url.detail : obj.detail;
    obj.type = "input_image";
    obj.image_url = imageUrl;
    if (typeof detail === "string" && detail) obj.detail = detail;
  }
  if (obj.type === "input_image") {
    const imageUrl = typeof obj.image_url === "object" && obj.image_url ? obj.image_url.url : obj.image_url;
    const detail = typeof obj.image_url === "object" && obj.image_url ? obj.image_url.detail : obj.detail;
    const normalized = normalizeXaiImageInput(imageUrl);
    if (normalized) obj.image_url = normalized;
    if (typeof detail === "string" && detail) obj.detail = detail;
    if (typeof obj.detail !== "string" || !obj.detail) obj.detail = "auto";
  }
  if (Array.isArray(obj.content)) obj.content = normalizeXaiResponsesImageParts(obj.content);
  if (Array.isArray(obj.output)) obj.output = normalizeXaiResponsesImageParts(obj.output);
  return obj;
}

function isResponsesInputImagePart(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, any>;
  if (item.type === "input_image" || item.type === "image_url") return true;
  if (
    item.type === "computer_screenshot" &&
    (item.image_url !== undefined || item.file_id !== undefined)
  ) return true;
  return (
    item.type === "image" &&
    (typeof item.data === "string" || item.image_url !== undefined || item.source !== undefined)
  );
}

type ToolImageDisposition = "attached" | "omitted";
export const HISTORICAL_USER_IMAGE_PLACEHOLDER =
  "(historical user image omitted after a later assistant response)";
const HISTORICAL_COMPUTER_SCREENSHOT_PLACEHOLDER =
  "[historical computer screenshot omitted after a later assistant response]";

function historicalToolImagePlaceholder(imageCount: number): string {
  return `[${imageCount} historical tool image${imageCount === 1 ? "" : "s"} omitted after a later assistant response]`;
}

function textForFunctionCallOutput(output: unknown, imageDisposition: ToolImageDisposition): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return output === undefined || output === null ? "" : JSON.stringify(output);

  const chunks: string[] = [];
  let imageCount = 0;
  for (const part of output) {
    if (isResponsesInputImagePart(part)) {
      imageCount++;
      continue;
    }
    const text = textFromResponsesContent([part]).trim();
    if (text) chunks.push(text);
  }
  if (imageCount > 0) {
    chunks.push(
      imageDisposition === "attached"
        ? `[${imageCount} image${imageCount === 1 ? "" : "s"} attached in the following user message]`
        : historicalToolImagePlaceholder(imageCount),
    );
  }
  return chunks.join("\n");
}

function isAssistantResponseItem(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, any>;
  if (item.role === "assistant") return true;
  return item.type === "reasoning" || item.type === "function_call";
}

/**
 * Vision-routing descriptions are request-ephemeral and never enter session
 * history. Only a terminal assistant message proves the source model already
 * consumed prior visual context. Pi flattens each assistant response into one
 * contiguous segment of reasoning, message, and function-call items, preserving
 * their original content order.
 */
function isAssistantMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>).role === "assistant";
}

function assistantMessagesInToolCallSegments(input: readonly unknown[]): boolean[] {
  const inToolCallSegment = new Array<boolean>(input.length).fill(false);
  for (let index = 0; index < input.length;) {
    if (!isAssistantResponseItem(input[index])) {
      index++;
      continue;
    }
    const start = index;
    let hasFunctionCall = false;
    let end = index;
    for (; end < input.length && isAssistantResponseItem(input[end]); end++) {
      const item = input[end] as Record<string, unknown>;
      if (item.type === "function_call") hasFunctionCall = true;
    }
    index = end;
    if (!hasFunctionCall) continue;
    for (let segmentIndex = start; segmentIndex < end; segmentIndex++) {
      if (isAssistantMessage(input[segmentIndex])) inToolCallSegment[segmentIndex] = true;
    }
  }
  return inToolCallSegment;
}

const OMIT_CONSUMED_VISION_IMAGE = Symbol("omit-consumed-xai-vision-image");

interface StrippedVisionImages {
  value: unknown | typeof OMIT_CONSUMED_VISION_IMAGE;
  imageCount: number;
}

function stripRecognizedVisionImages(value: unknown): StrippedVisionImages {
  if (!value || typeof value !== "object") return { value, imageCount: 0 };
  if (isResponsesInputImagePart(value)) {
    return { value: OMIT_CONSUMED_VISION_IMAGE, imageCount: 1 };
  }
  if (Array.isArray(value)) {
    let imageCount = 0;
    let changed = false;
    const rewritten: unknown[] = [];
    for (const child of value) {
      const stripped = stripRecognizedVisionImages(child);
      imageCount += stripped.imageCount;
      if (stripped.value === OMIT_CONSUMED_VISION_IMAGE) {
        changed = true;
        continue;
      }
      if (stripped.value !== child) changed = true;
      rewritten.push(stripped.value);
    }
    return { value: changed ? rewritten : value, imageCount };
  }

  let imageCount = 0;
  let changed = false;
  const source = value as Record<string, unknown>;
  const rewritten: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    const stripped = stripRecognizedVisionImages(child);
    imageCount += stripped.imageCount;
    if (stripped.value === OMIT_CONSUMED_VISION_IMAGE) {
      changed = true;
      continue;
    }
    if (stripped.value !== child) changed = true;
    rewritten[key] = stripped.value;
  }
  return { value: changed ? rewritten : value, imageCount };
}

function withHistoricalUserImagePlaceholder(item: Record<string, any>): Record<string, any> {
  const placeholder = { type: "input_text", text: HISTORICAL_USER_IMAGE_PLACEHOLDER };
  if (Array.isArray(item.content)) return { ...item, content: [...item.content, placeholder] };
  if (typeof item.content === "string") {
    return {
      ...item,
      content: [{ type: "input_text", text: item.content }, placeholder],
    };
  }
  return { ...item, content: [placeholder] };
}

function stripConsumedComputerScreenshot(item: Record<string, any>): Record<string, any> {
  if (item.type !== "computer_call_output" || !item.output || typeof item.output !== "object") return item;
  const output = item.output as Record<string, unknown>;
  if (
    output.type !== "computer_screenshot" ||
    (output.image_url === undefined && output.file_id === undefined)
  ) return item;
  return { ...item, output: { type: "computer_screenshot" } };
}

/** Remove image inputs consumed by a later terminal assistant message from a canonical Responses payload. */
export function omitConsumedXaiResponsesVisionImages(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(payload.input)) return payload;

  const input = payload.input as unknown[];
  const hasLaterAssistantOutput = new Array<boolean>(input.length).fill(false);
  const messageInToolCallSegment = assistantMessagesInToolCallSegments(input);
  let assistantMessageSeen = false;
  for (let index = input.length - 1; index >= 0; index--) {
    hasLaterAssistantOutput[index] = assistantMessageSeen;
    if (isAssistantMessage(input[index]) && !messageInToolCallSegment[index]) {
      assistantMessageSeen = true;
    }
  }

  let changed = false;
  const rewritten: unknown[] = [];
  for (let index = 0; index < input.length; index++) {
    const item = input[index];
    if (!hasLaterAssistantOutput[index] || !item || typeof item !== "object") {
      rewritten.push(item);
      continue;
    }

    const record = item as Record<string, any>;
    const strippedComputerOutput = stripConsumedComputerScreenshot(record);
    const computerScreenshotRemoved = strippedComputerOutput !== record;
    const stripped = stripRecognizedVisionImages(strippedComputerOutput);
    if (stripped.value === OMIT_CONSUMED_VISION_IMAGE) {
      changed = true;
      rewritten.push({
        role: "user",
        content: [{ type: "input_text", text: HISTORICAL_USER_IMAGE_PLACEHOLDER }],
      });
      continue;
    }
    const strippedRecord = stripped.value as Record<string, any>;

    if (record.role === "user" && stripped.imageCount > 0) {
      changed = true;
      rewritten.push(withHistoricalUserImagePlaceholder(strippedRecord));
      continue;
    }

    if (record.type === "function_call_output" && stripped.imageCount > 0) {
      changed = true;
      const outputText = textForFunctionCallOutput(strippedRecord.output, "omitted");
      rewritten.push({
        ...strippedRecord,
        output: [outputText, historicalToolImagePlaceholder(stripped.imageCount)].filter(Boolean).join("\n") ||
          "(tool returned no text output)",
      });
      continue;
    }

    if (computerScreenshotRemoved || stripped.imageCount > 0) {
      changed = true;
      rewritten.push(strippedRecord);
      rewritten.push({
        role: "user",
        content: [{
          type: "input_text",
          text: computerScreenshotRemoved
            ? HISTORICAL_COMPUTER_SCREENSHOT_PLACEHOLDER
            : HISTORICAL_USER_IMAGE_PLACEHOLDER,
        }],
      });
      continue;
    }

    rewritten.push(item);
  }

  return changed ? { ...payload, input: rewritten } : payload;
}

function normalizeXaiResponsesInput(
  input: unknown[],
  model: Model<Api>,
  preserveCurrentToolImages = false,
  omitConsumedVisionImages = false,
): unknown[] {
  const normalizedInput = input.map(normalizeXaiResponsesImageParts) as Record<string, any>[];
  const visionSafePayload = omitConsumedVisionImages
    ? omitConsumedXaiResponsesVisionImages({ input: normalizedInput })
    : { input: normalizedInput };
  const visionSafeInput = visionSafePayload.input as Record<string, any>[];
  const rewritten: unknown[] = [];
  const modelInputs = Array.isArray((model as any).input) ? ((model as any).input as unknown[]) : [];
  const supportsImages = preserveCurrentToolImages || modelInputs.includes("image");
  const hasLaterAssistantOutput = new Array<boolean>(visionSafeInput.length).fill(false);
  let assistantOutputSeen = false;

  for (let index = visionSafeInput.length - 1; index >= 0; index--) {
    hasLaterAssistantOutput[index] = assistantOutputSeen;
    if (isAssistantResponseItem(visionSafeInput[index])) assistantOutputSeen = true;
  }

  for (let index = 0; index < visionSafeInput.length; index++) {
    const item = visionSafeInput[index];
    if (!item || typeof item !== "object" || item.type !== "function_call_output" || !Array.isArray(item.output)) {
      rewritten.push(item);
      continue;
    }

    // xAI rejects OpenAI Responses' image-bearing tool replay shape:
    //   { type: "function_call_output", output: [{ type: "input_text" }, { type: "input_image" }] }
    // with a 422 ModelInput deserialization error. Keep the required tool
    // output as text and replay images as a normal following user message.
    const outputParts = item.output;
    const imageParts = outputParts.filter(isResponsesInputImagePart);
    const imagesWereConsumed = imageParts.length > 0 && hasLaterAssistantOutput[index];
    const outputText = textForFunctionCallOutput(outputParts, imagesWereConsumed ? "omitted" : "attached");
    rewritten.push({ ...item, output: outputText || "(tool returned no text output)" });

    if (supportsImages && imageParts.length > 0 && !imagesWereConsumed) {
      const label = `The previous tool result${item.call_id ? ` (${item.call_id})` : ""} included ${imageParts.length} image${imageParts.length === 1 ? "" : "s"}. Use the attached image${imageParts.length === 1 ? "" : "s"} as the visual output from that tool.`;
      rewritten.push({
        role: "user",
        content: [{ type: "input_text", text: label }, ...imageParts],
      });
    }
  }

  return rewritten;
}

function imageReferenceValue(item: Record<string, unknown>): unknown {
  if (item.type === "input_image" || item.type === "image_url") {
    return item.image_url && typeof item.image_url === "object"
      ? (item.image_url as Record<string, unknown>).url
      : item.image_url;
  }
  if (item.type === "computer_screenshot") return item.image_url;
  return undefined;
}

/** Return whether normalization would resolve or read a local image reference. */
export function xaiResponsesPayloadContainsLocalImageReference(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const stack: unknown[] = [(payload as Record<string, unknown>).input];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) stack.push(child);
      continue;
    }
    const item = value as Record<string, unknown>;
    const reference = imageReferenceValue(item);
    if (typeof reference === "string") {
      const trimmed = reference.trim();
      const cleaned = trimmed.length >= 2 &&
          ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
            (trimmed.startsWith("'") && trimmed.endsWith("'")))
        ? trimmed.slice(1, -1)
        : trimmed;
      if (cleaned && !/^https?:\/\//i.test(cleaned) && !/^data:image\//i.test(cleaned)) return true;
    }
    for (const child of Object.values(item)) stack.push(child);
  }
  return false;
}

/** Return whether a final Responses request input structurally contains image content. */
export function xaiResponsesPayloadContainsImage(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const input = (payload as Record<string, unknown>).input;
  const stack: unknown[] = [input];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) stack.push(child);
      continue;
    }
    const item = value as Record<string, unknown>;
    if (item.type === "input_image" || item.type === "image_url") return true;
    if (
      item.type === "computer_screenshot" &&
      (item.image_url !== undefined || item.file_id !== undefined)
    ) return true;
    if (
      item.type === "image" &&
      (typeof item.data === "string" || item.image_url !== undefined || item.source !== undefined)
    ) return true;
    for (const child of Object.values(item)) stack.push(child);
  }
  return false;
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
