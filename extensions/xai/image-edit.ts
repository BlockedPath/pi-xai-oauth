import { cancellationError, composeTimeoutSignal } from "./abort";
import { readBoundedResponseText } from "./bounded-body";
import type { XaiCredential } from "./routing";
import { resolveXaiRoute } from "./routing";
import {
  IMAGE_EDIT_MAX_OUTPUT_BASE64_CHARS,
  IMAGE_EDIT_MAX_OUTPUT_BYTES,
  IMAGE_EDIT_MAX_OUTPUT_PIXELS,
  IMAGE_EDIT_MAX_OUTPUT_SIDE_PX,
  IMAGE_EDIT_MAX_PROMPT_BYTES,
  IMAGE_EDIT_MAX_PROMPT_CHARS,
  IMAGE_EDIT_MAX_REFERENCES,
  IMAGE_EDIT_MAX_REQUEST_JSON_BYTES,
  IMAGE_EDIT_MAX_RESPONSE_JSON_BYTES,
  IMAGE_EDIT_MODEL,
  IMAGE_EDIT_OUTPUT_COUNT,
  IMAGE_EDIT_REQUEST_TIMEOUT_MS,
  IMAGE_EDIT_RESOLUTION,
  IMAGE_EDIT_RESPONSE_FORMAT,
} from "./media/constants";
import { prepareImageReferences, type ImageCodec, defaultImageCodec } from "./media/compression";
import { decodeStrictBase64, parseBoundedImageDataUrl } from "./media/data-url";
import { inspectSupportedImageBytes } from "./media/image-info";
import { imageEditOutputRoot, saveVerifiedOutputImage } from "./media/output-storage";
import { readBoundedWorkspaceImageFile } from "./media/paths";
import type { PreparedImageReference, SavedImageOutput, VerifiedImageBytes } from "./media/types";
import { xaiDirectMediaJsonHeaders } from "./wire";

export const IMAGE_EDIT_ASPECT_RATIOS = [
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2",
  "19.5:9", "9:19.5", "20:9", "9:20", "auto",
] as const;

export interface XaiEditImagePathReference {
  path: string;
}

export interface XaiEditImageDataUrlReference {
  data_url: string;
}

export interface XaiEditImageInput {
  prompt: string;
  image: Array<XaiEditImagePathReference | XaiEditImageDataUrlReference>;
  aspect_ratio?: string;
}

interface SessionLocation {
  getSessionDir(): string;
  getSessionId(): string;
}

export interface ExecuteXaiImageEditOptions {
  credential: XaiCredential;
  input: XaiEditImageInput;
  workspaceRoot: string;
  sessionManager: SessionLocation;
  signal?: AbortSignal;
}

export interface ImageEditDependencies {
  codec?: ImageCodec;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  responseMaxBytes?: number;
}

export type ImageEditErrorCode =
  | "invalid_input"
  | "cancelled"
  | "timeout"
  | "network_failure"
  | "http_failure"
  | "invalid_response"
  | "output_failure";

export class ImageEditOperationError extends Error {
  constructor(
    message: string,
    readonly code: ImageEditErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ImageEditOperationError";
  }
}

function invalidInput(message: string): never {
  throw new ImageEditOperationError(message, "invalid_input");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function safeRequestId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

function validateReferenceShape(value: unknown): XaiEditImagePathReference | XaiEditImageDataUrlReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidInput("Each image reference must contain exactly one path or data_url field.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || (keys[0] !== "path" && keys[0] !== "data_url")) {
    return invalidInput("Each image reference must contain exactly one path or data_url field.");
  }
  const field = keys[0] as "path" | "data_url";
  const source = record[field];
  if (typeof source !== "string" || !source.trim()) {
    return invalidInput("Image reference values must be non-empty strings.");
  }
  if (field === "path") {
    const windowsDrivePath = /^[A-Za-z]:[\\/]/.test(source);
    if (!windowsDrivePath && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)) {
      return invalidInput("Image path references do not accept URL schemes.");
    }
    return { path: source };
  }
  return { data_url: source };
}

