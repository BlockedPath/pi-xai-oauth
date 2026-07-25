import { describe, expect, it, vi } from "vitest";
import {
  abortableSleep,
  awaitAbortable,
  cancellationError,
  composeTimeoutSignal,
  throwIfAborted,
} from "../../extensions/xai/abort";
import {
  exceedsDeclaredLength,
  hasJsonContentType,
  readBoundedResponseText,
  readTruncatedResponseText,
} from "../../extensions/xai/bounded-body";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("shared cancellation primitives", () => {
  it("throws the caller error only for aborted signals", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(cancellationError().message);
    expect(() => throwIfAborted(controller.signal, () => new Error("route"))).toThrow("route");
  });

  it("rejects a pending sleep on cancellation without leaking the timer", async () => {
    const controller = new AbortController();
    const sleeping = abortableSleep(60_000, controller.signal, () => new Error("cancelled"));
    controller.abort();
    await expect(sleeping).rejects.toThrow("cancelled");
    await expect(abortableSleep(0)).resolves.toBeUndefined();
  });

  it("composes caller cancellation with a timeout and reports which fired", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const composed = composeTimeoutSignal(caller.signal, 1_000);
    caller.abort();
    expect(composed.signal.aborted).toBe(true);
    expect(composed.timedOut()).toBe(false);
    composed.dispose();

    const timed = composeTimeoutSignal(undefined, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(timed.signal.aborted).toBe(true);
    expect(timed.timedOut()).toBe(true);
    timed.dispose();
  });

  it("settles an awaited operation on cancellation without swallowing results", async () => {
    const controller = new AbortController();
    await expect(awaitAbortable(Promise.resolve("value"), controller.signal)).resolves.toBe("value");
    const pending = awaitAbortable(new Promise<string>(() => {}), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("The operation was aborted");
  });
});

describe("shared bounded body readers", () => {
  it("classifies JSON content types and declared lengths", () => {
    const json = new Response("{}", { headers: { "content-type": "application/json; charset=utf-8" } });
    const problem = new Response("{}", { headers: { "content-type": "application/problem+json" } });
    const html = new Response("<p>", { headers: { "content-type": "text/html" } });
    expect(hasJsonContentType(json)).toBe(true);
    expect(hasJsonContentType(problem)).toBe(true);
    expect(hasJsonContentType(html)).toBe(false);
    expect(exceedsDeclaredLength(new Response("x", { headers: { "content-length": "9" } }), 4)).toBe(true);
    expect(exceedsDeclaredLength(new Response("x", { headers: { "content-length": "2" } }), 4)).toBe(false);
  });

  it("streams bounded text and raises the caller overflow error past the bound", async () => {
    await expect(readBoundedResponseText(new Response(streamOf("ab", "cd")), {
      maxBytes: 16,
      overflowError: () => new Error("too large"),
    })).resolves.toBe("abcd");

    await expect(readBoundedResponseText(new Response(streamOf("abcdef")), {
      maxBytes: 3,
      overflowError: () => new Error("too large"),
    })).rejects.toThrow("too large");
  });

  it("cancels the reader and rejects with the caller error on cancellation", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const reading = readBoundedResponseText(
      new Response(new ReadableStream<Uint8Array>({ cancel })),
      {
        maxBytes: 16,
        signal: controller.signal,
        overflowError: () => new Error("too large"),
        abortError: () => new Error("cancelled"),
      },
    );
    controller.abort();
    await expect(reading).rejects.toThrow("cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid UTF-8 only under strict decoding", async () => {
    const invalid = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff, 0xfe]));
        controller.close();
      },
    }));
    await expect(readBoundedResponseText(invalid(), {
      maxBytes: 16,
      strictUtf8: true,
      overflowError: () => new Error("too large"),
    })).rejects.toBeInstanceOf(TypeError);
    await expect(readBoundedResponseText(invalid(), {
      maxBytes: 16,
      overflowError: () => new Error("too large"),
    })).resolves.toBeTypeOf("string");
  });

  it("truncates classification bodies and never reflects oversized declared bodies", async () => {
    await expect(readTruncatedResponseText(new Response(streamOf("abcdef")), 3)).resolves.toBe("abc");
    const cancel = vi.fn();
    const declared = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "content-length": "4096" },
    });
    await expect(readTruncatedResponseText(declared, 8)).resolves.toBe("");
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(readTruncatedResponseText(new Response(null), 8)).resolves.toBe("");
  });
});
