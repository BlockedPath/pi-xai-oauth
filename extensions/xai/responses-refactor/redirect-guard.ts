import { xaiHttpErrorFromResponse } from "../wire";

const guardedRedirectUrls = new Map<string, number>();
let unguardedFetch: typeof fetch | undefined;
let redirectGuardFetch: typeof fetch | undefined;

function fetchRequestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

/**
 * Reject redirects for one active xAI URL while leaving unrelated fetches unchanged.
 *
 * Concurrent callers share the global wrapper until the final URL guard is released.
 */
export function acquireXaiRedirectGuard(url: string): () => void {
  if (!redirectGuardFetch) {
    unguardedFetch = globalThis.fetch;
    const baseFetch = unguardedFetch;
    redirectGuardFetch = async (input, init) => {
      const requestUrl = fetchRequestUrl(input);
      const guarded = guardedRedirectUrls.has(requestUrl);
      const response = await baseFetch(
        input,
        guarded ? { ...init, redirect: "error" } : init,
      );
      if (!guarded || response.ok) return response;
      const requestSignal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const error = await xaiHttpErrorFromResponse(
        response,
        requestUrl,
        requestSignal,
      );
      const marker =
        error.code === "encrypted-content-mismatch"
          ? "encrypted_content"
          : error.code === "proxy-version-gate"
            ? "update_required"
            : "request failed";
      return new Response(JSON.stringify({ error: { message: marker } }), {
        status: response.status,
        statusText: response.statusText,
        headers: { "Content-Type": "application/json" },
      });
    };
    globalThis.fetch = redirectGuardFetch;
  }
  guardedRedirectUrls.set(url, (guardedRedirectUrls.get(url) ?? 0) + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (guardedRedirectUrls.get(url) ?? 1) - 1;
    if (remaining > 0) guardedRedirectUrls.set(url, remaining);
    else guardedRedirectUrls.delete(url);
    if (guardedRedirectUrls.size === 0) {
      if (globalThis.fetch === redirectGuardFetch && unguardedFetch) {
        globalThis.fetch = unguardedFetch;
      }
      redirectGuardFetch = undefined;
      unguardedFetch = undefined;
    }
  };
}
