import { lstat, mkdir, readFile, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultImageCodec,
  prepareImageReferences,
  type ImageCodec,
} from "../../extensions/xai/media/compression";
import {
  IMAGE_EDIT_MAX_AGGREGATE_REFERENCE_BYTES,
  MEDIA_REFERENCE_COMPRESS_MAX_SIDE_PX,
  MEDIA_REFERENCE_COMPRESS_MIN_SIDE_PX,
  MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES,
  MEDIA_REFERENCE_QUALITY_STEPS,
} from "../../extensions/xai/media/constants";
import { imageEditOutputRoot, saveVerifiedOutputImage } from "../../extensions/xai/media/output-storage";
import type { VerifiedImageBytes } from "../../extensions/xai/media/types";
import { createTempDir } from "../fixtures/temp";
import { noisePngBytes, pngHeaderBytes, tinyPngBytes } from "../fixtures/images";

function image(bytes = tinyPngBytes(), width = 1, height = 1): VerifiedImageBytes {
  return { bytes, mimeType: "image/png", width, height, source: "data-url" };
}

function fakeCodec(compressed = image(pngHeaderBytes(512, 512), 512, 512)): ImageCodec {
  return {
    verify: vi.fn(async (input) => ({ width: input.width, height: input.height })),
    compress: vi.fn(async () => compressed),
  };
}

function abortSignalOnRead(readNumber: number): AbortSignal {
  let reads = 0;
  return {
    get aborted() {
      reads += 1;
      return reads >= readNumber;
    },
  } as AbortSignal;
}

describe("bounded reference compression", () => {
  it("decode-verifies but preserves sub-400 KiB PNG bytes", async () => {
    const codec = fakeCodec();
    const source = image();
    const [prepared] = await prepareImageReferences([source], { codec });
    expect(codec.verify).toHaveBeenCalledOnce();
    expect(codec.compress).not.toHaveBeenCalled();
    expect(Buffer.from(prepared.dataUrl.split(",")[1], "base64")).toEqual(source.bytes);
    expect(prepared.wasCompressed).toBe(false);
  });

  it("uses the source-backed 400 KiB, 768px, 256px, and quality-step policy", async () => {
    const sourceBytes = Buffer.concat([
      pngHeaderBytes(1200, 900),
      Buffer.alloc(MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES),
    ]);
    const codec = fakeCodec();
    const [prepared] = await prepareImageReferences([image(sourceBytes, 1200, 900)], { codec });
    expect(codec.compress).toHaveBeenCalledWith(
      expect.anything(),
      {
        maxSidePx: MEDIA_REFERENCE_COMPRESS_MAX_SIDE_PX,
        minSidePx: MEDIA_REFERENCE_COMPRESS_MIN_SIDE_PX,
        maxBytes: MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES,
        qualitySteps: MEDIA_REFERENCE_QUALITY_STEPS,
      },
      undefined,
    );
    expect(prepared).toMatchObject({ wasCompressed: true, width: 512, height: 512 });
  });

  it("rejects count overflow, codec MIME spoofing, oversized output, dimension overflow, and floor collapse", async () => {
    const small = image();
    await expect(prepareImageReferences([small, small, small, small, small], { codec: fakeCodec() })).rejects.toThrow(/count/);

    const large = image(Buffer.concat([pngHeaderBytes(900, 900), Buffer.alloc(MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES)]), 900, 900);
    await expect(prepareImageReferences([large], {
      codec: fakeCodec({ ...image(pngHeaderBytes(512, 512), 512, 512), mimeType: "image/jpeg", source: "compressed" }),
    })).rejects.toThrow(/MIME/);
    await expect(prepareImageReferences([large], {
      codec: fakeCodec(image(Buffer.concat([pngHeaderBytes(512, 512), Buffer.alloc(MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES)]), 512, 512)),
    })).rejects.toThrow(/Imagine limit/);
    await expect(prepareImageReferences([large], { codec: fakeCodec(image(pngHeaderBytes(769, 500), 769, 500)) })).rejects.toThrow(/dimension/);
    await expect(prepareImageReferences([large], { codec: fakeCodec(image(pngHeaderBytes(200, 200), 200, 200)) })).rejects.toThrow(/floor/);
  });

  it("accepts exactly the package-owned aggregate boundary for three references", async () => {
    const header = pngHeaderBytes(10, 10);
    const bytes = Buffer.concat([
      header,
      Buffer.alloc(MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES - header.length),
    ]);
    expect(bytes.length * 3).toBe(IMAGE_EDIT_MAX_AGGREGATE_REFERENCE_BYTES);
    const source = image(bytes, 10, 10);
    await expect(prepareImageReferences(
      [source, source, source],
      { codec: fakeCodec() },
    )).resolves.toHaveLength(3);
  });

  it("decode-verifies a real JPEG without changing under-budget bytes", async () => {
    const bytes = await readFile("preview.jpeg");
    const [prepared] = await prepareImageReferences([{
      bytes,
      mimeType: "image/jpeg",
      width: 1672,
      height: 941,
      source: "workspace-path",
    }], { codec: defaultImageCodec() });
    expect(prepared).toMatchObject({
      mimeType: "image/jpeg",
      width: 1672,
      height: 941,
      wasCompressed: false,
    });
    expect(Buffer.from(prepared.dataUrl.split(",")[1], "base64")).toEqual(bytes);
  });

  it("compresses a real high-entropy PNG through Pi's worker codec", async () => {
    const bytes = noisePngBytes(900, 900);
    expect(bytes.length).toBeGreaterThan(MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES);
    const [prepared] = await prepareImageReferences([image(bytes, 900, 900)], {
      codec: defaultImageCodec(),
    });
    expect(prepared.wasCompressed).toBe(true);
    expect(prepared.byteLength).toBeLessThanOrEqual(MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES);
    expect(Math.max(prepared.width, prepared.height)).toBeLessThanOrEqual(768);
    expect(Math.max(prepared.width, prepared.height)).toBeGreaterThanOrEqual(256);
  }, 30_000);
});

