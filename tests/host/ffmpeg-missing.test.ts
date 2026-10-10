import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { compactXaiInlineImages } from "../../extensions/xai/images";
import { MissingFfmpegError, resizeImageFallback } from "../../extensions/xai/resize-image";

const ffmpeg = vi.hoisted(() => ({ missing: false }));

vi.mock("node:child_process", () => ({
  spawn() {
    const stdout = new EventEmitter();
    const stdin = new EventEmitter() as EventEmitter & { end: () => void };
    stdin.end = () => undefined;
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stdin: EventEmitter & { end: () => void };
      kill: () => void;
    };
    child.stdout = stdout;
    child.stdin = stdin;
    child.kill = () => undefined;
    const error = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    queueMicrotask(() => child.emit("error", error));
    return child;
  },
}));

interface ResizeImageModule {
  MissingFfmpegError: new () => Error;
  resizeImage: (
    inputBytes: Uint8Array,
    mimeType: string,
    options?: object,
  ) => Promise<unknown>;
}

vi.mock("../../extensions/xai/resize-image", async (importOriginal) => {
  const actual = await importOriginal<ResizeImageModule>();
  return {
    ...actual,
    resizeImage: (
      inputBytes: Uint8Array,
      mimeType: string,
      options?: object,
    ) => {
      if (ffmpeg.missing) return Promise.reject(new actual.MissingFfmpegError());
      return actual.resizeImage(inputBytes, mimeType, options);
    },
  };
});

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("missing ffmpeg", () => {
  it("names ffmpeg when the omp resize fallback cannot start it", async () => {
    await expect(resizeImageFallback(ONE_PIXEL_PNG, "image/png", {
      maxWidth: 1,
      maxHeight: 1,
      maxBytes: 1,
    })).rejects.toThrow(MissingFfmpegError);
  });

  it("shows the missing ffmpeg error instead of a generic compaction failure", async () => {
    ffmpeg.missing = true;
    const url = `data:image/png;base64,${ONE_PIXEL_PNG.toString("base64")}`;
    await expect(compactXaiInlineImages({
      input: [{ content: [{ type: "input_image", image_url: url }] }],
    }, 1_000_000)).rejects.toThrow(/Install ffmpeg/);
  });
});
