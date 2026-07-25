import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { toImageDataUrl } from "./media/data-url";
import { readBoundedWorkspaceImageFileSync } from "./media/paths";
import type { SupportedImageMimeType } from "./media/types";

/** Aggregate base64 budget kept below the xAI OAuth gateway's observed failure range. */
export const MAX_XAI_INLINE_IMAGE_BASE64_BYTES = 3 * 1024 * 1024;
export const MAX_XAI_IMAGE_DIMENSION = 2000;
export const XAI_JPEG_QUALITY = 95;

interface InlineImageReference {
  imagePart: Record<string, any>;
  mimeType: string;
  base64: string;
  encodedSize: number;
  targetSize: number;
}

function stripShellQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function unescapeShellPath(value: string): string {
  // Users often paste paths copied from a shell prompt, e.g. /tmp/My\ File.png.
  return stripShellQuotes(value).replace(/\\([\\\s'"()&;@])/g, "$1");
}

function imageMimeTypeForPath(path: string): SupportedImageMimeType {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    default:
      throw new Error("xAI image understanding supports local .jpg, .jpeg, and .png files only");
  }
}

function localImagePath(value: string): string {
  const cleaned = unescapeShellPath(value);
  if (!cleaned || cleaned.includes("\0")) {
    throw new Error("Local image path is invalid.");
  }

  if (cleaned.startsWith("file://")) {
    try {
      return fileURLToPath(cleaned);
    } catch {
      throw new Error("Local image file URL is invalid.");
    }
  }
  return cleaned;
}

/**
 * Normalize an image URL/path into an xAI-compatible URL or data URI.
 *
 * Local files must use a supported extension and resolve to a validated,
 * byte-bounded PNG or JPEG physically contained in the selected workspace.
 */
export function normalizeXaiImageInput(
  value: unknown,
  workspaceRoot = process.cwd(),
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const cleaned = stripShellQuotes(value);

  if (/^https?:\/\//i.test(cleaned) || /^data:image\//i.test(cleaned)) {
    return cleaned;
  }

  const path = localImagePath(cleaned);
  const expectedMimeType = imageMimeTypeForPath(path);
  const verified = readBoundedWorkspaceImageFileSync(path, workspaceRoot);
  if (verified.mimeType !== expectedMimeType) {
    throw new Error("Local image extension does not match its byte content.");
  }
  return toImageDataUrl(verified);
}

function parseInlineImageDataUrl(value: string): { mimeType: string; base64: string } | undefined {
  if (!/^data:image\//i.test(value)) return undefined;
  const match = /^data:(image\/(?:png|jpe?g));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(value);
  if (!match) {
    throw new Error("xAI inline image payload contains an invalid or unsupported image data URL");
  }
  return {
    mimeType: match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase(),
    base64: match[2].replace(/\s+/g, ""),
  };
}

function clonePayloadAndCollectInlineImages(value: unknown, references: InlineImageReference[]): unknown {
  if (Array.isArray(value)) return value.map((item) => clonePayloadAndCollectInlineImages(item, references));
  if (!value || typeof value !== "object") return value;

  const cloned: Record<string, any> = {};
  for (const [key, child] of Object.entries(value as Record<string, any>)) {
    cloned[key] = clonePayloadAndCollectInlineImages(child, references);
  }

  if (cloned.type === "input_image" && typeof cloned.image_url === "string") {
    const parsed = parseInlineImageDataUrl(cloned.image_url);
    if (parsed) {
      references.push({
        imagePart: cloned,
        mimeType: parsed.mimeType,
        base64: parsed.base64,
        encodedSize: Buffer.byteLength(parsed.base64, "utf8"),
        targetSize: 0,
      });
    }
  }

  return cloned;
}

function allocateInlineImageBudgets(references: InlineImageReference[], maxBase64Bytes: number) {
  const sorted = [...references].sort((left, right) => left.encodedSize - right.encodedSize);
  let remainingBytes = maxBase64Bytes;
  let remainingImages = sorted.length;

  for (let index = 0; index < sorted.length; index++) {
    const reference = sorted[index];
    const fairShare = Math.floor(remainingBytes / remainingImages);
    if (reference.encodedSize <= fairShare) {
      reference.targetSize = reference.encodedSize;
      remainingBytes -= reference.encodedSize;
      remainingImages--;
      continue;
    }

    for (let remainingIndex = index; remainingIndex < sorted.length; remainingIndex++) {
      sorted[remainingIndex].targetSize = Math.floor(remainingBytes / remainingImages);
    }
    return;
  }
}

/**
 * Compact inline PNG/JPEG inputs to a safe aggregate xAI transport budget.
 *
 * Small images keep their original allocation while oversized images share the
 * remaining budget. Processing is sequential to cap peak decoded-image memory.
 * A codec failure is surfaced locally so a known-risk oversized request is not sent.
 */
export async function compactXaiInlineImages(
  payload: unknown,
  maxBase64Bytes = MAX_XAI_INLINE_IMAGE_BASE64_BYTES,
): Promise<unknown> {
  if (!Number.isFinite(maxBase64Bytes) || maxBase64Bytes <= 0) {
    throw new Error("xAI inline image transport budget must be a positive number");
  }

  const references: InlineImageReference[] = [];
  const clonedPayload = clonePayloadAndCollectInlineImages(payload, references);
  if (references.length === 0) return clonedPayload;

  allocateInlineImageBudgets(references, Math.floor(maxBase64Bytes));
  for (const reference of references) {
    const bytes = Buffer.from(reference.base64, "base64");
    if (bytes.length === 0 || reference.targetSize < 1) {
      throw new Error("xAI inline image payload exceeds the safe transport budget and could not be compacted");
    }

    let resized;
    let compressionError: unknown;
    try {
      resized = await resizeImage(bytes, reference.mimeType, {
        maxWidth: MAX_XAI_IMAGE_DIMENSION,
        maxHeight: MAX_XAI_IMAGE_DIMENSION,
        maxBytes: reference.targetSize + 1,
        jpegQuality: XAI_JPEG_QUALITY,
      });
    } catch (error) {
      compressionError = error;
      resized = null;
    }
    if (!resized || Buffer.byteLength(resized.data, "utf8") > reference.targetSize) {
      throw new Error(
        "xAI inline image payload exceeds the safe transport budget and could not be compacted",
        compressionError === undefined ? undefined : { cause: compressionError },
      );
    }
    reference.imagePart.image_url = `data:${resized.mimeType};base64,${resized.data}`;
  }

  return clonedPayload;
}
