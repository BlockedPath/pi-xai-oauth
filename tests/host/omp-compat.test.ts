import { describe, expect, it } from "vitest";
import { copyModelCompat, resolveOpenAIResponsesStream, selectResizeImage } from "../../extensions/xai/host-compat";
import { jpegHeaderBytes } from "../fixtures/images";
import { resizeImage, resizeImageFallback } from "../../extensions/xai/resize-image";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("omp host compatibility", () => {
  it("keeps Pi's OpenAI Responses stream when the factory exists", () => {
    const piStream = () => undefined;
    const ompStream = () => undefined;
    const selected = resolveOpenAIResponsesStream({
      openAIResponsesApi: () => ({ streamSimple: piStream }),
      streamSimpleOpenAIResponses: ompStream,
    });
    expect(selected).toBe(piStream);
  });

  it("uses omp's stream export only when Pi's factory is absent", () => {
    const ompStream = () => undefined;
    const selected = resolveOpenAIResponsesStream({
      streamSimpleOpenAIResponses: ompStream,
    });
    expect(selected).toBe(ompStream);
  });

  it("copies an existing compat object and supplies one only when missing", () => {
    const compat = { supportsDeveloperRole: false };
    expect(copyModelCompat({ compat })).toEqual(compat);
    expect(copyModelCompat({ compat })).not.toBe(compat);
    expect(copyModelCompat({})).toEqual({});
    expect(copyModelCompat({ compat: null })).toEqual({});
  });

  it("keeps Pi's resizeImage when that export is a function", () => {
    const piResize = () => Promise.resolve(null);
    const fallback = () => Promise.resolve(null);
    expect(selectResizeImage(piResize, fallback)).toBe(piResize);
    expect(selectResizeImage(undefined, fallback)).toBe(fallback);
  });

  it("returns an in-limit image unchanged from the fallback resizer", async () => {
    const result = await resizeImageFallback(ONE_PIXEL_PNG, "image/png", {
      maxWidth: 2000,
      maxHeight: 2000,
    });
    expect(result).toMatchObject({
      mimeType: "image/png",
      originalWidth: 1,
      originalHeight: 1,
      width: 1,
      height: 1,
      wasResized: false,
    });
  });

  it("returns the MIME type from the image bytes, not the caller label", async () => {
    const jpeg = jpegHeaderBytes(2, 3);
    const labeled = await resizeImageFallback(jpeg, "image/png");
    const unlabeled = await resizeImageFallback(jpeg, "");
    expect(labeled).toMatchObject({
      mimeType: "image/jpeg",
      width: 2,
      height: 3,
      wasResized: false,
    });
    expect(unlabeled?.mimeType).toBe("image/jpeg");
  });

  it("uses Pi's resizeImage from the public helper on this host", async () => {
    const result = await resizeImage(ONE_PIXEL_PNG, "image/png");
    expect(result?.wasResized).toBe(false);
    expect(result?.width).toBe(1);
    expect(result?.height).toBe(1);
  });
});
