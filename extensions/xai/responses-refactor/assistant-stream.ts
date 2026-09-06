import type { Api, Model } from "@earendil-works/pi-ai";
import {
  internalizeGrokNativeToolCalls,
  type GrokNativeToolRoutes,
  XAI_PAYLOAD_CANONICALIZATION_ERROR,
} from "../payload";
import {
  XAI_VISION_DESCRIPTION_ERROR,
  XAI_VISION_ROUTING_INVALIDATED_ERROR,
} from "../vision-routing";
import {
  safeXaiTransportErrorMessage,
  XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE,
} from "../wire";

export interface AssistantStreamEvent {
  type: string;
  partial?: any;
  toolCall?: any;
  message?: any;
  error?: any;
  reason?: string;
  [key: string]: unknown;
}

const SAFE_TEXT_ONLY_ERROR_PATTERN =
  /^xAI OAuth model [A-Za-z0-9][A-Za-z0-9._:-]{0,127} is explicitly text-only in the authenticated model catalog; no xAI request was sent$/;
export const XAI_PAYLOAD_MODEL_ERROR =
  "xAI OAuth payload hooks cannot change the selected model; no xAI request was sent";

function resultFromStreamEvent(event: AssistantStreamEvent): any {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return undefined;
}

function normalizeXaiErrorText(value: string): string {
  return /^OpenAI API error\b/i.test(value)
    ? safeXaiTransportErrorMessage(value, undefined, "responses-proxy")
    : value;
}

function restoreXaiMessageIdentity<T>(value: T, model: Model<Api>): T {
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

/** Restore xAI identity, tool routes, and safe errors on one delegate stream event. */
export function normalizeXaiStreamEvent(
  event: AssistantStreamEvent,
  grokNativeToolRoutes: GrokNativeToolRoutes,
  model: Model<Api>,
): AssistantStreamEvent {
  const partial = internalizeGrokNativeToolCalls(
    restoreXaiMessageIdentity(event.partial, model),
    grokNativeToolRoutes,
  );
  const toolCall = internalizeGrokNativeToolCalls(
    event.toolCall,
    grokNativeToolRoutes,
  );
  const message = internalizeGrokNativeToolCalls(
    restoreXaiMessageIdentity(event.message, model),
    grokNativeToolRoutes,
  );
  const restoredError = restoreXaiMessageIdentity(event.error, model);
  const internalized =
    partial !== event.partial ||
    toolCall !== event.toolCall ||
    message !== event.message ||
    restoredError !== event.error
      ? { ...event, partial, toolCall, message, error: restoredError }
      : event;
  if (
    internalized.type !== "error" ||
    !internalized.error ||
    typeof internalized.error !== "object"
  ) {
    return internalized;
  }
  const error = internalized.error as Record<string, unknown>;
  if (typeof error.errorMessage !== "string") return internalized;
  return {
    ...internalized,
    error: {
      ...error,
      errorMessage:
        SAFE_TEXT_ONLY_ERROR_PATTERN.test(error.errorMessage) ||
        error.errorMessage === XAI_PAYLOAD_MODEL_ERROR ||
        error.errorMessage === XAI_PAYLOAD_CANONICALIZATION_ERROR ||
        error.errorMessage === XAI_VISION_DESCRIPTION_ERROR ||
        error.errorMessage === XAI_VISION_ROUTING_INVALIDATED_ERROR
          ? error.errorMessage
          : safeXaiTransportErrorMessage(
              error.errorMessage,
              typeof error.status === "number" ? error.status : undefined,
              "responses-proxy",
              // Pi 0.84 preserves `response.failed` here; the supported 0.80
              // boundary does not. In both cases the additional classifier still
              // requires xAI's invalid_request code plus encrypted-content marker.
              error.rawStopReason === "failed" ||
                error.rawStopReason === undefined,
            ),
    },
  };
}

/** Create the queue-backed assistant stream exposed to pi callers. */
export function createForwardingAssistantStream() {
  const queue: AssistantStreamEvent[] = [];
  const waiting: Array<(result: IteratorResult<AssistantStreamEvent>) => void> =
    [];
  let done = false;
  let resolveResult: (result: any) => void = () => {};
  const resultPromise = new Promise<any>((resolve) => {
    resolveResult = resolve;
  });

  function finish(result: any) {
    if (done) return;
    done = true;
    resolveResult(result);
  }

  return {
    push(event: AssistantStreamEvent) {
      const finalResult = resultFromStreamEvent(event);
      const isTerminal = event.type === "done" || event.type === "error";
      if (isTerminal) finish(finalResult);
      if (done && !isTerminal) return;
      const waiter = waiting.shift();
      if (waiter) {
        waiter({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    end(result?: any) {
      finish(result);
      while (waiting.length > 0) {
        waiting.shift()?.({ value: undefined as any, done: true });
      }
    },
    result() {
      return resultPromise;
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else if (done) {
          return;
        } else {
          const result = await new Promise<
            IteratorResult<AssistantStreamEvent>
          >((resolve) => waiting.push(resolve));
          if (result.done) return;
          yield result.value;
        }
      }
    },
  };
}

/** Build a terminal assistant error result with xAI model identity. */
export function streamErrorMessage(model: Model<Api>, error: unknown) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: normalizeXaiErrorText(
      error instanceof Error ? error.message : String(error),
    ),
    timestamp: Date.now(),
  };
}