/** Validate cheap image-edit input shape before credential or media I/O. */
export function validateXaiEditImageInput(input: unknown): XaiEditImageInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalidInput("Image edit input must be an object.");
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "prompt" && key !== "image" && key !== "aspect_ratio")) {
    return invalidInput("Image edit input contains unsupported fields.");
  }
  if (typeof record.prompt !== "string" || !record.prompt.trim()) {
    return invalidInput("Image edit prompt must be a non-empty string.");
  }
  if (
    record.prompt.length > IMAGE_EDIT_MAX_PROMPT_CHARS
    || Buffer.byteLength(record.prompt, "utf8") > IMAGE_EDIT_MAX_PROMPT_BYTES
  ) {
    return invalidInput("Image edit prompt exceeds the length limit.");
  }
  if (!Array.isArray(record.image) || record.image.length < 1 || record.image.length > IMAGE_EDIT_MAX_REFERENCES) {
    return invalidInput(`Image edit requires 1-${IMAGE_EDIT_MAX_REFERENCES} references.`);
  }
  const image = record.image.map(validateReferenceShape);
  const aspectRatio = record.aspect_ratio;
  if (
    aspectRatio !== undefined
    && (
      typeof aspectRatio !== "string"
      || !(IMAGE_EDIT_ASPECT_RATIOS as readonly string[]).includes(aspectRatio)
    )
  ) {
    return invalidInput("Image edit aspect_ratio must be supported when supplied.");
  }
  if (image.length > 1) {
    if (typeof aspectRatio !== "string") {
      return invalidInput("Multiple image references require a supported aspect_ratio.");
    }
  }
  return {
    prompt: record.prompt,
    image,
    ...(typeof aspectRatio === "string" ? { aspect_ratio: aspectRatio } : {}),
  };
}

/** Build the exact source-backed singular/plural xAI image-edit wire payload. */
export function buildXaiImageEditPayload(
  input: XaiEditImageInput,
  references: readonly PreparedImageReference[],
): Record<string, unknown> {
  if (references.length !== input.image.length || references.length < 1) {
    return invalidInput("Prepared image reference count does not match the request.");
  }
  const payload: Record<string, unknown> = {
    model: IMAGE_EDIT_MODEL,
    prompt: input.prompt,
    n: IMAGE_EDIT_OUTPUT_COUNT,
    resolution: IMAGE_EDIT_RESOLUTION,
    response_format: IMAGE_EDIT_RESPONSE_FORMAT,
  };
  const wireReferences = references.map(({ dataUrl }) => ({ url: dataUrl }));
  if (wireReferences.length === 1) {
    payload.image = wireReferences[0];
  } else {
    if (!input.aspect_ratio || !(IMAGE_EDIT_ASPECT_RATIOS as readonly string[]).includes(input.aspect_ratio)) {
      return invalidInput("Multiple image references require a supported aspect_ratio.");
    }
    payload.images = wireReferences;
    payload.aspect_ratio = input.aspect_ratio;
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > IMAGE_EDIT_MAX_REQUEST_JSON_BYTES) {
    return invalidInput("Image edit request exceeds the aggregate request-byte limit.");
  }
  return payload;
}

function readBoundedResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  return readBoundedResponseText(response, {
    maxBytes,
    signal,
    emptyBody: "empty",
    checkDeclaredLength: false,
    abortError: () => cancellationError(),
    overflowError: () =>
      new ImageEditOperationError("xAI image edit response exceeded the byte limit.", "invalid_response"),
  });
}

async function postBoundedImageEdit(
  credential: XaiCredential,
  body: Record<string, unknown>,
  callerSignal: AbortSignal | undefined,
  dependencies: ImageEditDependencies,
): Promise<unknown> {
  const abort = composeTimeoutSignal(
    callerSignal,
    dependencies.requestTimeoutMs ?? IMAGE_EDIT_REQUEST_TIMEOUT_MS,
  );

  try {
    if (callerSignal?.aborted) {
      throw new ImageEditOperationError("xAI image edit was cancelled.", "cancelled");
    }
    const route = resolveXaiRoute(credential.kind, "image-edit");
    let response: Response;
    try {
      response = await (dependencies.fetch ?? fetch)(route.url, {
        method: "POST",
        headers: xaiDirectMediaJsonHeaders(credential.token),
        body: JSON.stringify(body),
        redirect: "error",
        signal: abort.signal,
      });
    } catch (error) {
      if (callerSignal?.aborted) throw new ImageEditOperationError("xAI image edit was cancelled.", "cancelled");
      if (abort.timedOut()) throw new ImageEditOperationError("xAI image edit timed out.", "timeout");
      if (isAbortError(error)) throw new ImageEditOperationError("xAI image edit was cancelled.", "cancelled");
      throw new ImageEditOperationError("xAI image edit request failed. Check the network and try again.", "network_failure");
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const requestId = safeRequestId(response.headers.get("x-request-id"));
      const suffix = requestId ? ` Request ID: ${requestId}.` : "";
      throw new ImageEditOperationError(
        `xAI image edit failed with HTTP ${response.status}.${suffix} Check the prompt and reference images.`,
        "http_failure",
        response.status,
      );
    }
    const text = await readBoundedResponse(
      response,
      dependencies.responseMaxBytes ?? IMAGE_EDIT_MAX_RESPONSE_JSON_BYTES,
      abort.signal,
    );
    try {
      return JSON.parse(text);
    } catch {
      throw new ImageEditOperationError("xAI image edit returned an invalid JSON response.", "invalid_response");
    }
  } catch (error) {
    if (error instanceof ImageEditOperationError) throw error;
    if (callerSignal?.aborted) throw new ImageEditOperationError("xAI image edit was cancelled.", "cancelled");
    if (abort.timedOut()) throw new ImageEditOperationError("xAI image edit timed out.", "timeout");
    throw new ImageEditOperationError("xAI image edit response could not be read safely.", "invalid_response");
  } finally {
    abort.dispose();
  }
}

