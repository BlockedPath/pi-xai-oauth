import { describe, expect, it } from "vitest";
import {
  applyXaiOAuthResponsesPolicy,
  normalizeXaiResponsesImageParts,
  omitConsumedXaiResponsesVisionImages,
  rewriteXaiResponsesPayload,
  xaiResponsesPayloadContainsLocalImageReference,
} from "../../extensions/xai/payload";
import { TEST_MODEL } from "../fixtures/models";

describe("Responses payload refactor characterization", () => {
  it("normalizes nested image objects without mutating caller-owned values", () => {
    const source = {
      content: [{
        type: "image_url",
        image_url: {
          url: "https://example.test/image.png",
          detail: "high",
        },
        retained: null,
      }],
      output: [{
        type: "image",
        data: "YWJj",
        mimeType: "image/png",
        detail: "",
      }],
    };

    expect(normalizeXaiResponsesImageParts(source)).toEqual({
      content: [{
        type: "input_image",
        image_url: "https://example.test/image.png",
        detail: "high",
        retained: null,
      }],
      output: [{
        type: "input_image",
        image_url: "data:image/png;base64,YWJj",
        detail: "auto",
      }],
    });
    expect(source.content[0].type).toBe("image_url");
    expect(source.output[0].type).toBe("image");
  });

  it("detects quoted local image references only within Responses input", () => {
    expect(xaiResponsesPayloadContainsLocalImageReference({
      input: [{
        role: "user",
        content: [{ type: "input_image", image_url: "  './private image.png'  " }],
      }],
    })).toBe(true);
    expect(xaiResponsesPayloadContainsLocalImageReference({
      input: [
        { type: "input_image", image_url: "https://example.test/image.png" },
        { type: "input_image", image_url: "data:image/png;base64,YWJj" },
      ],
      metadata: { type: "input_image", image_url: "./not-request-input.png" },
    })).toBe(false);
  });

  it("preserves identity when consumed-vision omission has no work", () => {
    const payload = {
      input: [
        { role: "user", content: [{ type: "input_image", image_url: "https://example.test/current.png" }] },
        { type: "function_call_output", call_id: "current", output: null },
      ],
    };

    expect(omitConsumedXaiResponsesVisionImages(payload)).toBe(payload);
  });

  it("preserves nulls while defaulting only omitted OAuth policy fields", () => {
    const explicitNulls = {
      input: "hello",
      store: null,
      include: null,
    };
    expect(applyXaiOAuthResponsesPolicy(explicitNulls)).toEqual({
      input: "hello",
      store: null,
      include: ["reasoning.encrypted_content"],
    });

    const rewritten = rewriteXaiResponsesPayload({
      input: "hello",
      response_format: null,
      text: null,
      reasoning: null,
      prompt_cache_key: null,
      metadata: null,
    }, TEST_MODEL) as Record<string, unknown>;
    expect(rewritten).toEqual({
      input: "hello",
      response_format: null,
      text: null,
      reasoning: null,
      metadata: null,
    });
    expect(rewritten).not.toHaveProperty("prompt_cache_key");
  });
});
