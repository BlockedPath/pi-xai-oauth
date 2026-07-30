import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import {
  compactXaiInlineImages,
  MAX_XAI_INLINE_IMAGE_INPUT_AGGREGATE_BASE64_CHARS,
  MAX_XAI_INLINE_IMAGE_INPUT_BASE64_CHARS,
  MAX_XAI_INLINE_IMAGE_INPUT_COUNT,
  MAX_XAI_INLINE_IMAGE_PAYLOAD_MAX_DEPTH,
} from "../../extensions/xai/images";

function urls(value: any) {
  const result: string[] = [];
  const walk = (item: any) => {
    if (Array.isArray(item)) return item.forEach(walk);
    if (!item || typeof item !== "object") return;
    if (
      item.type === "input_image" &&
      String(item.image_url).startsWith("data:image/")
    )
      result.push(item.image_url);
    Object.values(item).forEach(walk);
  };
  walk(value);
  return result;
}

function tinyPngDataUrl(paddingChars = 0): string {
  // Minimal valid-looking PNG data URL; decode/compaction is not reached for input-bound tests.
  const base64 = `AAAA${"A".repeat(paddingChars)}`;
  return `data:image/png;base64,${base64}`;
}

describe("inline image compaction", () => {
  it("keeps under-budget images byte-identical", async () => {
    const base64 = (await readFile("preview.jpeg")).toString("base64");
    const url = `data:image/jpeg;base64,${base64}`;
    const payload = {
      input: [
        {
          content: [
            { type: "input_image", image_url: url },
            { type: "input_image", image_url: url },
          ],
        },
      ],
    };
    expect(
      urls(await compactXaiInlineImages(payload, base64.length * 2 + 1)),
    ).toEqual([url, url]);
  });
  it("obeys aggregate byte and dimension bounds", async () => {
    const base64 = (await readFile("preview.jpeg")).toString("base64");
    const url = `data:image/jpeg;base64,${base64}`;
    const budget = Math.floor(base64.length * 1.5);
    const result = await compactXaiInlineImages(
      {
        input: [
          {
            content: [
              { type: "input_image", image_url: url },
              { type: "input_image", image_url: url },
            ],
          },
        ],
      },
      budget,
    );
    const compacted = urls(result);
    expect(compacted).toHaveLength(2);
    expect(
      compacted.reduce(
        (sum, value) => sum + Buffer.byteLength(value.split(",")[1]),
        0,
      ),
    ).toBeLessThanOrEqual(budget);
    for (const value of compacted) {
      expect(value).toMatch(/^data:image\/(?:png|jpeg);base64,/);
      const [metadata, data] = value.split(",", 2);
      const inspected = await resizeImage(
        Buffer.from(data, "base64"),
        metadata.slice(5).split(";")[0],
        {
          maxWidth: 2000,
          maxHeight: 2000,
          maxBytes: data.length + 1,
          jpegQuality: 95,
        },
      );
      expect(inspected?.width).toBeLessThanOrEqual(2000);
      expect(inspected?.height).toBeLessThanOrEqual(2000);
    }
  });
  it("fails locally for undecodable oversized images and invalid budgets", async () => {
    await expect(
      compactXaiInlineImages(
        {
          input: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,bm90LWFuLWltYWdl",
            },
          ],
        },
        2,
      ),
    ).rejects.toThrow(/safe transport budget/);
    await expect(compactXaiInlineImages({}, 0)).rejects.toThrow(
      /positive number/,
    );
  });
});

describe("inline image input-side bounds", () => {
  it("rejects a single oversized data URL before decode", async () => {
    const oversized = `data:image/png;base64,${"A".repeat(MAX_XAI_INLINE_IMAGE_INPUT_BASE64_CHARS + 1)}`;
    const payload = {
      input: [{ type: "input_image", image_url: oversized }],
    };

    await expect(compactXaiInlineImages(payload)).rejects.toThrow(
      /safe input size limit/,
    );
    await expect(compactXaiInlineImages(payload)).rejects.not.toThrow(
      /transport budget/,
    );
  });

  it("rejects many small images that exceed the aggregate encoded input budget", async () => {
    const perImageChars = Math.floor(MAX_XAI_INLINE_IMAGE_INPUT_AGGREGATE_BASE64_CHARS / 8);
    expect(perImageChars).toBeLessThanOrEqual(MAX_XAI_INLINE_IMAGE_INPUT_BASE64_CHARS);
    const imageCount = 9; // 9/8 of aggregate → exceeds while staying under the image-count cap
    expect(imageCount).toBeLessThanOrEqual(MAX_XAI_INLINE_IMAGE_INPUT_COUNT);
    expect(perImageChars * imageCount).toBeGreaterThan(
      MAX_XAI_INLINE_IMAGE_INPUT_AGGREGATE_BASE64_CHARS,
    );

    const url = tinyPngDataUrl(perImageChars - 4);
    const payload = {
      input: Array.from({ length: imageCount }, () => ({
        type: "input_image",
        image_url: url,
      })),
    };

    await expect(compactXaiInlineImages(payload)).rejects.toThrow(
      /safe input size limit/,
    );
  });

  it("rejects excessive nesting depth before clone amplification completes", async () => {
    let nested: Record<string, unknown> = {
      type: "input_image",
      image_url: tinyPngDataUrl(),
    };
    for (let depth = 0; depth < MAX_XAI_INLINE_IMAGE_PAYLOAD_MAX_DEPTH + 4; depth++) {
      nested = { child: nested };
    }

    await expect(compactXaiInlineImages(nested)).rejects.toThrow(
      /safe structure budget/,
    );
  });

  it("rejects more inline images than the input count cap", async () => {
    const url = tinyPngDataUrl();
    const payload = {
      input: Array.from({ length: MAX_XAI_INLINE_IMAGE_INPUT_COUNT + 1 }, () => ({
        type: "input_image",
        image_url: url,
      })),
    };

    await expect(compactXaiInlineImages(payload)).rejects.toThrow(
      /too many inline images/,
    );
  });
});
