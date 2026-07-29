import { resizeImage } from "@earendil-works/pi-coding-agent";
import { awaitAbortable, cancellationError } from "../abort";
import {
  IMAGE_EDIT_MAX_AGGREGATE_REFERENCE_BYTES,
  IMAGE_EDIT_MAX_REFERENCES,
  MEDIA_MAX_SOURCE_PIXELS,
  MEDIA_REFERENCE_COMPRESS_MAX_SIDE_PX,
  MEDIA_REFERENCE_COMPRESS_MIN_SIDE_PX,
  MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES,
  MEDIA_REFERENCE_QUALITY_STEPS,
} from "./constants";
import { decodeStrictBase64, toImageDataUrl } from "./data-url";
import { inspectSupportedImageBytes } from "./image-info";
import type { PreparedImageReference, VerifiedImageBytes } from "./types";

export interface ImageCodec {
  verify(image: VerifiedImageBytes, signal?: AbortSignal): Promise<{ width: number; height: number }>;
  compress(
    image: VerifiedImageBytes,
    options: {
      maxSidePx: number;
      minSidePx: number;
      maxBytes: number;
      qualitySteps: readonly number[];
    },
    signal?: AbortSignal,
  ): Promise<VerifiedImageBytes | null>;
}

function abortable<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  return signal ? awaitAbortable(task, signal) : task;
}

function maxEncodedLength(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

const piImageCodec: ImageCodec = {
  async verify(image, signal) {
    const side = Math.max(image.width, image.height);
    const result = await abortable(
      resizeImage(image.bytes, image.mimeType, {
        maxWidth: side,
        maxHeight: side,
        maxBytes: maxEncodedLength(image.bytes.length) + 1,
        jpegQuality: MEDIA_REFERENCE_QUALITY_STEPS[0],
      }),
      signal,
    );
    if (!result) throw new Error("Image reference could not be decoded safely.");
    const decoded = decodeStrictBase64(
      result.data,
      maxEncodedLength(image.bytes.length) + 4,
      image.bytes.length,
    );
    if (!decoded.equals(image.bytes)) throw new Error("Image reference decode verification failed.");
    return { width: result.width, height: result.height };
  },
  async compress(image, options, signal) {
    for (const jpegQuality of options.qualitySteps) {
      const result = await abortable(
        resizeImage(image.bytes, image.mimeType, {
          maxWidth: options.maxSidePx,
          maxHeight: options.maxSidePx,
          maxBytes: maxEncodedLength(options.maxBytes) + 1,
          jpegQuality,
        }),
        signal,
      );
      if (!result) continue;
      const bytes = decodeStrictBase64(
        result.data,
        maxEncodedLength(options.maxBytes) + 4,
        options.maxBytes,
      );
      const inspected = inspectSupportedImageBytes(bytes, { maxPixels: MEDIA_MAX_SOURCE_PIXELS });
      if (Math.max(inspected.width, inspected.height) < options.minSidePx) continue;
      return { bytes, ...inspected, source: "compressed" };
    }
    return null;
  },
};

/** Return the production Pi worker-backed PNG/JPEG codec adapter. */
export function defaultImageCodec(): ImageCodec {
  return piImageCodec;
}

/** Decode-verify and source-backed compress references under per-item and aggregate budgets. */
export async function prepareImageReferences(
  images: readonly VerifiedImageBytes[],
  options: { codec?: ImageCodec; signal?: AbortSignal } = {},
): Promise<PreparedImageReference[]> {
  const codec = options.codec ?? defaultImageCodec();
  if (images.length < 1 || images.length > IMAGE_EDIT_MAX_REFERENCES) {
    throw new Error("Image reference count is outside the supported limit.");
  }
  const prepared: PreparedImageReference[] = [];
  let aggregateBytes = 0;

  for (const image of images) {
    if (options.signal?.aborted) throw cancellationError();
    const decodedDimensions = await codec.verify(image, options.signal);
    if (
      !Number.isSafeInteger(decodedDimensions.width)
      || !Number.isSafeInteger(decodedDimensions.height)
      || decodedDimensions.width <= 0
      || decodedDimensions.height <= 0
      || decodedDimensions.width > Math.floor(MEDIA_MAX_SOURCE_PIXELS / decodedDimensions.height)
    ) {
      throw new Error("Image reference exceeds the decoded-pixel limit.");
    }
    const verified = { ...image, ...decodedDimensions };
    let output = verified;
    let wasCompressed = false;

    if (verified.bytes.length > MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES) {
      const compressed = await codec.compress(
        verified,
        {
          maxSidePx: MEDIA_REFERENCE_COMPRESS_MAX_SIDE_PX,
          minSidePx: MEDIA_REFERENCE_COMPRESS_MIN_SIDE_PX,
          maxBytes: MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES,
          qualitySteps: MEDIA_REFERENCE_QUALITY_STEPS,
        },
        options.signal,
      );
      if (!compressed || compressed.bytes.length > MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES) {
        throw new Error("Image reference could not be compressed within the Imagine limit.");
      }
      const inspected = inspectSupportedImageBytes(compressed.bytes, {
        maxPixels: MEDIA_MAX_SOURCE_PIXELS,
      });
      if (inspected.mimeType !== compressed.mimeType) {
        throw new Error("Compressed image reference MIME does not match its bytes.");
      }
      compressed.width = inspected.width;
      compressed.height = inspected.height;
      if (Math.max(compressed.width, compressed.height) > MEDIA_REFERENCE_COMPRESS_MAX_SIDE_PX) {
        throw new Error("Compressed image reference exceeds the dimension limit.");
      }
      if (
        Math.max(verified.width, verified.height) > MEDIA_REFERENCE_COMPRESS_MIN_SIDE_PX
        && Math.max(compressed.width, compressed.height) < MEDIA_REFERENCE_COMPRESS_MIN_SIDE_PX
      ) {
        throw new Error("Image reference cannot fit without dropping below the compression floor.");
      }
      output = compressed;
      wasCompressed = true;
    }

    aggregateBytes += output.bytes.length;
    if (aggregateBytes > IMAGE_EDIT_MAX_AGGREGATE_REFERENCE_BYTES) {
      throw new Error("Image references exceed the aggregate byte limit.");
    }
    prepared.push({
      dataUrl: toImageDataUrl(output),
      mimeType: output.mimeType,
      byteLength: output.bytes.length,
      width: output.width,
      height: output.height,
      wasCompressed,
    });
  }
  return prepared;
}
