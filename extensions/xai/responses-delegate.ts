import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE } from "./wire";

const XAI_RESPONSES_DELEGATE_API = "openai-responses";

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
