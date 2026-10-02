import type { Api, Model } from "@earendil-works/pi-ai";
import { safeXaiTransportErrorMessage } from "./wire";

/** One event forwarded from pi's Responses delegate stream. */
export interface AssistantStreamEvent {
  type: string;
  partial?: any;
  toolCall?: any;
  message?: any;
  error?: any;
  reason?: string;
  [key: string]: unknown;
}

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

/** Create an assistant event stream exposing async iteration and a terminal `result()` promise. */
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

/** Build a terminal assistant error message carrying the xAI model identity and a safe error text. */
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
