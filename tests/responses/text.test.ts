import { describe, expect, it } from "vitest";
import {
  extractResponsesText,
  extractStrictResponsesText,
  messageFromError,
  statusFromError,
  textFromResponsesContent,
} from "../../extensions/xai/text";

describe("responses text extraction", () => {
  it("prefers a non-empty output_text over output parts", () => {
    const data = { output_text: "flat", output: [{ content: [{ type: "output_text", text: "nested" }] }] };
    expect(extractStrictResponsesText(data)).toBe("flat");
    expect(extractResponsesText(data)).toBe("flat");
  });

  it("joins output_text parts and skips non-text content", () => {
    const data = {
      output_text: "",
      output: [
        { content: [{ type: "output_text", text: "one" }, { type: "refusal", text: "two" }] },
        { content: [{ type: "output_text", text: " three" }] },
        {},
        null,
      ],
    };
    expect(extractStrictResponsesText(data)).toBe("onetwo three");
    expect(extractResponsesText(data)).toBe("onetwo three");
  });

  it("ignores parts without string text", () => {
    const data = { output: [{ content: [{ type: "output_text" }, { type: "output_text", text: 12 }] }] };
    expect(extractStrictResponsesText(data)).toBe("");
    expect(extractResponsesText(data)).toBe(JSON.stringify(data));
  });

  it("returns empty strict text for non-object payloads", () => {
    for (const value of [undefined, null, "text", 7, [{ output_text: "x" }]]) {
      expect(extractStrictResponsesText(value)).toBe("");
    }
  });

  it("falls back to the serialized payload for display text", () => {
    expect(extractResponsesText({ status: "incomplete" })).toBe(JSON.stringify({ status: "incomplete" }));
    expect(extractResponsesText(undefined)).toBe(undefined as unknown as string);
    expect(extractResponsesText([])).toBe("[]");
  });
});

describe("responses content text", () => {
  it("returns strings unchanged and joins supported typed parts", () => {
    expect(textFromResponsesContent("plain")).toBe("plain");
    expect(textFromResponsesContent([
      "raw",
      { type: "text", text: "a" },
      { type: "input_text", text: "b" },
      { type: "output_text", text: "c" },
    ])).toBe("raw\na\nb\nc");
  });

  it("drops unsupported, empty, and malformed parts", () => {
    expect(textFromResponsesContent([
      { type: "image_url", text: "skip" },
      { type: "text", text: "" },
      { type: "text" },
      { text: "no type" },
      { type: 5, text: "bad type" },
      null,
      42,
    ])).toBe("");
  });

  it("returns empty text for non-array, non-string content", () => {
    expect(textFromResponsesContent(undefined)).toBe("");
    expect(textFromResponsesContent({ text: "x" })).toBe("");
  });
});

describe("error helpers", () => {
  it("reads numeric status values only", () => {
    expect(statusFromError(Object.assign(new Error("x"), { status: 429 }))).toBe(429);
    expect(statusFromError({ status: "429" })).toBeUndefined();
    expect(statusFromError(undefined)).toBeUndefined();
  });

  it("returns safe display messages", () => {
    expect(messageFromError(new Error("boom"))).toBe("boom");
    expect(messageFromError("boom")).toBe("Unknown error");
    expect(messageFromError({ message: "boom" })).toBe("Unknown error");
  });
});
