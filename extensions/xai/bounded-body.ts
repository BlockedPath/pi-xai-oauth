/**
 * Shared byte-bounded response-body readers.
 *
 * Every authenticated xAI route reads its body through these helpers so the
 * declared-length check, streamed byte bound, reader cancellation, and
 * cancellation propagation stay identical across routes. Callers supply the
 * route-specific errors so no transport detail is reflected back to users.
 */

import { cancellationError } from "./abort";

/** Whether the response advertises a JSON media type. */
export function hasJsonContentType(response: Response): boolean {
  const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mime === "application/json" || Boolean(mime?.endsWith("+json"));
}

/** Whether the declared `content-length` already exceeds the byte bound. */
export function exceedsDeclaredLength(response: Response, maxBytes: number): boolean {
  const declared = Number(response.headers.get("content-length"));
  return Number.isFinite(declared) && declared > maxBytes;
}

/** Cancel a body reader without letting best-effort cleanup throw. */
function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best-effort cleanup and must never extend the request bound.
  }
}

/** Release a body reader lock without letting best-effort cleanup throw. */
function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // A hostile pending read may retain the lock; request completion stays bounded.
  }
}

export interface BoundedResponseTextOptions {
  /** Maximum number of body bytes accepted before `overflowError` is thrown. */
  maxBytes: number;
  /** Route-specific error thrown when the declared or streamed body is too large. */
  overflowError: () => unknown;
  /** Caller cancellation; aborts cancel the reader and reject the read. */
  signal?: AbortSignal;
  /** Route-specific error thrown when `signal` aborts (defaults to the signal reason). */
  abortError?: () => unknown;
  /** Reject declared over-length bodies before streaming (default `true`). */
  checkDeclaredLength?: boolean;
  /** Result for a body-less response: buffered bounded text (default) or `""`. */
  emptyBody?: "text" | "empty";
  /** Decode incrementally with a strict UTF-8 decoder instead of buffering bytes. */
  strictUtf8?: boolean;
}

/**
 * Read a response body as text under a hard byte bound, cancelling the reader
 * on overflow, cancellation, and transport failure.
 */
export async function readBoundedResponseText(
  response: Response,
  options: BoundedResponseTextOptions,
): Promise<string> {
  const { maxBytes, overflowError, signal } = options;
  const abortError = options.abortError ?? (() => signal?.reason ?? cancellationError());

  if (options.checkDeclaredLength !== false && exceedsDeclaredLength(response, maxBytes)) {
    void response.body?.cancel().catch(() => undefined);
    throw overflowError();
  }
  if (!response.body) {
    if (options.emptyBody === "empty") return "";
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw overflowError();
    return text;
  }

  const reader = response.body.getReader();
  const decoder = options.strictUtf8 ? new TextDecoder("utf-8", { fatal: true }) : undefined;
  const chunks: Uint8Array[] = [];
  let text = "";
  let total = 0;
  let rejectOnAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => {
    // Reject before cancelling: cancellation settles the pending read as
    // `done`, which would otherwise race the abort into a truncated success.
    rejectOnAbort?.(abortError());
    cancelReader(reader);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // Cancellation can land between the completed fetch and body-reader setup.
    // Check after subscribing, inside the cleanup boundary, so that gap neither
    // starts an orphaned read nor retains the listener.
    if (signal?.aborted) throw abortError();
    while (true) {
      const read = reader.read();
      const { value, done } = signal ? await Promise.race([read, aborted]) : await read;
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw overflowError();
      if (decoder) text += decoder.decode(value, { stream: true });
      else chunks.push(value);
    }
    return decoder
      ? text + decoder.decode()
      : Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
  } catch (error) {
    cancelReader(reader);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    releaseReader(reader);
  }
}

/**
 * Read at most `maxBytes` of a body for classification only, truncating instead
 * of failing and returning `""` whenever the body is missing or unreadable.
 * When `signal` aborts, cancel the reader and reject so a stalled peer under
 * the byte cap cannot hang the request past the caller deadline.
 */
export async function readTruncatedResponseText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (exceedsDeclaredLength(response, maxBytes)) {
    await response.body?.cancel().catch(() => {});
    return "";
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abortError = () => signal?.reason ?? cancellationError();
  let rejectOnAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => {
    // Reject before cancelling: cancellation settles the pending read as
    // `done`, which would otherwise race the abort into a truncated success.
    rejectOnAbort?.(abortError());
    cancelReader(reader);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // Cancellation can land between the completed fetch and body-reader setup.
    // Check after subscribing, inside the cleanup boundary, so that gap neither
    // starts an orphaned read nor retains the listener.
    if (signal?.aborted) throw abortError();
    while (true) {
      const read = reader.read();
      const { value, done } = signal ? await Promise.race([read, aborted]) : await read;
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      total += value.byteLength;
      if (total >= maxBytes) {
        cancelReader(reader);
        break;
      }
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  } catch (error) {
    cancelReader(reader);
    // Abort must surface so callers honor deadlines; other read failures stay "".
    if (signal?.aborted) throw error;
    return "";
  } finally {
    signal?.removeEventListener("abort", onAbort);
    releaseReader(reader);
  }
}
