import { randomUUID } from "crypto";
import { readBoundedResponseText } from "./bounded-body";
import { XAI_VISION_DESCRIPTION_ERROR } from "./constants";
import { compactXaiInlineImages } from "./images";
import {
  getXaiRuntimeModel,
  isAuthenticatedXaiInputProvenance,
  normalizedXaiModelId,
  xaiModelForRequest,
} from "./models";
import {
  applyXaiOAuthResponsesPolicy,
  canonicalizeXaiResponsesPayload,
  rewriteXaiResponsesPayload,
} from "./payload";
import { xaiResponsesPayloadContainsImage } from "./payload-images";
import { resolveXaiRoute, type XaiCredential } from "./routing";
import {
  xaiHttpErrorFromResponse,
  xaiJsonPostHeaders,
  xaiProxyRequestHeaders,
} from "./wire";

/** Fixed error raised when a payload hook tries to change the selected model. */
export const SAFE_PAYLOAD_MODEL_ERROR =
  "xAI OAuth payload hooks cannot change the selected model; no xAI request was sent";

/**
 * POST a JSON body to a pinned xAI endpoint with protected bearer headers.
 *
 * @param authToken OAuth session token or API key selected by the caller's route policy.
 * @param url Internally selected xAI endpoint; redirects are always rejected.
 * @param body Canonical JSON-compatible request body.
 * @param signal Optional cancellation signal forwarded to fetch and bounded body reads.
 * @param contractHeaders Approved internally owned proxy metadata.
 * @param maxResponseBytes Optional response bound used by strict auxiliary Responses calls.
 * @returns The parsed successful JSON response.
 * @throws {XaiHttpError} For non-success HTTP responses, with only safe route/status detail.
 * @throws {Error} When a bounded auxiliary response is oversized or malformed.
 */
export async function postXaiJson(
  authToken: string,
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  contractHeaders: Record<string, string> = {},
  maxResponseBytes?: number,
): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: xaiJsonPostHeaders(authToken, contractHeaders),
    body: JSON.stringify(body),
    redirect: "error",
    signal,
  });

  if (!response.ok) {
    throw await xaiHttpErrorFromResponse(response, url, signal);
  }

  if (maxResponseBytes !== undefined) {
    const text = await readBoundedResponseText(response, {
      maxBytes: maxResponseBytes,
      overflowError: () => new Error(XAI_VISION_DESCRIPTION_ERROR),
    });
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(XAI_VISION_DESCRIPTION_ERROR);
    }
  }
  return response.json();
}

/** Pin the selected model on a Responses payload, rejecting hooks that changed it. */
export function pinXaiPayloadModel(modelId: string, payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(SAFE_PAYLOAD_MODEL_ERROR);
  }
  const body = payload as Record<string, unknown>;
  if (
    body.model !== undefined &&
    (typeof body.model !== "string" ||
      normalizedXaiModelId(body.model) !== normalizedXaiModelId(modelId))
  ) {
    throw new Error(SAFE_PAYLOAD_MODEL_ERROR);
  }
  body.model = modelId;
}

/** Assert the current authenticated entitlement permits the final Responses payload. */
export function assertXaiRuntimeModelAcceptsPayload(
  modelId: string,
  payload: unknown,
): void {
  const runtimeModel = getXaiRuntimeModel(modelId);
  if (!runtimeModel) {
    throw new Error(
      `xAI OAuth model ${modelId} is not present in the authenticated model catalog`,
    );
  }
  if (
    isAuthenticatedXaiInputProvenance(runtimeModel.inputProvenance) &&
    !runtimeModel.input.includes("image") &&
    xaiResponsesPayloadContainsImage(payload)
  ) {
    throw new Error(
      `xAI OAuth model ${runtimeModel.id} is explicitly text-only in the authenticated model catalog; no xAI request was sent`,
    );
  }
}

/**
 * Create one xAI Responses result using explicit credential-aware routing.
 *
 * OAuth requests receive the final `store: false` and encrypted-reasoning
 * include policy after canonicalization, model pinning, entitlement checks,
 * and inline-image compaction; API-key requests retain their separate route.
 *
 * @param credential Explicit OAuth-session or API-key credential and catalog scope.
 * @param body Caller Responses body, canonicalized before policy checks or transport.
 * @param signal Optional cancellation signal for transport and bounded response reads.
 * @param beforeSend Optional final guard invoked after local validation and before network I/O.
 * @param maxResponseBytes Optional strict response-size bound for auxiliary calls.
 * @returns The parsed successful Responses JSON result.
 * @throws {Error} When canonicalization, entitlement, payload policy, or transport validation fails.
 */
export async function createXaiResponse(
  credential: XaiCredential,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  beforeSend?: () => void,
  maxResponseBytes?: number,
): Promise<any> {
  const canonicalBody = canonicalizeXaiResponsesPayload(body);
  const requestedModel =
    typeof canonicalBody.model === "string" ? canonicalBody.model : undefined;
  const model = xaiModelForRequest(requestedModel, credential.kind);
  const usesPackageCatalog =
    credential.kind === "oauth-session" && credential.catalogScope !== "host";
  const runtimeModel = usesPackageCatalog
    ? getXaiRuntimeModel(model.id)
    : undefined;
  if (usesPackageCatalog && !runtimeModel) {
    throw new Error(
      `xAI OAuth model ${model.id} is not present in the authenticated model catalog`,
    );
  }
  const selectedModelId = runtimeModel?.id ?? model.id;
  const requestModel =
    selectedModelId === model.id ? model : { ...model, id: selectedModelId };
  const route = resolveXaiRoute(credential.kind, "responses");
  if (usesPackageCatalog) {
    assertXaiRuntimeModelAcceptsPayload(selectedModelId, canonicalBody);
  }
  const rewritten = rewriteXaiResponsesPayload(canonicalBody, requestModel);
  const policyPayload =
    credential.kind === "oauth-session"
      ? applyXaiOAuthResponsesPolicy(rewritten as Record<string, unknown>)
      : rewritten;
  pinXaiPayloadModel(selectedModelId, policyPayload);
  if (usesPackageCatalog) {
    assertXaiRuntimeModelAcceptsPayload(selectedModelId, policyPayload);
  }
  const payload = (await compactXaiInlineImages(policyPayload)) as Record<
    string,
    unknown
  >;
  if (usesPackageCatalog) {
    assertXaiRuntimeModelAcceptsPayload(selectedModelId, payload);
  }
  beforeSend?.();
  const requestSessionId = randomUUID();
  const requestHeaders = xaiProxyRequestHeaders(
    selectedModelId,
    credential.kind,
    {
      conversationId: requestSessionId,
      requestId: randomUUID(),
      sessionId: requestSessionId,
    },
  );
  return postXaiJson(
    credential.token,
    route.url,
    payload,
    signal,
    requestHeaders,
    maxResponseBytes,
  );
}
