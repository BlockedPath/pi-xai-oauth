import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { randomUUID } from "crypto";
import {
  createForwardingAssistantStream,
  streamErrorMessage,
  type AssistantStreamEvent,
} from "./assistant-stream";
import { XAI_VISION_DESCRIPTION_ERROR } from "./constants";
import { compactXaiInlineImages } from "./images";
import { getXaiRuntimeModel } from "./models";
import {
  applyXaiOAuthResponsesPolicy,
  canonicalizeXaiResponsesPayload,
  rewriteXaiResponsesPayload,
  XAI_PAYLOAD_CANONICALIZATION_ERROR,
} from "./payload";
import {
  omitConsumedXaiResponsesVisionImages,
  xaiResponsesPayloadContainsImage,
  xaiResponsesPayloadContainsLocalImageReference,
} from "./payload-images";
import {
  exposeGrokNativeToolNames,
  internalizeGrokNativeToolCalls,
  type GrokNativeToolRoutes,
  xaiPayloadGrokNativeToolRoutes,
} from "./payload-tool-names";
import { acquireRedirectGuard } from "./redirect-guard";
import {
  omitRejectedEncryptedReasoning,
  prepareXaiDelegateContext,
  restoreXaiMessageIdentity,
  shouldOmitRejectedEncryptedReasoning,
  toXaiDelegateContext,
} from "./responses-delegate";
import {
  assertXaiRuntimeModelAcceptsPayload,
  createXaiResponse,
  pinXaiPayloadModel,
  SAFE_PAYLOAD_MODEL_ERROR,
} from "./responses-request";
import { resolveXaiRoute } from "./routing";
import { extractStrictResponsesText } from "./text";
import {
  buildXaiVisionDescriptionPayload,
  replaceXaiPayloadImagesWithDescription,
  XAI_VISION_ROUTING_INVALIDATED_ERROR,
  type XaiVisionRoutingController,
} from "./vision-routing";
import {
  safeXaiTransportErrorMessage,
  scrubXaiReservedHeaders,
  xaiProxyRequestHeaders,
} from "./wire";

const streamSimpleOpenAIResponses = openAIResponsesApi().streamSimple;
const SAFE_TEXT_ONLY_ERROR_PATTERN =
  /^xAI OAuth model [A-Za-z0-9][A-Za-z0-9._:-]{0,127} is explicitly text-only in the authenticated model catalog; no xAI request was sent$/;

