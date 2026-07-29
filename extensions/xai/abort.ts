/**
 * Shared cancellation primitives for the bounded xAI network, polling, and
 * filesystem operations. Every helper keeps caller cancellation authoritative
 * and never retains listeners past the operation it guards.
 */

/** Build the default `AbortError` used when an operation observes cancellation. */
export function cancellationError(message = "The operation was cancelled."): DOMException {
  return new DOMException(message, "AbortError");
}

/** Throw the cancellation error when the signal is already aborted. */
export function throwIfAborted(
  signal?: AbortSignal,
  error: () => unknown = () => cancellationError(),
): void {
  if (signal?.aborted) throw error();
}

/** Sleep for a bounded delay, rejecting as soon as the signal aborts. */
export function abortableSleep(
  milliseconds: number,
  signal?: AbortSignal,
  error: () => unknown = () => cancellationError(),
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(error());
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(error());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A caller signal combined with a request timeout plus its cleanup handle. */
export interface ComposedAbortSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

/**
 * Compose a caller signal with a request timeout so a bounded operation aborts
 * on either, and report which one fired.
 */
export function composeTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): ComposedAbortSignal {
  const controller = new AbortController();
  let didTimeOut = false;
  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    },
  };
}

/** Await an in-flight operation, rejecting early when the signal aborts. */
export function awaitAbortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  error: () => unknown = () => cancellationError("The operation was aborted"),
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(error());
    };
    // Observe the operation before checking an already-aborted signal. The
    // operation is created by the caller first, so this ordering prevents a
    // synchronous abort plus rejected promise from becoming unhandled.
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (reason) => {
        signal.removeEventListener("abort", onAbort);
        reject(reason);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
