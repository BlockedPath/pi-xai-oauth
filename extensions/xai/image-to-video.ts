import { abortableSleep as sharedAbortableSleep, cancellationError, composeTimeoutSignal } from "./abort";
import { hasJsonContentType, readBoundedResponseText } from "./bounded-body";
import { defaultImageCodec, prepareImageReferences, type ImageCodec } from "./media/compression";
import {
  IMAGE_TO_VIDEO_CREATE_TIMEOUT_MS,
  IMAGE_TO_VIDEO_DEFAULT_DURATION,
  IMAGE_TO_VIDEO_DEFAULT_RESOLUTION,
  IMAGE_TO_VIDEO_DURATIONS,
  IMAGE_TO_VIDEO_GENERATION_TIMEOUT_MS,
  IMAGE_TO_VIDEO_MAX_JSON_BYTES,
  IMAGE_TO_VIDEO_MAX_PROMPT_BYTES,
  IMAGE_TO_VIDEO_MAX_PROMPT_CHARS,
  IMAGE_TO_VIDEO_MODEL,
  IMAGE_TO_VIDEO_POLL_INTERVAL_MS,
  IMAGE_TO_VIDEO_POLL_TIMEOUT_MS,
  IMAGE_TO_VIDEO_RESOLUTIONS,
} from "./media/constants";
import { parseBoundedImageDataUrl } from "./media/data-url";
import { videoOutputRoot } from "./media/output-storage";
import { readBoundedWorkspaceImageFile } from "./media/paths";
import type { PreparedImageReference, SavedVideoOutput } from "./media/types";
import { resolveXaiRoute, type XaiCredential } from "./routing";
import { downloadXaiVideo, type VideoDownloadDependencies } from "./video-download";
import { xaiDirectMediaJsonGetHeaders, xaiDirectMediaJsonHeaders } from "./wire";

export interface XaiImageToVideoInput {
  image: { path: string } | { data_url: string };
  prompt?: string;
  duration: 6 | 10;
  resolution: "480p" | "720p";
}

interface SessionLocation {
  getSessionDir(): string;
  getSessionId(): string;
}

export interface ImageToVideoDependencies {
  fetch?: typeof fetch;
  codec?: ImageCodec;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  createTimeoutMs?: number;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  generationTimeoutMs?: number;
  maxJsonBytes?: number;
  videoDownload?: VideoDownloadDependencies;
}

export class ImageToVideoOperationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_input"
      | "cancelled"
      | "timeout"
      | "network_failure"
      | "http_failure"
      | "invalid_response"
      | "remote_failure"
      | "output_failure",
    readonly status?: number,
  ) {
    super(message);
    this.name = "ImageToVideoOperationError";
  }
}

function invalidInput(message: string): never {
  throw new ImageToVideoOperationError(message, "invalid_input");
}

function validateImage(value: unknown): { path: string } | { data_url: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidInput("Image-to-video requires exactly one path or data_url image reference.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || (keys[0] !== "path" && keys[0] !== "data_url")) {
    return invalidInput("Image-to-video requires exactly one path or data_url image reference.");
  }
  const key = keys[0] as "path" | "data_url";
  const source = record[key];
  if (typeof source !== "string" || !source.trim()) return invalidInput("Image reference must be non-empty.");
  if (key === "path" && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source) && !/^[A-Za-z]:[\\/]/.test(source)) {
    return invalidInput("Image-to-video source paths do not accept URL schemes.");
  }
  return key === "path" ? { path: source } : { data_url: source };
}

/** Validate cheap image-to-video input before credential, media, or network I/O. */
export function validateXaiImageToVideoInput(value: unknown): XaiImageToVideoInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidInput("Image-to-video input must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["image", "prompt", "duration", "resolution"].includes(key))) {
    return invalidInput("Image-to-video input contains unsupported fields.");
  }
  const image = validateImage(record.image);
  if (record.prompt !== undefined) {
    if (typeof record.prompt !== "string" || !record.prompt.trim()) {
      return invalidInput("Image-to-video prompt must be non-empty when supplied.");
    }
    if (
      record.prompt.length > IMAGE_TO_VIDEO_MAX_PROMPT_CHARS ||
      Buffer.byteLength(record.prompt, "utf8") > IMAGE_TO_VIDEO_MAX_PROMPT_BYTES
    ) return invalidInput("Image-to-video prompt exceeds the length limit.");
  }
  const duration = record.duration ?? IMAGE_TO_VIDEO_DEFAULT_DURATION;
  if (!IMAGE_TO_VIDEO_DURATIONS.includes(duration as any)) {
    return invalidInput("Image-to-video duration must be 6 or 10 seconds.");
  }
  const resolution = record.resolution ?? IMAGE_TO_VIDEO_DEFAULT_RESOLUTION;
  if (!IMAGE_TO_VIDEO_RESOLUTIONS.includes(resolution as any)) {
    return invalidInput("Image-to-video resolution must be 480p or 720p.");
  }
  return {
    image,
    ...(typeof record.prompt === "string" ? { prompt: record.prompt } : {}),
    duration: duration as 6 | 10,
    resolution: resolution as "480p" | "720p",
  };
}

