import { spawn } from "node:child_process";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { selectResizeImage } from "./host-compat";
import { inspectSupportedImageBytes } from "./media/image-info";

/** Pi 1.1 image resize options. */
export interface ImageResizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;
  jpegQuality?: number;
}

/** Pi 1.1 resized image. `data` is base64. */
export interface ResizedImage {
  data: string;
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
}

type ResizeImageFn = (
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
) => Promise<ResizedImage | null>;

const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;
const ENCODE_TIMEOUT_MS = 20_000;

/** The omp resize fallback needs ffmpeg. Pi hosts do not use this path. */
export class MissingFfmpegError extends Error {
  constructor() {
    super("Image resize needs ffmpeg. Install ffmpeg and try again.");
    this.name = "MissingFfmpegError";
  }
}

function readSize(
  bytes: Buffer,
): { width: number; height: number; mimeType: "image/png" | "image/jpeg" } | undefined {
  try {
    const inspected = inspectSupportedImageBytes(bytes, {
      maxPixels: Number.MAX_SAFE_INTEGER,
    });
    return {
      width: inspected.width,
      height: inspected.height,
      mimeType: inspected.mimeType,
    };
  } catch {
    return undefined;
  }
}

function base64Size(bytes: Uint8Array): number {
  return Math.ceil(bytes.byteLength / 3) * 4;
}

function jpegQscale(quality: number): number {
  const clamped = Math.max(1, Math.min(100, quality));
  return Math.max(2, Math.min(31, Math.round(31 - (clamped / 100) * 29)));
}

function deferredBuffer(): {
  promise: Promise<Buffer>;
  resolve: (value: Buffer) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: Buffer) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<Buffer>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function runFfmpeg(args: string[], input: Buffer): Promise<Buffer> {
  const { promise, resolve, reject } = deferredBuffer();
  const child = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  let settled = false;
  const finish = (error: Error | undefined, output?: Buffer) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(output ?? Buffer.alloc(0));
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(new Error("ffmpeg timed out"));
  }, ENCODE_TIMEOUT_MS);
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.on("error", (error) => finish(error));
  child.on("close", (code) => {
    if (code === 0) finish(undefined, Buffer.concat(chunks));
    else finish(new Error(`ffmpeg exited ${code}`));
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(input);
  return promise;
}

async function encode(
  input: Buffer,
  width: number,
  height: number,
  format: "png" | "jpeg",
  jpegQuality: number,
): Promise<Buffer | undefined> {
  const scale = `scale=${width}:${height}:flags=lanczos`;
  const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", scale, "-frames:v", "1"];
  if (format === "png") args.push("-f", "image2pipe", "-c:v", "png", "pipe:1");
  else args.push("-q:v", String(jpegQscale(jpegQuality)), "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1");
  try {
    const output = await runFfmpeg(args, input);
    return output.length > 0 ? output : undefined;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new MissingFfmpegError();
    }
    return undefined;
  }
}

/**
 * Resize PNG or JPEG bytes when the host has no Pi `resizeImage` export.
 *
 * Images already inside the limits are returned unchanged. Pi hosts do not use
 * this function.
 */
export async function resizeImageFallback(
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
  const bytes = Buffer.from(inputBytes);
  const size = readSize(bytes);
  if (!size) return null;

  const opts = {
    maxWidth: options?.maxWidth ?? 2000,
    maxHeight: options?.maxHeight ?? 2000,
    maxBytes: options?.maxBytes ?? DEFAULT_MAX_BYTES,
    jpegQuality: options?.jpegQuality ?? 80,
  };
  if (size.width <= opts.maxWidth && size.height <= opts.maxHeight && base64Size(bytes) < opts.maxBytes) {
    return {
      data: bytes.toString("base64"),
      mimeType: size.mimeType,
      originalWidth: size.width,
      originalHeight: size.height,
      width: size.width,
      height: size.height,
      wasResized: false,
    };
  }

  let width = size.width;
  let height = size.height;
  if (width > opts.maxWidth) {
    height = Math.max(1, Math.round((height * opts.maxWidth) / width));
    width = opts.maxWidth;
  }
  if (height > opts.maxHeight) {
    width = Math.max(1, Math.round((width * opts.maxHeight) / height));
    height = opts.maxHeight;
  }

  const qualities = [opts.jpegQuality, 85, 70, 55, 40];
  while (true) {
    const png = await encode(bytes, width, height, "png", opts.jpegQuality);
    const candidates: Array<{ bytes: Buffer; mimeType: string }> = [];
    if (png) candidates.push({ bytes: png, mimeType: "image/png" });
    for (const quality of qualities) {
      const jpeg = await encode(bytes, width, height, "jpeg", quality);
      if (jpeg) candidates.push({ bytes: jpeg, mimeType: "image/jpeg" });
    }
    for (const candidate of candidates) {
      if (base64Size(candidate.bytes) >= opts.maxBytes) continue;
      const encodedSize = readSize(candidate.bytes);
      if (!encodedSize) continue;
      return {
        data: candidate.bytes.toString("base64"),
        mimeType: candidate.mimeType,
        originalWidth: size.width,
        originalHeight: size.height,
        width: encodedSize.width,
        height: encodedSize.height,
        wasResized: true,
      };
    }
    if (width === 1 && height === 1) return null;
    const nextWidth = width === 1 ? 1 : Math.max(1, Math.floor(width * 0.75));
    const nextHeight = height === 1 ? 1 : Math.max(1, Math.floor(height * 0.75));
    if (nextWidth === width && nextHeight === height) return null;
    width = nextWidth;
    height = nextHeight;
  }
}

function readPiResizeImage(moduleValue: object): unknown {
  if (!("resizeImage" in moduleValue)) return undefined;
  return moduleValue.resizeImage;
}

// A named `resizeImage` import fails to load on omp 18.8.7 because that export
// is absent. The namespace import still loads. Pi hosts keep Pi's function.
function installedResizeImage(): ResizeImageFn {
  const exported = readPiResizeImage(piCodingAgent);
  if (typeof exported !== "function") return resizeImageFallback;
  return selectResizeImage(exported, resizeImageFallback);
}

/**
 * Resize one image with Pi's `resizeImage` when that export exists.
 *
 * omp 18.8.7 does not export it. The local fallback then resizes PNG and JPEG
 * bytes. Pi hosts keep the Pi implementation.
 */
export async function resizeImage(
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
  return installedResizeImage()(inputBytes, mimeType, options);
}