function normalizeXaiStreamEvent(
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
        error.errorMessage === SAFE_PAYLOAD_MODEL_ERROR ||
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

/**
 * Stream pi's simple Responses flow through xAI with payload normalization.
 *
 * The transport is delegated to pi's builtin OpenAI Responses helper with a
 * temporary `openai-responses` API tag, while xAI routing headers, request
 * URLs, and payload rewriting continue to use the original xAI model metadata.
 * Returned events are forwarded through an assistant stream exposing async
 * iteration and `result()`. Delegate load or stream failures are converted
 * into terminal error events with xAI provider metadata instead of escaping
 * as unstructured promise failures. Canonical and persisted delegate-tagged
 * same-model history are aligned only for internal conversion; after a fixed
 * encrypted-reasoning mismatch, the next same-model request omits rejected
 * encrypted reasoning while retaining visible and tool-result history.
 *
 * @param model xAI provider model selected by pi.
 * @param context Conversation messages and tool context to stream.
 * @param options Simple stream options, including OAuth token, session ID, cancellation, and payload hooks.
 * @param visionRouting Optional session-scoped controller for explicit text-only model routing.
 * @returns A forwarding assistant stream compatible with pi's async iterator and `result()` contract.
 */
export function streamSimpleXaiResponses(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  visionRouting?: XaiVisionRoutingController,
) {
  const runtimeModel = getXaiRuntimeModel(model.id);
  if (!runtimeModel) {
    const stream = createForwardingAssistantStream();
    const message = streamErrorMessage(
      model,
      new Error(
        `xAI OAuth model ${model.id} is not present in the authenticated model catalog`,
      ),
    );
    stream.push({ type: "error", reason: "error", error: message });
    stream.end(message);
    return stream;
  }

  // The registered xai-auth provider is OAuth-only, so bind its stream to
  // session-token routing instead of inferring credential provenance from the
  // bearer string.
  const credentialKind = "oauth-session" as const;
  const route = resolveXaiRoute(credentialKind, "responses");

  // Prefer pi's stable session id for cache and proxy routing. A UUID fallback
  // keeps every OAuth proxy request fully attributed when pi has no session id.
  // https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits
  const sessionId = options?.sessionId;
  const routingSessionId = sessionId || randomUUID();
  const selectedModelId = runtimeModel.id;
  const requestHeaders = xaiProxyRequestHeaders(
    selectedModelId,
    credentialKind,
    {
      conversationId: routingSessionId,
      requestId: randomUUID(),
      sessionId: routingSessionId,
    },
    { streaming: true },
  );
  // Pi's Responses converter replaces user/tool images with placeholders when
  // model.input lacks "image". Capture the exact enabled grant so a reset and
  // re-enable cannot authorize an already-started request under a new grant.
  const visionGrantSignal = visionRouting?.signalFor(selectedModelId);
  const visionEnabled =
    visionGrantSignal !== undefined && !visionGrantSignal.aborted;
  const modelInputs = [...model.input];
  const streamModel = {
    ...model,
    id: selectedModelId,
    baseUrl: route.baseUrl,
    headers: scrubXaiReservedHeaders((model as any).headers) as Record<
      string,
      string
    >,
  };
  // Keep the xAI stream model for routing/payload rewriting, but delegate with
  // the API tag expected by pi's OpenAI Responses transport.
  const openAIResponsesModel = {
    ...streamModel,
    ...(visionEnabled && !modelInputs.includes("image")
      ? {
          input: [...modelInputs.filter((value) => value !== "image"), "image"],
        }
      : {}),
    api: "openai-responses" as const,
  };
  const delegateContext = toXaiDelegateContext(
    prepareXaiDelegateContext(context, model, selectedModelId),
  );
  const omitRejectedReasoning = shouldOmitRejectedEncryptedReasoning(
    context,
    model,
    selectedModelId,
  );
  // The OAuth bearer comes only from options.apiKey. Required proxy metadata
  // is merged last so callers cannot spoof authentication or attribution.
  const headers = {
    ...scrubXaiReservedHeaders(options?.headers),
    ...requestHeaders,
  };
  const routedSourceController = new AbortController();
  const transportSignal = AbortSignal.any([
    routedSourceController.signal,
    ...(options?.signal ? [options.signal] : []),
  ]);
  const planForCapturedVisionGrant = (payload: unknown) => {
    if (!xaiResponsesPayloadContainsImage(payload) || !visionGrantSignal)
      return undefined;
    if (visionGrantSignal.aborted)
      throw new Error(XAI_VISION_ROUTING_INVALIDATED_ERROR);
    const plan = visionRouting?.plan(selectedModelId, payload);
    if (!plan || plan.signal !== visionGrantSignal) {
      throw new Error(XAI_VISION_ROUTING_INVALIDATED_ERROR);
    }
    return plan;
  };

  const stream = createForwardingAssistantStream();
  let grokNativeToolRoutes: GrokNativeToolRoutes = {};
  void (async () => {
    // Pi's generic OpenAI delegate does not expose fetch redirect controls.
    // Keep one URL-scoped guard installed only for the lifetime of active xAI
    // streams; unrelated requests pass through unchanged, and overlapping xAI
    // streams share the same guard until the last request completes.
    const releaseRedirectGuard = acquireRedirectGuard(route.url);
    try {
      const inner = streamSimpleOpenAIResponses(
        openAIResponsesModel as Model<"openai-responses">,
        delegateContext,
        {
          ...options,
          signal: transportSignal,
          // Prevent Pi's generic OpenAI delegate from adding its own
          // session_id/x-client-request-id affinity headers. The xAI payload
          // rewrite below still receives the stable session for cache keys.
          sessionId: undefined,
          headers,
          // A retry would reuse a once-validated payload after the current
          // entitlement snapshot may have changed. Higher layers can retry by
          // starting a fresh request that repeats every local guard.
          maxRetries: 0,
          async onPayload(payload) {
            const canonicalInput = canonicalizeXaiResponsesPayload(payload);
            if (
              xaiResponsesPayloadContainsLocalImageReference(canonicalInput)
            ) {
              const inputPlan = planForCapturedVisionGrant(canonicalInput);
              if (!inputPlan)
                assertXaiRuntimeModelAcceptsPayload(
                  selectedModelId,
                  canonicalInput,
                );
            }
            const rewritten = rewriteXaiResponsesPayload(
              canonicalInput,
              streamModel,
              {
                ...options,
                sessionId: sessionId || routingSessionId,
                preserveCurrentToolImages: visionEnabled,
                omitConsumedVisionImages: visionEnabled,
              },
            );
            const userRewritten = await options?.onPayload?.(
              rewritten,
              streamModel,
            );
            const canonicalPayload = canonicalizeXaiResponsesPayload(
              userRewritten === undefined ? rewritten : userRewritten,
            );
            // A caller hook can reconstruct history after the initial rewrite.
            // Reapply the same consumed-image rule before planning, but only for
            // the vision grant captured when this stream started.
            const visionSafePayload = visionEnabled
              ? omitConsumedXaiResponsesVisionImages(canonicalPayload)
              : canonicalPayload;
            const replaySafePayload = omitRejectedReasoning
              ? omitRejectedEncryptedReasoning(visionSafePayload)
              : visionSafePayload;
            const policyPayload =
              applyXaiOAuthResponsesPolicy(replaySafePayload);
            grokNativeToolRoutes =
              xaiPayloadGrokNativeToolRoutes(policyPayload);
            let exposedPayload = exposeGrokNativeToolNames(policyPayload);
            pinXaiPayloadModel(selectedModelId, exposedPayload);

            const plan = planForCapturedVisionGrant(exposedPayload);
            if (plan) {
              const compactedVisionPayload = (await compactXaiInlineImages(
                exposedPayload,
              )) as Record<string, unknown>;
              if (!visionRouting?.validate(plan))
                throw new Error(XAI_VISION_ROUTING_INVALIDATED_ERROR);
              if (typeof options?.apiKey !== "string" || !options.apiKey) {
                throw new Error(
                  "xAI vision routing could not resolve the current OAuth credential; no xAI request was sent",
                );
              }
              const response = await createXaiResponse(
                { kind: "oauth-session", token: options.apiKey },
                buildXaiVisionDescriptionPayload(
                  compactedVisionPayload,
                  plan.targetModelId,
                ) as Record<string, unknown>,
                AbortSignal.any([
                  plan.signal,
                  ...(options.signal ? [options.signal] : []),
                ]),
                () => {
                  if (!visionRouting?.validate(plan))
                    throw new Error(XAI_VISION_ROUTING_INVALIDATED_ERROR);
                },
                256 * 1024,
              );
              if (!visionRouting?.validate(plan))
                throw new Error(XAI_VISION_ROUTING_INVALIDATED_ERROR);
              plan.signal.addEventListener(
                "abort",
                () => routedSourceController.abort(),
                { once: true },
              );
              if (plan.signal.aborted) routedSourceController.abort();
              const description = extractStrictResponsesText(response).trim();
              if (!description) throw new Error(XAI_VISION_DESCRIPTION_ERROR);
              exposedPayload = replaceXaiPayloadImagesWithDescription(
                compactedVisionPayload,
                description,
              );
              pinXaiPayloadModel(selectedModelId, exposedPayload);
            }

            assertXaiRuntimeModelAcceptsPayload(
              selectedModelId,
              exposedPayload,
            );
            const finalPayload = await compactXaiInlineImages(exposedPayload);
            assertXaiRuntimeModelAcceptsPayload(selectedModelId, finalPayload);
            return finalPayload;
          },
        },
      );
      for await (const event of inner as AsyncIterable<AssistantStreamEvent>) {
        if (event.type === "done" || event.type === "error")
          releaseRedirectGuard();
        stream.push(
          normalizeXaiStreamEvent(event, grokNativeToolRoutes, model),
        );
      }
      releaseRedirectGuard();
      stream.end();
    } catch (error) {
      releaseRedirectGuard();
      const safeError =
        error instanceof Error &&
        (/Image file does not exist or is not a valid URL:/.test(
          error.message,
        ) ||
          /\b(?:EACCES|EPERM|EISDIR|ENOENT):\b/.test(error.message))
          ? new Error(
              "xAI image input could not be safely resolved; no xAI request was sent",
            )
          : error;
      const message = streamErrorMessage(model, safeError);
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    } finally {
      releaseRedirectGuard();
    }
  })().catch((error) => {
    // A failure inside the pump's own error path must still terminate the
    // stream: an unobserved rejection would hang every consumer awaiting it.
    let message: ReturnType<typeof streamErrorMessage> | undefined;
    try {
      message = streamErrorMessage(model, error);
      stream.push({ type: "error", reason: "error", error: message });
    } catch {
      // The terminal fallback must not create another unobserved rejection.
    } finally {
      stream.end(message);
    }
  });
  return stream;
}