export function buildXaiImageToVideoPayload(
  input: XaiImageToVideoInput,
  reference: PreparedImageReference,
): Record<string, unknown> {
  return {
    model: IMAGE_TO_VIDEO_MODEL,
    prompt: input.prompt ?? "",
    image: { url: reference.dataUrl },
    duration: input.duration,
    resolution: input.resolution,
  };
}

export function validateVideoRequestId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new ImageToVideoOperationError("xAI video generation returned an invalid request identifier.", "invalid_response");
  }
  return value;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return sharedAbortableSleep(ms, signal, () => cancellationError("Cancelled"));
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<any> {
  if (!hasJsonContentType(response)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ImageToVideoOperationError("xAI video generation returned an invalid response type.", "invalid_response");
  }
  if (!response.body) throw new ImageToVideoOperationError("xAI video generation returned an empty response.", "invalid_response");
  const abort = composeTimeoutSignal(signal, timeoutMs);
  let text: string;
  try {
    text = await readBoundedResponseText(response, {
      maxBytes,
      signal: abort.signal,
      checkDeclaredLength: false,
      abortError: () => cancellationError("Cancelled"),
      overflowError: () =>
        new ImageToVideoOperationError("xAI video response exceeded the byte limit.", "invalid_response"),
    });
  } catch (error) {
    if (signal.aborted) throw new ImageToVideoOperationError("Local video generation tracking was cancelled.", "cancelled");
    if (abort.timedOut()) throw new ImageToVideoOperationError("xAI video response timed out.", "timeout");
    throw error;
  } finally {
    abort.dispose();
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new ImageToVideoOperationError("xAI video generation returned invalid JSON.", "invalid_response");
  }
}

