import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
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
  XAI_OPAQUE_RESPONSES_FAILED_MESSAGE,
  xaiHttpErrorFromResponse,
  xaiJsonPostHeaders,
  xaiProxyRequestHeaders,
} from "./wire";

const streamSimpleOpenAIResponses = openAIResponsesApi().streamSimple;

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
): Context {
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
  return changed ? { ...context, messages } : context;
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

function contextHasReplayableEncryptedReasoning(
  context: Context,
  model: Model<Api>,
  selectedModelId: string,
): boolean {
  for (const message of context.messages) {
    if (!isReplayCompatibleXaiMessage(message, model, selectedModelId))
      continue;
    for (const block of message.content ?? []) {
      if (
        !block ||
        typeof block !== "object" ||
        (block as { type?: unknown }).type !== "thinking"
      ) {
        continue;
      }
      const signature = (block as { thinkingSignature?: unknown })
        .thinkingSignature;
      if (typeof signature !== "string" || !signature) continue;
      try {
        const parsed = JSON.parse(signature) as { encrypted_content?: unknown };
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.encrypted_content === "string" &&
          parsed.encrypted_content.length > 0
        ) {
          return true;
        }
      } catch {
        // Ignore malformed signatures; replay code will drop them later.
      }
    }
  }
  return false;
}

function promoteOpaqueResponsesFailure(
  event: AssistantStreamEvent,
  context: Context,
  model: Model<Api>,
  selectedModelId: string,
): AssistantStreamEvent {
  if (
    event.type !== "error" ||
    !event.error ||
    typeof event.error !== "object" ||
    !contextHasReplayableEncryptedReasoning(context, model, selectedModelId)
  ) {
    return event;
  }
  const error = event.error as Record<string, unknown>;
  if (error.errorMessage !== XAI_OPAQUE_RESPONSES_FAILED_MESSAGE) return event;
  return {
    ...event,
    error: {
      ...error,
      errorMessage: XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE,
    },
  };
}

function isAssistantContentStreamEvent(event: AssistantStreamEvent): boolean {
  return (
    event.type === "text_start" ||
    event.type === "text_delta" ||
    event.type === "text_end" ||
    event.type === "thinking_start" ||
    event.type === "thinking_delta" ||
    event.type === "thinking_end" ||
    event.type === "toolcall_start" ||
    event.type === "toolcall_delta" ||
    event.type === "toolcall_end"
  );
}

function mismatchErrorMessage(event: AssistantStreamEvent): string | undefined {
  if (event.type !== "error" || !event.error || typeof event.error !== "object") {
    return undefined;
  }
  const message = (event.error as Record<string, unknown>).errorMessage;
  return typeof message === "string" ? message : undefined;
}

function isEncryptedReasoningMismatchMessage(message: string | undefined): boolean {
  return message === XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE;
}

function omitRejectedEncryptedReasoning(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(payload.input)) return payload;
  const input = payload.input.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return true;
    const item = value as Record<string, unknown>;
    return item.type !== "reasoning" || !("encrypted_content" in item);
  });
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
 * same-model history are aligned only for internal conversion; after a fixed
 * encrypted-reasoning mismatch, this stream omits rejected encrypted reasoning
 * and retries once in the same turn when no assistant content has been
 * forwarded yet. If an earlier mismatch error remains in history, the next
 * same-model request also omits rejected encrypted reasoning while retaining
 * visible and tool-result history. Status-less `Responses failed` errors with
 * replayable encrypted reasoning are promoted onto the same mismatch recovery
 * path.
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
  const delegateContext = prepareXaiDelegateContext(
    context,
    model,
    selectedModelId,
  );
  const omitRejectedReasoning = shouldOmitRejectedEncryptedReasoning(
    context,
    model,
    selectedModelId,
  );
  const canSameTurnOmitRetry =
    !omitRejectedReasoning &&
    contextHasReplayableEncryptedReasoning(context, model, selectedModelId);
  // Mutable for the one same-turn sanitized retry after an encrypted-reasoning
  // mismatch. Entitlement-sensitive transport retries stay disabled below.
  let omitForAttempt = omitRejectedReasoning;
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
    const releaseRedirectGuard = acquireXaiRedirectGuard(route.url);
    const pushTerminalError = (error: unknown) => {
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
      if (
        message.errorMessage === XAI_OPAQUE_RESPONSES_FAILED_MESSAGE &&
        contextHasReplayableEncryptedReasoning(
          context,
          model,
          selectedModelId,
        )
      ) {
        message.errorMessage = XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE;
      }
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    };
    try {
      const maxAttempts = canSameTurnOmitRetry ? 2 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        omitForAttempt = omitRejectedReasoning || attempt > 0;
        grokNativeToolRoutes = {};
        const attemptHeaders =
          attempt === 0
            ? headers
            : {
                ...headers,
                ...xaiProxyRequestHeaders(
                  selectedModelId,
                  credentialKind,
                  {
                    conversationId: routingSessionId,
                    requestId: randomUUID(),
                    sessionId: routingSessionId,
                  },
                  { streaming: true },
                ),
              };
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
            headers: attemptHeaders,
            // Transport-level retries stay off: entitlement can change between
            // attempts. Encrypted-reasoning mismatch recovery is handled here by
            // starting a fresh request that repeats every local guard with omit.
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
              const replaySafePayload = omitForAttempt
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

        const buffered: AssistantStreamEvent[] = [];
        let forwarded = false;
        let streamedContent = false;
        let retrySameTurn = false;

        for await (const event of inner as AsyncIterable<AssistantStreamEvent>) {
          const normalized = normalizeXaiStreamEvent(
            event,
            grokNativeToolRoutes,
            model,
          );
          const outward =
            normalized.type === "error"
              ? promoteOpaqueResponsesFailure(
                  normalized,
                  context,
                  model,
                  selectedModelId,
                )
              : normalized;

          // Drain a rejected first attempt fully before the sanitized retry so
          // the abandoned delegate iterator cannot race the next request.
          if (retrySameTurn) {
            if (outward.type === "error" || outward.type === "done") break;
            continue;
          }

          if (isAssistantContentStreamEvent(outward)) streamedContent = true;

          if (!forwarded) {
            if (
              outward.type === "error" &&
              attempt + 1 < maxAttempts &&
              !streamedContent &&
              isEncryptedReasoningMismatchMessage(
                mismatchErrorMessage(outward),
              )
            ) {
              buffered.length = 0;
              retrySameTurn = true;
              continue;
            }
            if (outward.type === "error" || outward.type === "done") {
              for (const item of buffered) stream.push(item);
              buffered.length = 0;
              stream.push(outward);
              releaseRedirectGuard();
              stream.end(
                outward.type === "done" ? outward.message : outward.error,
              );
              return;
            }
            if (isAssistantContentStreamEvent(outward)) {
              forwarded = true;
              for (const item of buffered) stream.push(item);
              buffered.length = 0;
              stream.push(outward);
              continue;
            }
            buffered.push(outward);
            continue;
          }

          stream.push(outward);
          if (outward.type === "error" || outward.type === "done") {
            releaseRedirectGuard();
            stream.end(
              outward.type === "done" ? outward.message : outward.error,
            );
            return;
          }
        }

        if (retrySameTurn) continue;

        if (!forwarded && buffered.length > 0) {
          for (const item of buffered) stream.push(item);
        }
        releaseRedirectGuard();
        stream.end();
        return;
      }
    } catch (error) {
      releaseRedirectGuard();
      pushTerminalError(error);
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
