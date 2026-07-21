import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  XAI_GROK_NATIVE_TOOL_NAME_MAP,
  XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME,
  XAI_GROK_NATIVE_WEB_SEARCH_NAME,
} from "../../extensions/xai/constants";
import {
  HISTORICAL_USER_IMAGE_PLACEHOLDER,
  applyXaiOAuthResponsesPolicy,
  canonicalizeXaiResponsesPayload,
  exposeGrokNativeToolNames,
  internalizeGrokNativeToolCalls,
  rewriteXaiResponsesPayload,
  xaiPayloadGrokNativeToolRoutes,
  XAI_PAYLOAD_CANONICALIZATION_ERROR,
  xaiResponsesPayloadContainsImage,
} from "../../extensions/xai/payload";
import {
  CURATED_FALLBACK_MODELS,
  KNOWN_XAI_MODEL_METADATA,
  setXaiRuntimeModels,
} from "../../extensions/xai/models";
import { tinyPngBytes } from "../fixtures/images";
import { TEST_MODEL } from "../fixtures/models";

afterEach(() => setXaiRuntimeModels(CURATED_FALLBACK_MODELS));
const tiny = `data:image/png;base64,${Buffer.from("tiny").toString("base64")}`;
const toolImage = (callId = "call") => ({
  type: "function_call_output",
  call_id: callId,
  output: [
    { type: "input_text", text: "result" },
    { type: "input_image", image_url: tiny, detail: "auto" },
  ],
});
const inlineImages = (value: any): string[] => {
  const urls: string[] = [];
  const walk = (item: any) => {
    if (Array.isArray(item)) return item.forEach(walk);
    if (!item || typeof item !== "object") return;
    if (
      item.type === "input_image" &&
      String(item.image_url).startsWith("data:image/")
    )
      urls.push(item.image_url);
    Object.values(item).forEach(walk);
  };
  walk(value);
  return urls;
};
const piToolCall = (index: number) => ({
  type: "toolCall",
  id: `tool_${index}|fc_${index}`,
  name: "read_file",
  arguments: { path: `app-${index}.ts` },
});
const piReasoning = {
  type: "thinking",
  thinking: "",
  thinkingSignature: JSON.stringify({
    id: "rs_1",
    type: "reasoning",
    summary: [],
    encrypted_content: "opaque-reasoning",
    status: "completed",
  }),
};
const piAssistantMessage = (content: any[], stopReason: "stop" | "toolUse", timestamp: number) => ({
  role: "assistant",
  content,
  api: TEST_MODEL.api,
  provider: TEST_MODEL.provider,
  model: TEST_MODEL.id,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp,
});
const convertVisionHistory = (assistantContent: any[], terminalAfterTools = false) => {
  const toolCalls = assistantContent.filter((item) => item.type === "toolCall");
  const messages: any[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "fix this screenshot" },
        { type: "image", data: Buffer.from("tiny").toString("base64"), mimeType: "image/png" },
      ],
      timestamp: 1,
    },
    piAssistantMessage(assistantContent, toolCalls.length > 0 ? "toolUse" : "stop", 2),
  ];
  if (toolCalls.length > 0) {
    messages.push(...toolCalls.map((toolCall, index) => ({
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: `file contents ${index + 1}` }],
      isError: false,
      timestamp: index + 3,
    })));
    if (terminalAfterTools) {
      messages.push(
        piAssistantMessage([{ type: "text", text: "The screenshot shows an error." }], "stop", toolCalls.length + 3),
        { role: "user", content: "next question", timestamp: toolCalls.length + 4 },
      );
    }
  } else {
    messages.push({ role: "user", content: "next question", timestamp: 3 });
  }
  return convertResponsesMessages(
    TEST_MODEL,
    { messages } as any,
    new Set([TEST_MODEL.provider]),
  );
};