async function fetchTimed(options: {
  url: string;
  init: RequestInit;
  callerSignal?: AbortSignal;
  timeoutMs: number;
  fetch: typeof fetch;
}): Promise<Response> {
  const abort = composeTimeoutSignal(options.callerSignal, options.timeoutMs);
  try {
    return await options.fetch(options.url, { ...options.init, signal: abort.signal, redirect: "error" });
  } catch {
    if (options.callerSignal?.aborted) throw new ImageToVideoOperationError("Local video generation tracking was cancelled.", "cancelled");
    if (abort.timedOut()) throw new ImageToVideoOperationError("xAI video request timed out.", "timeout");
    throw new ImageToVideoOperationError("xAI video request failed. Check the network and try again.", "network_failure");
  } finally {
    abort.dispose();
  }
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Execute the pinned asynchronous image-to-video workflow and save one private MP4. */
export async function executeXaiImageToVideo(options: {
  credential: XaiCredential;
  input: XaiImageToVideoInput;
  workspaceRoot: string;
  sessionManager: SessionLocation;
  signal?: AbortSignal;
}, dependencies: ImageToVideoDependencies = {}): Promise<SavedVideoOutput> {
  const input = validateXaiImageToVideoInput(options.input);
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? abortableSleep;
  const deadline = now() + (dependencies.generationTimeoutMs ?? IMAGE_TO_VIDEO_GENERATION_TIMEOUT_MS);
  let sessionRoot: string;
  let outputRoot: string;
  try {
    sessionRoot = options.sessionManager.getSessionDir();
    outputRoot = videoOutputRoot(options.sessionManager);
  } catch {
    throw new ImageToVideoOperationError("A safe Pi session output directory is unavailable.", "output_failure");
  }
  let image;
  try {
    image = "path" in input.image
      ? await readBoundedWorkspaceImageFile(input.image.path, options.workspaceRoot, options.signal)
      : parseBoundedImageDataUrl(input.image.data_url);
  } catch (error) {
    if (options.signal?.aborted) throw new ImageToVideoOperationError("Local video generation was cancelled.", "cancelled");
    throw new ImageToVideoOperationError(error instanceof Error ? error.message : "Image reference is invalid.", "invalid_input");
  }
  let references: PreparedImageReference[];
  try {
    references = await prepareImageReferences([image], {
      codec: dependencies.codec ?? defaultImageCodec(),
      signal: options.signal,
    });
  } catch {
    if (options.signal?.aborted) {
      throw new ImageToVideoOperationError("Local video generation was cancelled before submission.", "cancelled");
    }
    throw new ImageToVideoOperationError("Image reference could not be verified or compressed safely.", "invalid_input");
  }
  const payload = buildXaiImageToVideoPayload(input, references[0]);
  const createRoute = resolveXaiRoute(options.credential.kind, "video-generation-create");
  const createExchangeDeadline = now() + Math.min(
    dependencies.createTimeoutMs ?? IMAGE_TO_VIDEO_CREATE_TIMEOUT_MS,
    Math.max(1, deadline - now()),
  );
  const create = await fetchTimed({
    url: createRoute.url,
    init: {
      method: "POST",
      headers: xaiDirectMediaJsonHeaders(options.credential.token),
      body: JSON.stringify(payload),
    },
    callerSignal: options.signal,
    timeoutMs: Math.max(1, createExchangeDeadline - now()),
    fetch: fetcher,
  });
  if (!create.ok) {
    await create.body?.cancel().catch(() => undefined);
    throw new ImageToVideoOperationError(`xAI video generation failed with HTTP ${create.status}.`, "http_failure", create.status);
  }
  const created = await readBoundedJson(
    create,
    dependencies.maxJsonBytes ?? IMAGE_TO_VIDEO_MAX_JSON_BYTES,
    options.signal ?? new AbortController().signal,
    Math.max(1, createExchangeDeadline - now()),
  );
  const requestId = validateVideoRequestId(created.request_id);
  const statusBase = resolveXaiRoute(options.credential.kind, "video-generation-status").url;
  let transientFailures = 0;
  while (now() < deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    try {
      await sleep(Math.min(dependencies.pollIntervalMs ?? IMAGE_TO_VIDEO_POLL_INTERVAL_MS, remaining), options.signal);
    } catch {
      throw new ImageToVideoOperationError("Local waiting was cancelled; the remote xAI video job was not cancelled and may continue consuming usage or credits.", "cancelled");
    }
    if (now() >= deadline) break;
    let statusResponse: Response;
    const pollExchangeDeadline = now() + Math.min(
      dependencies.pollTimeoutMs ?? IMAGE_TO_VIDEO_POLL_TIMEOUT_MS,
      Math.max(1, deadline - now()),
    );
    try {
      statusResponse = await fetchTimed({
        url: `${statusBase}${encodeURIComponent(requestId)}`,
        init: {
          method: "GET",
          headers: xaiDirectMediaJsonGetHeaders(options.credential.token),
        },
        callerSignal: options.signal,
        timeoutMs: Math.max(1, pollExchangeDeadline - now()),
        fetch: fetcher,
      });
    } catch (error) {
      if (error instanceof ImageToVideoOperationError && error.code === "cancelled") {
        throw new ImageToVideoOperationError("Local waiting was cancelled; the remote xAI video job was not cancelled and may continue consuming usage or credits.", "cancelled");
      }
      if (++transientFailures > 3) throw error;
      continue;
    }
    if (statusResponse.status !== 200 && statusResponse.status !== 202) {
      await statusResponse.body?.cancel().catch(() => undefined);
      if (transientStatus(statusResponse.status) && ++transientFailures <= 3) continue;
      throw new ImageToVideoOperationError(`xAI video status failed with HTTP ${statusResponse.status}.`, "http_failure", statusResponse.status);
    }
    const statusData = await readBoundedJson(
      statusResponse,
      dependencies.maxJsonBytes ?? IMAGE_TO_VIDEO_MAX_JSON_BYTES,
      options.signal ?? new AbortController().signal,
      Math.max(1, pollExchangeDeadline - now()),
    );
    transientFailures = 0;
    const status = statusData.status;
    if (typeof status !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(status)) {
      throw new ImageToVideoOperationError("xAI video status response was invalid.", "invalid_response");
    }
    if (status === "failed" || status === "expired") {
      throw new ImageToVideoOperationError(`xAI video generation ${status}.`, "remote_failure");
    }
    if (status !== "done") continue;
    if (!statusData.video || typeof statusData.video !== "object" || typeof statusData.video.url !== "string") {
      throw new ImageToVideoOperationError("xAI video generation completed without a valid download.", "invalid_response");
    }
    try {
      return await downloadXaiVideo({
        url: statusData.video.url,
        outputRoot,
        sessionRoot,
        duration: input.duration,
        resolution: input.resolution,
        signal: options.signal,
      }, dependencies.videoDownload);
    } catch (error) {
      if (options.signal?.aborted) {
        throw new ImageToVideoOperationError("Local download was cancelled; the remote xAI video job was not cancelled and may continue consuming usage or credits.", "cancelled");
      }
      throw new ImageToVideoOperationError(error instanceof Error ? error.message : "Video output failed safely.", "output_failure");
    }
  }
  throw new ImageToVideoOperationError("xAI video generation exceeded the five-minute deadline; the remote job may still continue.", "timeout");
}
