import * as piAi from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE } from "./wire";

const XAI_RESPONSES_DELEGATE_API = "openai-responses";

/** Context accepted by Pi's Responses delegate: `Context` before Pi 0.86, branded `TranscriptContext` from 0.86. */
export type XaiDelegateContext = Parameters<ReturnType<typeof openAIResponsesApi>["streamSimple"]>[1];

/** Folds `Context.systemPrompt`/`tools` into a leading system message (Pi 0.86+ `normalizeContext`). */
export type XaiContextNormalizer = (context: Context) => XaiDelegateContext;

// SAFETY: feature probe. Pi before 0.86 neither exports nor types `normalizeContext`, so the
// lookup is `undefined` there; its delegate still reads `systemPrompt`/`tools` directly.
const piNormalizeContext = (piAi as unknown as { normalizeContext?: XaiContextNormalizer }).normalizeContext;

/**
 * Adapt a context for Pi's Responses delegate the way Pi's public `streamSimple` does. Pi 0.86+
 * hands providers an already normalized transcript (`{ messages }`), which passes through
 * unchanged. A raw `Context` with `systemPrompt`/`tools` is folded through `normalizeContext`,
 * including when it also carries system messages: Pi then replays them into one prompt and tool
 * set, so neither the shorthand nor the existing system messages are dropped.
 * Pass `null` as `normalize` to adapt as Pi before 0.86 would (no folding).
 */
export function toXaiDelegateContext(
  context: Context,
  normalize: XaiContextNormalizer | null = piNormalizeContext ?? null,
): XaiDelegateContext {
  const hasShorthand = context.systemPrompt !== undefined || context.tools !== undefined;
  // SAFETY: the `TranscriptContext` brand is type-only. This path is reached only on Pi before
  // 0.86 (where the delegate type is `Context`) or for an already folded transcript.
  if (!normalize || !hasShorthand) return context as unknown as XaiDelegateContext;
  return normalize(context);
}

function isReplayCompatibleXaiMessage(
  value: unknown,
  model: Model<Api>,
  selectedModelId: string,
): value is AssistantMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (
    message.role === "assistant" &&
    message.provider === model.provider &&
    message.model === selectedModelId &&
    (message.api === model.api || message.api === XAI_RESPONSES_DELEGATE_API)
  );
}

/** Tag same-model xAI assistant history with the delegate API so pi converts it for replay. */
export function prepareXaiDelegateContext(
  context: Context,
  model: Model<Api>,
  selectedModelId: string,
): Context {
  let changed = false;
  const messages = context.messages.map((message) => {
    if (
      !isReplayCompatibleXaiMessage(message, model, selectedModelId) ||
      message.api === XAI_RESPONSES_DELEGATE_API
    )
      return message;
    changed = true;
    return { ...message, api: XAI_RESPONSES_DELEGATE_API };
  });
  return changed ? { ...context, messages } : context;
}

/** Whether the latest same-model assistant turn failed with the fixed encrypted-reasoning mismatch. */
export function shouldOmitRejectedEncryptedReasoning(
  context: Context,
  model: Model<Api>,
  selectedModelId: string,
): boolean {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    if (!message || typeof message !== "object" || message.role !== "assistant")
      continue;
    return (
      isReplayCompatibleXaiMessage(message, model, selectedModelId) &&
      message.stopReason === "error" &&
      message.errorMessage === XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE
    );
  }
  return false;
}

/** Drop encrypted reasoning items from a Responses payload, keeping all other input items. */
export function omitRejectedEncryptedReasoning(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(payload.input)) return payload;
  const input = payload.input.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return true;
    const item = value as Record<string, unknown>;
    return item.type !== "reasoning" || !("encrypted_content" in item);
  });
  return input.length === payload.input.length
    ? payload
    : { ...payload, input };
}

/** Restore the xAI provider/model/API identity on an assistant message returned by the delegate. */
export function restoreXaiMessageIdentity<T>(value: T, model: Model<Api>): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const message = value as Record<string, unknown>;
  if (message.role !== "assistant") return value;
  return {
    ...message,
    api: model.api,
    provider: model.provider,
    model: model.id,
  } as T;
}