describe("atomic session image storage", () => {
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  let sessionRoot: string;
  const manager = () => ({ getSessionDir: () => sessionRoot, getSessionId: () => "session-secret-id" });

  beforeEach(async () => {
    temp = await createTempDir("pi-xai-media-output-");
    sessionRoot = join(temp.path, "sessions");
    await mkdir(sessionRoot);
  });
  afterEach(async () => temp.cleanup());

  it("derives a hashed session path and saves collision-free 0700/0600 files atomically", async () => {
    const outputRoot = imageEditOutputRoot(manager());
    expect(outputRoot).not.toContain("session-secret-id");
    const first = await saveVerifiedOutputImage(image(), { outputRoot, sessionRoot });
    const second = await saveVerifiedOutputImage(image(), { outputRoot, sessionRoot });
    expect(first.path).not.toBe(second.path);
    expect(first.path).toMatch(/\.png$/);
    expect((await lstat(outputRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(first.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(outputRoot)).toHaveLength(2);
    expect((await readdir(outputRoot)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("rejects preexisting output symlinks that escape session storage", async () => {
    const outputRoot = imageEditOutputRoot(manager());
    const outside = join(temp.path, "outside");
    await mkdir(outside);
    await mkdir(join(outputRoot, ".."), { recursive: true });
    await symlink(outside, outputRoot);
    await expect(saveVerifiedOutputImage(image(), { outputRoot, sessionRoot })).rejects.toThrow(/unsafe|outside/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects an intermediate output symlink before mutating its target", async () => {
    const outputRoot = imageEditOutputRoot(manager());
    const outside = join(temp.path, "outside-intermediate");
    await mkdir(outside);
    await symlink(outside, join(sessionRoot, "pi-xai-oauth"));
    await expect(saveVerifiedOutputImage(image(), { outputRoot, sessionRoot })).rejects.toThrow(/unsafe|outside/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("fails before creating output on pre-cancellation", async () => {
    const outputRoot = imageEditOutputRoot(manager());
    const controller = new AbortController();
    controller.abort();
    await expect(saveVerifiedOutputImage(image(), { outputRoot, sessionRoot, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(lstat(outputRoot)).rejects.toThrow();
  });

  it("does not create a file when cancellation lands during directory setup", async () => {
    const outputRoot = imageEditOutputRoot(manager());
    await expect(saveVerifiedOutputImage(image(), {
      outputRoot,
      sessionRoot,
      signal: abortSignalOnRead(2),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(outputRoot)).toEqual([]);
  });

  it.each([
    ["temporary write", 3],
    ["final rename", 4],
  ])("removes all output when cancellation follows %s", async (_stage, abortRead) => {
    const outputRoot = imageEditOutputRoot(manager());
    await expect(saveVerifiedOutputImage(image(), {
      outputRoot,
      sessionRoot,
      signal: abortSignalOnRead(abortRead),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(outputRoot)).toEqual([]);
  });
});