async function verifyOutputImage(
  response: unknown,
  codec: ImageCodec,
  signal?: AbortSignal,
): Promise<VerifiedImageBytes> {
  const data = (response as any)?.data;
  if (!Array.isArray(data) || data.length !== 1 || typeof data[0]?.b64_json !== "string") {
    throw new ImageEditOperationError("xAI image edit must return exactly one base64 image.", "invalid_response");
  }
  let bytes: Buffer;
  try {
    bytes = decodeStrictBase64(
      data[0].b64_json,
      IMAGE_EDIT_MAX_OUTPUT_BASE64_CHARS,
      IMAGE_EDIT_MAX_OUTPUT_BYTES,
    );
  } catch {
    throw new ImageEditOperationError("xAI image edit returned invalid or oversized base64 image data.", "invalid_response");
  }
  let inspected;
  try {
    inspected = inspectSupportedImageBytes(bytes, {
      maxPixels: IMAGE_EDIT_MAX_OUTPUT_PIXELS,
      maxSidePx: IMAGE_EDIT_MAX_OUTPUT_SIDE_PX,
    });
    const image: VerifiedImageBytes = { bytes, ...inspected, source: "output" };
    const decoded = await codec.verify(image, signal);
    if (
      !Number.isSafeInteger(decoded.width)
      || !Number.isSafeInteger(decoded.height)
      || decoded.width <= 0
      || decoded.height <= 0
      || Math.max(decoded.width, decoded.height) > IMAGE_EDIT_MAX_OUTPUT_SIDE_PX
      || decoded.width > Math.floor(IMAGE_EDIT_MAX_OUTPUT_PIXELS / decoded.height)
    ) {
      throw new Error("Decoded image dimensions exceed the output limit.");
    }
    return { ...image, ...decoded };
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ImageEditOperationError("xAI image edit returned an invalid or oversized PNG/JPEG.", "invalid_response");
  }
}

/** Execute a bounded pinned image edit and atomically persist one verified output. */
export async function executeXaiImageEdit(
  options: ExecuteXaiImageEditOptions,
  dependencies: ImageEditDependencies = {},
): Promise<SavedImageOutput> {
  const input = validateXaiEditImageInput(options.input);
  if (options.signal?.aborted) {
    throw new ImageEditOperationError("xAI image edit was cancelled.", "cancelled");
  }
  const codec = dependencies.codec ?? defaultImageCodec();
  let sessionRoot: string;
  let outputRoot: string;
  try {
    sessionRoot = options.sessionManager.getSessionDir();
    outputRoot = imageEditOutputRoot(options.sessionManager);
  } catch {
    throw new ImageEditOperationError("A safe Pi session output directory is unavailable.", "output_failure");
  }

  const images: VerifiedImageBytes[] = [];
  try {
    for (const reference of input.image) {
      images.push(
        "path" in reference
          ? await readBoundedWorkspaceImageFile(reference.path, options.workspaceRoot, options.signal)
          : parseBoundedImageDataUrl(reference.data_url),
      );
    }
  } catch (error) {
    if (isAbortError(error)) throw new ImageEditOperationError("xAI image edit was cancelled.", "cancelled");
    throw new ImageEditOperationError(
      error instanceof Error ? error.message : "Image reference could not be read safely.",
      "invalid_input",
    );
  }

  let references: PreparedImageReference[];
  try {
    references = await prepareImageReferences(images, { codec, signal: options.signal });
  } catch (error) {
    if (isAbortError(error)) throw new ImageEditOperationError("xAI image edit was cancelled.", "cancelled");
    throw new ImageEditOperationError(
      "Image reference could not be verified or compressed safely.",
      "invalid_input",
    );
  }

  const payload = buildXaiImageEditPayload(input, references);
  const response = await postBoundedImageEdit(options.credential, payload, options.signal, dependencies);
  let output: VerifiedImageBytes;
  try {
    output = await verifyOutputImage(response, codec, options.signal);
  } catch (error) {
    if (isAbortError(error)) throw new ImageEditOperationError("xAI image edit was cancelled.", "cancelled");
    throw error;
  }
  try {
    return await saveVerifiedOutputImage(output, {
      outputRoot,
      sessionRoot,
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw new ImageEditOperationError("xAI image edit was cancelled.", "cancelled");
    throw new ImageEditOperationError("The verified image could not be saved to Pi session storage.", "output_failure");
  }
}
