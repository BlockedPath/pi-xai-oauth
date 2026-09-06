import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizeXaiImageInput } from "../images";
import { textFromResponsesContent } from "../text";

/** Normalize supported image parts throughout a Responses input value. */
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

/** Normalize xAI image-bearing input and rewrite image-bearing tool outputs. */
export function normalizeXaiResponsesInput(
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