describe("Responses payload normalization", () => {
  it("exposes and internalizes the collision-free Grok web-search dispatch name", () => {
    const payload = {
      tools: [{ type: "function", name: XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME }],
      input: [{
        type: "function_call",
        name: XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME,
        call_id: "call",
        arguments: "{}",
      }],
      tool_choice: { type: "function", name: XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME },
    };
    const exposed = exposeGrokNativeToolNames(payload) as any;
    expect(exposed.tools[0].name).toBe(XAI_GROK_NATIVE_WEB_SEARCH_NAME);
    expect(exposed.input[0].name).toBe(XAI_GROK_NATIVE_WEB_SEARCH_NAME);
    expect(exposed.tool_choice.name).toBe(XAI_GROK_NATIVE_WEB_SEARCH_NAME);
    expect(payload.tools[0].name).toBe(XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME);
    const routes = {
      [XAI_GROK_NATIVE_WEB_SEARCH_NAME]: XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME,
    };

    expect(internalizeGrokNativeToolCalls({
      type: "toolCall",
      id: "call",
      name: XAI_GROK_NATIVE_WEB_SEARCH_NAME,
      arguments: {},
    }, routes)).toMatchObject({ name: XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME });
    expect(internalizeGrokNativeToolCalls({
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call",
        name: XAI_GROK_NATIVE_WEB_SEARCH_NAME,
        arguments: {},
      }],
    }, routes)).toMatchObject({
      content: [{ name: XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME }],
    });

    const foreignCall = {
      type: "toolCall",
      id: "foreign",
      name: XAI_GROK_NATIVE_WEB_SEARCH_NAME,
      arguments: {},
    };
    expect(internalizeGrokNativeToolCalls(foreignCall)).toBe(foreignCall);

    const collision = exposeGrokNativeToolNames({
      tools: [
        { type: "function", name: XAI_GROK_NATIVE_WEB_SEARCH_NAME, description: "foreign" },
        { type: "function", name: XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME, description: "xAI" },
        { type: "function", name: XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME, description: "duplicate" },
      ],
    }) as any;
    expect(collision.tools).toEqual([
      { type: "function", name: XAI_GROK_NATIVE_WEB_SEARCH_NAME, description: "xAI" },
    ]);

    const generic = exposeGrokNativeToolNames({
      tools: [{ type: "function", name: "xai_grok_read_file" }],
    }) as any;
    expect(generic.tools[0].name).toBe(XAI_GROK_NATIVE_TOOL_NAME_MAP.xai_grok_read_file);

    const historyOnly = {
      tools: [{ type: "function", name: "read_file", description: "foreign" }],
      input: [{ type: "function_call", name: "xai_grok_read_file" }],
    };
    expect(xaiPayloadGrokNativeToolRoutes(historyOnly)).toEqual({});
    expect(internalizeGrokNativeToolCalls({
      type: "toolCall",
      name: "read_file",
    }, xaiPayloadGrokNativeToolRoutes(historyOnly))).toMatchObject({ name: "read_file" });
  });
  it.each([
    { type: "reasoning", summary: [] },
    { type: "function_call", call_id: "next", name: "read", arguments: "{}" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    },
  ])("omits consumed tool images after $type", (assistant) => {
    const result = rewriteXaiResponsesPayload(
      {
        model: TEST_MODEL.id,
        input: [toolImage(), assistant, { role: "user", content: "next" }],
      },
      TEST_MODEL,
    );
    expect(inlineImages(result)).toHaveLength(0);
    expect(JSON.stringify(result)).toMatch(/historical tool image.*omitted/);
  });
  it("omits consumed image-only user images only when explicitly requested", () => {
    const content = [{ type: "input_image", image_url: tiny, detail: "auto" }];
    const payload = {
      model: TEST_MODEL.id,
      input: [
        { role: "user", content },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        { role: "user", content: "next" },
      ],
    };
    const routed = rewriteXaiResponsesPayload(payload, TEST_MODEL, { omitConsumedVisionImages: true });
    expect(inlineImages(routed)).toHaveLength(0);
    expect(JSON.stringify(routed)).toMatch(/historical user image omitted/);
    expect(inlineImages(rewriteXaiResponsesPayload(payload, TEST_MODEL))).toHaveLength(1);
  });
  it("keeps user images alive across reasoning and function_call until an assistant message", () => {
    const content = [
      { type: "input_text", text: "fix this screenshot" },
      { type: "input_image", image_url: tiny, detail: "auto" },
    ];
    for (const midToolBoundary of [
      { type: "reasoning", summary: [] },
      { type: "function_call", call_id: "tool_1", name: "read_file", arguments: "{}" },
    ]) {
      const routed = rewriteXaiResponsesPayload(
        {
          model: TEST_MODEL.id,
          input: [
            { role: "user", content },
            midToolBoundary,
            {
              type: "function_call_output",
              call_id: "tool_1",
              output: "file contents",
            },
          ],
        },
        TEST_MODEL,
        { omitConsumedVisionImages: true },
      );
      expect(inlineImages(routed)).toHaveLength(1);
      expect(JSON.stringify(routed)).not.toMatch(/historical user image omitted/);
    }
  });
  it.each([
    {
      name: "progress text before one call",
      content: [{ type: "text", text: "I will inspect it." }, piToolCall(1)],
      expectedTypes: ["user", "message", "function_call", "function_call_output"],
    },
    {
      name: "one call before progress text",
      content: [piToolCall(1), { type: "text", text: "I am inspecting it." }],
      expectedTypes: ["user", "function_call", "message", "function_call_output"],
    },
    {
      name: "multiple calls before progress text",
      content: [
        piToolCall(1),
        piReasoning,
        piToolCall(2),
        { type: "text", text: "I have both files now." },
      ],
      expectedTypes: [
        "user",
        "function_call",
        "reasoning",
        "function_call",
        "message",
        "function_call_output",
        "function_call_output",
      ],
    },
  ])("keeps converted images alive for $name", ({ content, expectedTypes }) => {
    const converted = convertVisionHistory(content);
    expect(converted.map((item: any) => item.type ?? item.role)).toEqual(expectedTypes);

    const routed = rewriteXaiResponsesPayload(
      { model: TEST_MODEL.id, input: converted },
      TEST_MODEL,
      { omitConsumedVisionImages: true },
    );
    expect(inlineImages(routed)).toHaveLength(1);
    expect(JSON.stringify(routed)).not.toMatch(/historical user image omitted/);
  });
  it("still consumes images after a separate converted terminal turn", () => {
    const converted = convertVisionHistory(
      [piToolCall(1), { type: "text", text: "I am inspecting it." }],
      true,
    );
    expect(converted.map((item: any) => item.type ?? item.role)).toEqual([
      "user",
      "function_call",
      "message",
      "function_call_output",
      "message",
      "user",
    ]);

    const routed = rewriteXaiResponsesPayload(
      { model: TEST_MODEL.id, input: converted },
      TEST_MODEL,
      { omitConsumedVisionImages: true },
    );
    expect(inlineImages(routed)).toHaveLength(0);
    expect(JSON.stringify(routed)).toMatch(/historical user image omitted/);
  });
  it("retains non-image user text while replacing a consumed mixed-content historical image", () => {
    const payload = {
      model: TEST_MODEL.id,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe" },
            { type: "input_image", image_url: tiny, detail: "auto" },
          ],
        },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        { role: "user", content: "next" },
      ],
    };
    const routed = rewriteXaiResponsesPayload(payload, TEST_MODEL, {
      omitConsumedVisionImages: true,
    }) as { input: Array<Record<string, unknown>> };

    // Distinct mixed-content invariant: the ordinary user text survives
    // while only the historical image is replaced by the bounded placeholder.
    expect(inlineImages(routed)).toHaveLength(0);
    const firstUser = routed.input[0];
    expect(firstUser).toMatchObject({ role: "user" });
    expect(firstUser.content).toEqual([
      { type: "input_text", text: "describe" },
      { type: "input_text", text: HISTORICAL_USER_IMAGE_PLACEHOLDER },
    ]);
  });
  it("omits consumed computer screenshots only when explicitly requested", () => {
    const payload = {
      model: TEST_MODEL.id,
      input: [
        {
          type: "computer_call_output",
          call_id: "computer_old",
          output: { type: "computer_screenshot", image_url: "https://example.test/old.png" },
        },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        { role: "user", content: "next" },
      ],
    };
    const routed = rewriteXaiResponsesPayload(payload, TEST_MODEL, { omitConsumedVisionImages: true });
    const routedInput = (routed as { input: Array<Record<string, unknown>> }).input;
    expect(routedInput[0].output).toEqual({ type: "computer_screenshot" });
    expect(routedInput[1]).toMatchObject({ role: "user" });
    expect(xaiResponsesPayloadContainsImage(routed)).toBe(false);
    expect(JSON.stringify(routed)).toMatch(/historical computer screenshot omitted/);
    expect(xaiResponsesPayloadContainsImage(rewriteXaiResponsesPayload(payload, TEST_MODEL))).toBe(true);
  });
  it("retains pending tool images until the next assistant output", () => {
    expect(
      inlineImages(
        rewriteXaiResponsesPayload(
          { model: TEST_MODEL.id, input: [toolImage()] },
          TEST_MODEL,
        ),
      ),
    ).toHaveLength(1);
    expect(
      inlineImages(
        rewriteXaiResponsesPayload(
          {
            model: TEST_MODEL.id,
            input: [
              toolImage(),
              { role: "user", content: "continue" },
              { type: "function_call_output", call_id: "b", output: "text" },
            ],
          },
          TEST_MODEL,
        ),
      ),
    ).toHaveLength(1);
  });
  it("omits historical but retains current tool images", () => {
    const result = rewriteXaiResponsesPayload(
      {
        model: TEST_MODEL.id,
        input: [
          toolImage("old"),
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "seen" }],
          },
          toolImage("new"),
        ],
      },
      TEST_MODEL,
    );
    expect(inlineImages(result)).toHaveLength(1);
  });
  it("never prunes ordinary user images", () => {
    const result = rewriteXaiResponsesPayload(
      {
        model: TEST_MODEL.id,
        input: [
          { role: "user", content: [{ type: "input_image", image_url: tiny }] },
          { role: "assistant", content: "seen" },
        ],
      },
      TEST_MODEL,
    );
    expect(inlineImages(result)).toHaveLength(1);
  });
  it("moves leading system/developer text to instructions for standard models", () => {
    const result: any = rewriteXaiResponsesPayload(
      {
        model: "grok-4.5",
        instructions: "base",
        input: [
          { role: "system", content: "system" },
          {
            role: "developer",
            content: [{ type: "input_text", text: "developer" }],
          },
          { role: "user", content: "hello" },
        ],
      },
      TEST_MODEL,
    );
    expect(result.instructions).toBe("base\n\nsystem\n\ndeveloper");
    expect(result.input).toEqual([{ role: "user", content: "hello" }]);
  });
  it("moves system text while preserving complete reasoning replay for CLI models", () => {
    setXaiRuntimeModels(KNOWN_XAI_MODEL_METADATA);
    const model = { ...TEST_MODEL, id: "grok-build" } as any;
    const reasoning = {
      id: "reasoning-1",
      type: "reasoning",
      summary: [],
      encrypted_content: "opaque-reasoning",
      status: "completed",
      future_field: { preserved: true },
    };
    const result: any = rewriteXaiResponsesPayload(
      {
        model: model.id,
        input: [
          { role: "user", content: "first" },
          { role: "system", content: "late" },
          reasoning,
          { role: "user", content: "" },
        ],
        include: ["reasoning.encrypted_content", "other"],
      },
      model,
    );
    expect(result.instructions).toBe("late");
    expect(result.input).toEqual([{ role: "user", content: "first" }, reasoning]);
    expect(result.include).toEqual(["reasoning.encrypted_content", "other"]);
  });
  it("applies the OAuth Responses store and encrypted include policy immutably", () => {
    const include = Object.freeze(["other", "reasoning.encrypted_content", "other"]);
    const payload = Object.freeze({ input: "hello", include });
    expect(applyXaiOAuthResponsesPolicy(payload)).toEqual({
      input: "hello",
      store: false,
      include: ["other", "reasoning.encrypted_content"],
    });
    expect(payload).toEqual({ input: "hello", include });
    expect(applyXaiOAuthResponsesPolicy({ store: true, include: ["other"] })).toEqual({
      store: true,
      include: ["other", "reasoning.encrypted_content"],
    });
    expect(applyXaiOAuthResponsesPolicy({ include: "malformed" as any })).toEqual({
      include: ["reasoning.encrypted_content"],
      store: false,
    });
  });

  it("normalizes response format, reasoning effort, and prompt cache fields", () => {
    setXaiRuntimeModels(KNOWN_XAI_MODEL_METADATA);
    const result: any = rewriteXaiResponsesPayload(
      {
        model: "grok-4.5",
        input: "hello",
        response_format: { type: "json_object" },
        reasoning: { effort: "minimal" },
        prompt_cache_retention: "24h",
      },
      TEST_MODEL,
      { sessionId: "session" } as any,
    );
    expect(result).toMatchObject({
      text: { format: { type: "json_object" } },
      reasoning: { effort: "low" },
      prompt_cache_key: "session",
    });
    expect(result).not.toHaveProperty("response_format");
    expect(result).not.toHaveProperty("prompt_cache_retention");
  });
  it("normalizes generic image shapes", () => {
    const result: any = rewriteXaiResponsesPayload(
      {
        model: "grok-4.5",
        input: [
          {
            role: "user",
            content: [
              { type: "image", data: "YWJj", mimeType: "image/png" },
              {
                type: "image_url",
                image_url: {
                  url: "https://example.test/a.png",
                  detail: "high",
                },
              },
            ],
          },
        ],
      },
      TEST_MODEL,
    );
    expect(result.input[0].content).toEqual([
      {
        type: "input_image",
        image_url: "data:image/png;base64,YWJj",
        detail: "auto",
      },
      {
        type: "input_image",
        image_url: "https://example.test/a.png",
        detail: "high",
      },
    ]);
  });
  it("materializes only local Responses images inside the provider workspace", () => {
    const insideDir = mkdtempSync(join(process.cwd(), ".xai-payload-inside-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "xai-payload-outside-"));
    const inside = join(insideDir, "inside.png");
    const outside = join(outsideDir, "SENSITIVE-outside.png");
    writeFileSync(inside, tinyPngBytes());
    writeFileSync(outside, tinyPngBytes());
    try {
      const result: any = rewriteXaiResponsesPayload(
        {
          model: "grok-4.5",
          input: [{
            role: "user",
            content: [{ type: "image_url", image_url: inside }],
          }],
        },
        TEST_MODEL,
      );
      expect(result.input[0].content[0]).toMatchObject({
        type: "input_image",
        detail: "auto",
      });
      expect(result.input[0].content[0].image_url).toMatch(/^data:image\/png;base64,/);
      expect(JSON.stringify(result)).not.toContain(inside);

      let error: Error | undefined;
      try {
        rewriteXaiResponsesPayload(
          {
            model: "grok-4.5",
            input: [{
              role: "user",
              content: [{ type: "input_image", image_url: outside }],
            }],
          },
          TEST_MODEL,
        );
      } catch (caught) {
        error = caught as Error;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toMatch(/outside the workspace/);
      expect(error?.message).not.toMatch(/SENSITIVE|outside\.png/);
      expect(error?.message).not.toContain(outside);
    } finally {
      rmSync(insideDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
  it("detects only structural image content inside final Responses input", () => {
    expect(
      xaiResponsesPayloadContainsImage({
        input: [{ role: "user", content: [{ type: "input_image", image_url: "redacted" }] }],
      }),
    ).toBe(true);
    expect(
      xaiResponsesPayloadContainsImage({
        input: [{ role: "user", content: [{ type: "image", data: "redacted" }] }],
      }),
    ).toBe(true);
    expect(
      xaiResponsesPayloadContainsImage({
        input: [{ role: "user", content: "the words input_image and image_url are ordinary text" }],
        metadata: { type: "input_image" },
      }),
    ).toBe(false);
  });

  it("detects URL-backed and file-backed computer screenshots", () => {
    expect(
      xaiResponsesPayloadContainsImage({
        input: [{
          type: "computer_call_output",
          output: {
            type: "computer_screenshot",
            image_url: "https://example.test/private.png",
          },
        }],
      }),
    ).toBe(true);
    expect(
      xaiResponsesPayloadContainsImage({
        input: [{
          type: "computer_call_output",
          output: { type: "computer_screenshot", file_id: "file_private" },
        }],
      }),
    ).toBe(true);
    expect(
      xaiResponsesPayloadContainsImage({
        input: [{ type: "computer_screenshot" }],
        metadata: {
          type: "computer_screenshot",
          image_url: "https://example.test/not-input.png",
        },
      }),
    ).toBe(false);
  });

  it("walks payloads wider than V8's variadic argument limit", () => {
    const wideInput = Array.from({ length: 150_000 }, () => null) as unknown[];
    expect(
      xaiResponsesPayloadContainsImage({
        input: wideInput,
      }),
    ).toBe(false);
    wideInput[0] = { type: "input_image", image_url: "redacted" };
    expect(xaiResponsesPayloadContainsImage({ input: wideInput })).toBe(true);
  });

  it("canonicalizes a custom serializer exactly once into inert JSON", () => {
    let calls = 0;
    const canonical = canonicalizeXaiResponsesPayload({
      model: "apparent",
      input: "apparent",
      toJSON() {
        calls++;
        return { model: "grok-4.5", input: "canonical" };
      },
    });
    expect(calls).toBe(1);
    expect(canonical).toEqual({ model: "grok-4.5", input: "canonical" });
    expect(canonical).not.toHaveProperty("toJSON");
  });

  it("redacts canonicalization failures and rejects non-object results", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const throwing = {
      toJSON() {
        throw new Error("SERIALIZER_SECRET");
      },
    };
    const throwingAccessor = Object.defineProperty({}, "input", {
      enumerable: true,
      get() {
        throw new Error("ACCESSOR_SECRET");
      },
    });

    for (const value of [
      cyclic,
      throwing,
      throwingAccessor,
      { value: 1n },
      { toJSON: () => undefined },
      { toJSON: () => [] },
      { toJSON: () => "scalar" },
    ]) {
      let error: Error | undefined;
      try {
        canonicalizeXaiResponsesPayload(value);
      } catch (caught) {
        error = caught as Error;
      }
      expect(error?.message).toBe(XAI_PAYLOAD_CANONICALIZATION_ERROR);
      expect(error?.message).not.toMatch(/SERIALIZER_SECRET|ACCESSOR_SECRET/);
    }
  });
});
