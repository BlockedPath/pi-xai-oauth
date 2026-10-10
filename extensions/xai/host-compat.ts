import type { OpenAIResponsesCompat } from "@earendil-works/pi-ai";

/**
 * Host probes for Pi exports that omp 18.8.7 does not provide.
 *
 * A present Pi export always wins. These helpers never replace it.
 */

export interface OpenAIResponsesCompatModule {
  openAIResponsesApi?: () => { streamSimple?: unknown };
  streamSimpleOpenAIResponses?: unknown;
}

/**
 * Return Pi's OpenAI Responses stream when the host exports it.
 *
 * omp 18.8.7 exports `streamSimpleOpenAIResponses` and does not export
 * `openAIResponsesApi`. Return undefined when neither export is a function.
 */
export function resolveOpenAIResponsesStream(
  compat: OpenAIResponsesCompatModule,
): unknown {
  if (typeof compat.openAIResponsesApi === "function") {
    const api = compat.openAIResponsesApi();
    if (api && typeof api.streamSimple === "function") return api.streamSimple;
  }
  if (typeof compat.streamSimpleOpenAIResponses === "function") {
    return compat.streamSimpleOpenAIResponses;
  }
  return undefined;
}

function isCompatRecord(value: unknown): value is OpenAIResponsesCompat {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Copy a host compat object.
 *
 * omp 18.8.7 reads `model.compat.storeResponses` and throws when `compat`
 * is missing. An existing object is copied unchanged.
 */
export function copyModelCompat(model: object): OpenAIResponsesCompat {
  if (!("compat" in model)) return {};
  const compat = model.compat;
  if (!isCompatRecord(compat)) return {};
  return { ...compat };
}

/**
 * Prefer Pi's `resizeImage` export. Use the fallback only when it is absent.
 */
export function selectResizeImage<T>(exported: unknown, fallback: T): T {
  if (typeof exported === "function") return exported as T;
  return fallback;
}
