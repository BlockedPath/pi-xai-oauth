import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { compactXaiInlineImages } from "../../extensions/xai/images";
import { MissingFfmpegError, resizeImageFallback } from "../../extensions/xai/resize-image";

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

// This file checks the omp path. Hide Pi's resize export so the public helper
// uses the local fallback and the mocked ffmpeg ENOENT is real.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const host = { ...actual };
  delete host.resizeImage;
  return host;
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

  it("rethrows that ffmpeg error from inline image compaction", async () => {
    const url = `data:image/png;base64,${ONE_PIXEL_PNG.toString("base64")}`;
    await expect(compactXaiInlineImages({
      input: [{ content: [{ type: "input_image", image_url: url }] }],
    }, 8)).rejects.toThrow(MissingFfmpegError);
  });
});
