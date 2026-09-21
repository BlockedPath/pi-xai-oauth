import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import { randomUUID } from "crypto";
import { readBoundedResponseText } from "./bounded-body";
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
  exposeGrokNativeToolNames,
  omitConsumedXaiResponsesVisionImages,
  rewriteXaiResponsesPayload,
  type GrokNativeToolRoutes,
  xaiPayloadGrokNativeToolRoutes,
  xaiResponsesPayloadContainsImage,
  xaiResponsesPayloadContainsLocalImageReference,
} from "./payload";
import {
  createForwardingAssistantStream,
  normalizeXaiStreamEvent,
  streamErrorMessage,
  type AssistantStreamEvent,
  XAI_PAYLOAD_MODEL_ERROR,
} from "./responses-refactor/assistant-stream";
import { acquireXaiRedirectGuard } from "./responses-refactor/redirect-guard";
import { resolveXaiRoute, type XaiCredential } from "./routing";
import { extractStrictResponsesText } from "./text";
import {
  buildXaiVisionDescriptionPayload,
  replaceXaiPayloadImagesWithDescription,
  XAI_VISION_DESCRIPTION_ERROR,
  XAI_VISION_ROUTING_INVALIDATED_ERROR,
  type XaiVisionRoutingController,
} from "./vision-routing";
import {
  scrubXaiReservedHeaders,
  XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE,
  xaiHttpErrorFromResponse,
  xaiJsonPostHeaders,
  xaiProxyRequestHeaders,
} from "./wire";

const streamSimpleOpenAIResponses = piAiCompat.openAIResponsesApi().streamSimple;
type DelegateContext = Parameters<typeof streamSimpleOpenAIResponses>[1];
// SAFETY: Pi 0.86 exports normalizeContext with this signature; older supported
// versions omit it and require the original top-level prompt/tools instead.
// Infer the delegate's context type and probe without importing an absent export.
const normalizeDelegateContext = (piAiCompat as unknown as {
  normalizeContext?: (context: Context) => DelegateContext;
}).normalizeContext;

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

function prepareXaiDelegateContext(
  context: Context,
  model: Model<Api>,
  selectedModelId: string,
): DelegateContext {
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
  const alignedContext = changed ? { ...context, messages } : context;
  if (normalizeDelegateContext) return normalizeDelegateContext(alignedContext);
  // Only the pre-0.86 branch uses this identity conversion. Never discard its
  // top-level fields or fabricate transcript messages for the legacy delegate.
  return alignedContext as DelegateContext;
}

function shouldOmitRejectedEncryptedReasoning(
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

function isEncryptedReasoningItem(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return false;
  const item = value as Record<string, unknown>;
  return item.type === "reasoning" && "encrypted_content" in item;
}

function omitRejectedEncryptedReasoning(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(payload.input)) return payload;
  const input = payload.input.filter((value) => !isEncryptedReasoningItem(value));
  return input.length === payload.input.length
    ? payload
    : { ...payload, input };
}

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

function pinXaiPayloadModel(modelId: string, payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(XAI_PAYLOAD_MODEL_ERROR);
  }
  const body = payload as Record<string, unknown>;
  if (
    body.model !== undefined &&
    (typeof body.model !== "string" ||
      normalizedXaiModelId(body.model) !== normalizedXaiModelId(modelId))
  ) {
    throw new Error(XAI_PAYLOAD_MODEL_ERROR);
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
 * OAuth requests receive the encrypted-reasoning include policy and default to
 * `store: false` (a caller payload hook may supply its own `store`) after
 * canonicalization, model pinning, entitlement checks, and inline-image
 * compaction; API-key requests retain their separate route.
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
 * same-model history are aligned only for internal conversion. A classified
 * encrypted-reasoning mismatch retries once without replayed reasoning, only
 * before assistant content is forwarded and while not cancelled. Each attempt
 * repeats payload hooks and local guards. A failed retry retains fixed guidance
 * so the next same-model request also omits rejected reasoning, preserving
 * visible and tool-result history.
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
  const delegateContext = prepareXaiDelegateContext(
    context,
    model,
    selectedModelId,
  );
  let omitRejectedReasoning = shouldOmitRejectedEncryptedReasoning(
    context,
    model,
    selectedModelId,
  );
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
  let sentEncryptedReasoning = false;
  let attemptPayloadReady = false;
  void (async () => {
    // Pi's generic OpenAI delegate does not expose fetch redirect controls.
    // Keep one URL-scoped guard installed only for the lifetime of active xAI
    // streams; unrelated requests pass through unchanged, and overlapping xAI
    // streams share the same guard until the last request completes.
    const releaseRedirectGuard = acquireXaiRedirectGuard(route.url);
    try {
      const startAttempt = () => streamSimpleOpenAIResponses(
        openAIResponsesModel as Model<"openai-responses">,
        delegateContext,
        {
          ...options,
          signal: transportSignal,
          // Prevent Pi's generic OpenAI delegate from adding its own
          // session_id/x-client-request-id affinity headers. The xAI payload
          // rewrite below still receives the stable session for cache keys.
          sessionId: undefined,
          // Rebuild protected metadata for each physical attempt, retaining
          // conversation/session affinity but never reusing a request ID.
          headers: {
            ...scrubXaiReservedHeaders(options?.headers),
            ...xaiProxyRequestHeaders(selectedModelId, credentialKind, {
              conversationId: routingSessionId,
              requestId: randomUUID(),
              sessionId: routingSessionId,
            }, { streaming: true }),
          },
          // Generic retries reuse a once-validated payload. Only the bounded
          // mismatch recovery below may retry, repeating every local guard.
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
            const finalPayload = await compactXaiInlineImages(exposedPayload) as Record<string, unknown>;
            assertXaiRuntimeModelAcceptsPayload(selectedModelId, finalPayload);
            transportSignal.throwIfAborted();
            sentEncryptedReasoning = Array.isArray(finalPayload.input) &&
              finalPayload.input.some(isEncryptedReasoningItem);
            attemptPayloadReady = true;
            return finalPayload;
          },
        },
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        grokNativeToolRoutes = {};
        sentEncryptedReasoning = false;
        attemptPayloadReady = false;
        let pendingStart: AssistantStreamEvent | undefined;
        let forwardedContent = false;
        let retry = false;
        const inner = startAttempt();
        for await (const event of inner as AsyncIterable<AssistantStreamEvent>) {
          let normalized = normalizeXaiStreamEvent(event, grokNativeToolRoutes, model);
          if (normalized.type === "start") {
            // Do not expose the rejected attempt's live partial or a duplicate
            // start. Content events immediately flush the successful sequence.
            pendingStart = normalized;
            continue;
          }
          const terminal = normalized.type === "done" || normalized.type === "error";
          const failed = normalized.type === "error" &&
            normalized.reason !== "aborted" &&
            normalized.error?.stopReason !== "aborted" &&
            !transportSignal.aborted;
          if (
            attempt === 0 && failed && sentEncryptedReasoning && !forwardedContent &&
            normalized.error?.errorMessage === XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE
          ) {
            omitRejectedReasoning = true;
            retry = true;
            break;
          }
          if (attempt === 1 && failed && attemptPayloadReady) {
            normalized = {
              ...normalized,
              error: { ...normalized.error, errorMessage: XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE },
            };
          }
          if (pendingStart) {
            stream.push(pendingStart);
            pendingStart = undefined;
          }
          if (terminal) releaseRedirectGuard();
          else forwardedContent = true;
          stream.push(normalized);
        }
        if (!retry) break;
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
