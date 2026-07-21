import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURATED_FALLBACK_MODELS,
  KNOWN_XAI_MODEL_METADATA,
  setXaiRuntimeModels,
  XaiModelInputProvenance,
  type XaiCatalogModel,
} from "../../extensions/xai/models";
import { createXaiResponse, streamSimpleXaiResponses } from "../../extensions/xai/responses";
import {
  createXaiVisionRoutingController,
  XAI_VISION_ROUTING_INVALIDATED_ERROR,
} from "../../extensions/xai/vision-routing";
import { jsonResponse, requestBody } from "../fixtures/http";
import { tinyPngBytes } from "../fixtures/images";
import { TEST_MODEL } from "../fixtures/models";

function entitlement(
  id: string,
  input: ("text" | "image")[],
  inputProvenance = XaiModelInputProvenance.AuthenticatedInputModalities,
): XaiCatalogModel {
  return {
    ...KNOWN_XAI_MODEL_METADATA[0],
    id,
    name: id,
    input,
    inputProvenance,
  };
}

const source = entitlement("text-source", ["text"]);
const target = entitlement("vision-target", ["text", "image"]);
const sourceModel = { ...TEST_MODEL, id: source.id, input: ["text"] } as any;

function streamResponse(text = "OK"): Response {
  const item = {
    id: "message",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: "source",
    status: "completed",
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const events = [
    { type: "response.created", response: { id: "source" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage);
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (["input_image", "image_url", "computer_screenshot", "image"].includes(String(item.type))) return true;
  return Object.values(item).some(containsImage);
}

beforeEach(() => setXaiRuntimeModels([source, target]));
afterEach(() => {
  setXaiRuntimeModels(CURATED_FALLBACK_MODELS);
  vi.restoreAllMocks();
});

describe("opt-in vision routing", () => {
  it("uses only exact authenticated evidence and deterministic target order", () => {
    const controller = createXaiVisionRoutingController();
    controller.replaceCatalog([
      entitlement("z-target", ["text", "image"]),
      source,
      entitlement("a-target", ["text", "image"]),
    ]);
    expect(controller.enable(sourceModel)).toMatchObject({
      state: "enabled",
      sourceModelId: "text-source",
      targetModelId: "a-target",
    });

    controller.replaceCatalog([
      source,
      entitlement("known-only", ["text", "image"], XaiModelInputProvenance.Known),
    ]);
    expect(controller.enable(sourceModel)).toMatchObject({ state: "unavailable" });
  });

  it("sends one image-only description request before an image-free source request", async () => {
    const controller = createXaiVisionRoutingController();
    controller.replaceCatalog([source, target]);
    expect(controller.enable(sourceModel).state).toBe("enabled");
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: RequestInit = {}) => {
      const body = requestBody(init);
      requests.push(body);
      return body.model === target.id
        ? jsonResponse({ id: "vision", output_text: "A red square with the word STOP." })
        : streamResponse("Understood.");
    }));

    const stream = streamSimpleXaiResponses(
      sourceModel,
      { messages: [{ role: "user", content: "describe", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          payload.input = [{
            role: "user",
            content: [
              { type: "input_text", text: "What is shown?" },
              { type: "input_image", image_url: "https://example.test/private.png" },
            ],
          }];
        },
      } as any,
      controller,
    );
    const result = await stream.result();

    expect(result.errorMessage).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[0].model).toBe(target.id);
    expect(containsImage(requests[0])).toBe(true);
    expect(requests[0]).not.toHaveProperty("tools");
    expect(requests[1].model).toBe(source.id);
    expect(containsImage(requests[1])).toBe(false);
    expect(JSON.stringify(requests[1])).toMatch(/xAI-generated visual description.*red square/s);
  });

  it("keeps Pi-converted conversation images available to enabled vision routing", async () => {
    const controller = createXaiVisionRoutingController();
    controller.replaceCatalog([source, target]);
    expect(controller.enable(sourceModel).state).toBe("enabled");
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: RequestInit = {}) => {
      const body = requestBody(init);
      requests.push(body);
      return body.model === target.id
        ? jsonResponse({ id: "vision", output_text: "A red square with the word STOP." })
        : streamResponse("Understood.");
    }));

    const stream = streamSimpleXaiResponses(
      sourceModel,
      {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "What is shown?" },
            { type: "image", data: Buffer.from(tinyPngBytes()).toString("base64"), mimeType: "image/png" },
          ],
          timestamp: Date.now(),
        }],
      } as any,
      { apiKey: "oauth-token" } as any,
      controller,
    );
    await stream.result();

    expect(requests).toHaveLength(2);
    expect(requests[0].model).toBe(target.id);
    expect(containsImage(requests[0])).toBe(true);
  });

  it("omits consumed historical user images instead of routing them again", async () => {
    const controller = createXaiVisionRoutingController();
    controller.replaceCatalog([source, target]);
    controller.enable(sourceModel);
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: RequestInit = {}) => {
      const body = requestBody(init);
      requests.push(body);
      return body.model === target.id
        ? jsonResponse({ id: "vision", output_text: "old image" })
        : streamResponse();
    }));

    const stream = streamSimpleXaiResponses(
      sourceModel,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this." },
              { type: "image", data: Buffer.from(tinyPngBytes()).toString("base64"), mimeType: "image/png" },
            ],
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Already described." }],
            api: "xai-responses",
            provider: "xai-auth",
            model: source.id,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
            stopReason: "stop",
            timestamp: 2,
          },
          { role: "user", content: "Answer a new question.", timestamp: 3 },
        ],
      } as any,
      { apiKey: "oauth-token" } as any,
      controller,
    );
    const result = await stream.result();

    expect(result.errorMessage).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe(source.id);
    expect(containsImage(requests[0])).toBe(false);
    expect(JSON.stringify(requests[0])).toMatch(/historical user image omitted/);
  });

  it("re-routes user images across a mid tool-loop turn without an assistant message", async () => {
    const controller = createXaiVisionRoutingController();
    controller.replaceCatalog([source, target]);
    controller.enable(sourceModel);
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: RequestInit = {}) => {
      const body = requestBody(init);
      requests.push(body);
      return body.model === target.id
        ? jsonResponse({ id: "vision", output_text: "screenshot of a stack trace" })
        : streamResponse("calling tools");
    }));

    const stream = streamSimpleXaiResponses(
      sourceModel,
      { messages: [{ role: "user", content: "continue tools", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          payload.input = [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Fix the bug in this screenshot." },
                { type: "input_image", image_url: "https://example.test/bug.png" },
              ],
            },
            {
              type: "function_call",
              call_id: "call_1",
              name: "read_file",
              arguments: "{\"path\":\"app.ts\"}",
            },
            {
              type: "function_call_output",
              call_id: "call_1",
              output: "export function main() {}",
            },
          ];
        },
      } as any,
      controller,
    );
    const result = await stream.result();

    expect(result.errorMessage).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[0].model).toBe(target.id);
    expect(containsImage(requests[0])).toBe(true);
    expect(JSON.stringify(requests[0])).toContain("bug.png");
    expect(requests[1].model).toBe(source.id);
    expect(containsImage(requests[1])).toBe(false);
    expect(JSON.stringify(requests[1])).toMatch(/xAI-generated visual description/);
    expect(JSON.stringify(requests[1])).toMatch(/screenshot of a stack trace/);
    expect(JSON.stringify(requests[1])).not.toMatch(/historical user image omitted/);
  });

  it("reapplies history pruning after a payload hook while preserving the current image", async () => {
    const controller = createXaiVisionRoutingController();
    controller.replaceCatalog([source, target]);
    controller.enable(sourceModel);
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: RequestInit = {}) => {
      const body = requestBody(init);
      requests.push(body);
      return body.model === target.id
        ? jsonResponse({ id: "vision", output_text: "current image only" })
        : streamResponse();
    }));

    const stream = streamSimpleXaiResponses(
      sourceModel,
      { messages: [{ role: "user", content: "inspect", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          payload.input = [
            {
              role: "user",
              content: [{ type: "image", data: "aGlzdG9yaWNhbA==", mimeType: "image/png" }],
            },
            { role: "assistant", content: [{ type: "output_text", text: "already used" }] },
            {
              role: "user",
              content: [{ type: "input_image", image_url: "https://example.test/current.png" }],
            },
          ];
        },
      } as any,
      controller,
    );
    const result = await stream.result();

    expect(result.errorMessage).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[0].model).toBe(target.id);
    expect(JSON.stringify(requests[0])).toContain("current.png");
    expect(JSON.stringify(requests[0])).not.toContain("aGlzdG9yaWNhbA");
    expect(requests[1].model).toBe(source.id);
    expect(containsImage(requests[1])).toBe(false);
    expect(JSON.stringify(requests[1])).toMatch(/historical user image omitted/);
  });

  it("strips hook-returned historical computer screenshot references without changing its schema", async () => {
    const controller = createXaiVisionRoutingController();
    controller.replaceCatalog([source, target]);
    controller.enable(sourceModel);
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: RequestInit = {}) => {
      const body = requestBody(init);
      requests.push(body);
      return streamResponse();
    }));

    const stream = streamSimpleXaiResponses(
      sourceModel,
      { messages: [{ role: "user", content: "continue", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          payload.input = [
            {
              type: "computer_call_output",
              call_id: "computer_old",
              output: {
                type: "computer_screenshot",
                image_url: "https://example.test/private-old.png",
                file_id: "file-private-old",
              },
            },
            { role: "assistant", content: [{ type: "output_text", text: "already inspected" }] },
            { role: "user", content: [{ type: "input_text", text: "continue" }] },
          ];
        },
      } as any,
      controller,
    );
    const result = await stream.result();

    expect(result.errorMessage).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe(source.id);
    expect(requests[0].input[0]).toMatchObject({
      type: "computer_call_output",
      call_id: "computer_old",
      output: { type: "computer_screenshot" },
    });
    expect(requests[0].input[0].output).toEqual({ type: "computer_screenshot" });
    expect(JSON.stringify(requests[0])).not.toMatch(/private-old|file-private-old/);
    expect(JSON.stringify(requests[0]).match(/historical computer screenshot omitted/g)).toHaveLength(1);
  });

  it("recursively strips hook-returned historical image and screenshot shapes", async () => {
    const controller = createXaiVisionRoutingController();
    controller.replaceCatalog([source, target]);
    controller.enable(sourceModel);
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: RequestInit = {}) => {
      const body = requestBody(init);
      requests.push(body);
      return streamResponse();
    }));

    const stream = streamSimpleXaiResponses(
      sourceModel,
      { messages: [{ role: "user", content: "continue", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          payload.input = [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "old user text",
                  metadata: {
                    image: {
                      type: "input_image",
                      image_url: "/definitely/not/read/historical-private.png",
                    },
                  },
                },
                { type: "computer_screenshot", file_id: "historical-user-file" },
              ],
            },
            {
              type: "function_call_output",
              call_id: "tool_old",
              output: [
                { type: "input_text", text: "old tool text" },
                {
                  type: "container",
                  screenshot: { type: "computer_screenshot", file_id: "historical-tool-file" },
                },
              ],
            },
            { role: "assistant", content: [{ type: "output_text", text: "already inspected" }] },
            { role: "user", content: [{ type: "input_text", text: "continue" }] },
          ];
        },
      } as any,
      controller,
    );
    const result = await stream.result();

    expect(result.errorMessage).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe(source.id);
    expect(containsImage(requests[0])).toBe(false);
    expect(JSON.stringify(requests[0])).not.toMatch(
      /historical-private|historical-user-file|historical-tool-file/,
    );
    expect(JSON.stringify(requests[0])).toMatch(/historical user image omitted/);
    expect(JSON.stringify(requests[0])).toMatch(/historical tool image omitted/);
  });

  it("routes a valid provider-workspace image as verified bytes", async () => {
    const insideDir = mkdtempSync(join(process.cwd(), ".xai-vision-inside-"));
    const inside = join(insideDir, "inside.png");
    writeFileSync(inside, tinyPngBytes());
    try {
      const controller = createXaiVisionRoutingController();
      controller.replaceCatalog([source, target]);
      controller.enable(sourceModel);
      const requests: any[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: any, init: RequestInit = {}) => {
        const body = requestBody(init);
        requests.push(body);
        return body.model === target.id
          ? jsonResponse({ id: "vision", output_text: "Verified local image." })
          : streamResponse();
      }));

      const stream = streamSimpleXaiResponses(
        sourceModel,
        { messages: [{ role: "user", content: "inspect", timestamp: Date.now() }] } as any,
        {
          apiKey: "oauth-token",
          onPayload(payload: any) {
            payload.input = [{
              role: "user",
              content: [{
                type: "image",
                source: { type: "url", url: inside },
              }],
            }];
          },
        } as any,
        controller,
      );
      const result = await stream.result();

      expect(result.errorMessage).toBeUndefined();
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[0])).toContain("data:image/png;base64,");
      expect(JSON.stringify(requests)).not.toContain(inside);
    } finally {
      rmSync(insideDir, { recursive: true, force: true });
    }
  });

  it("rejects an outside image source in vision routing before fetch without reflecting it", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "xai-vision-outside-"));
    const outside = join(outsideDir, "SENSITIVE-outside.png");
    writeFileSync(outside, tinyPngBytes());
    try {
      const controller = createXaiVisionRoutingController();
      controller.replaceCatalog([source, target]);
      controller.enable(sourceModel);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);

      const stream = streamSimpleXaiResponses(
        sourceModel,
        { messages: [{ role: "user", content: "inspect", timestamp: Date.now() }] } as any,
        {
          apiKey: "oauth-token",
          onPayload(payload: any) {
            payload.input = [{
              role: "user",
              content: [{
                type: "image",
                source: { type: "url", url: outside },
              }],
            }];
          },
        } as any,
        controller,
      );
      const result = await stream.result();

      expect(result.errorMessage).toMatch(/Responses failed/);
      expect(result.errorMessage).not.toMatch(/SENSITIVE|outside\.png/);
      expect(result.errorMessage).not.toContain(outside);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects disabled local image paths before filesystem normalization", async () => {
    const missing = "/definitely/not/a/real/private-image.png";
    await expect(createXaiResponse(
      { kind: "oauth-session", token: "oauth-token" },
      {
        model: source.id,
        input: [{ role: "user", content: [{ type: "input_image", image_url: missing }] }],
      },
    )).rejects.toThrow(/explicitly text-only.*no xAI request was sent/);
  });

  it("retains the existing zero-request local rejection while disabled", async () => {
    const controller = createXaiVisionRoutingController();
    controller.replaceCatalog([source, target]);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const stream = streamSimpleXaiResponses(
      sourceModel,
      { messages: [{ role: "user", content: "describe", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          payload.input = [{
            role: "user",
            content: [{ type: "input_image", image_url: "https://example.test/private.png" }],
          }];
        },
      } as any,
      controller,
    );
    const result = await stream.result();

    expect(result.errorMessage).toMatch(/explicitly text-only.*no xAI request was sent/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not adopt routing enabled after a request starts", async () => {
    const controller = createXaiVisionRoutingController();
    controller.replaceCatalog([source, target]);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const stream = streamSimpleXaiResponses(
      sourceModel,
      { messages: [{ role: "user", content: "describe", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          controller.enable(sourceModel);
          payload.input = [{
            role: "user",
            content: [{ type: "input_image", image_url: "https://example.test/private.png" }],
          }];
        },
      } as any,
      controller,
    );
    const result = await stream.result();

    expect(result.errorMessage).toMatch(/explicitly text-only.*no xAI request was sent/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes current tool images but omits consumed historical images", async () => {
    const controller = createXaiVisionRoutingController();
    controller.replaceCatalog([source, target]);
    controller.enable(sourceModel);
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: RequestInit = {}) => {
      const body = requestBody(init);
      requests.push(body);
      return body.model === target.id
        ? jsonResponse({ id: "resp", output_text: "Tool image description" })
        : streamResponse();
    }));

    const current = streamSimpleXaiResponses(
      sourceModel,
      {
        messages: [{
          role: "toolResult",
          toolCallId: "call_image",
          toolName: "screenshot",
          content: [
            { type: "text", text: "screenshot" },
            { type: "image", data: Buffer.from(tinyPngBytes()).toString("base64"), mimeType: "image/png" },
          ],
          isError: false,
          timestamp: Date.now(),
        }],
      } as any,
      { apiKey: "oauth-token" } as any,
      controller,
    );
    await current.result();
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain("call_image");
    expect(containsImage(requests[1])).toBe(false);

    requests.length = 0;
    const consumed = streamSimpleXaiResponses(
      sourceModel,
      {
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_old",
            toolName: "screenshot",
            content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
            isError: false,
            timestamp: Date.now(),
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "already used" }],
            api: "xai-responses",
            provider: "xai-auth",
            model: source.id,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
            stopReason: "stop",
            timestamp: Date.now(),
          },
        ],
      } as any,
      { apiKey: "oauth-token" } as any,
      controller,
    );
    await consumed.result();
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe(source.id);
  });

  it("aborts an in-flight description request when authorization is reset", async () => {
    const controller = createXaiVisionRoutingController();
    controller.replaceCatalog([source, target]);
    controller.enable(sourceModel);
    let aborted = false;
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: RequestInit = {}) => {
      const body = requestBody(init);
      if (body.model !== target.id) return streamResponse();
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
        controller.reset();
      });
    }));

    const stream = streamSimpleXaiResponses(
      sourceModel,
      { messages: [{ role: "user", content: "describe", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          payload.input = [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/x.png" }] }];
        },
      } as any,
      controller,
    );
    await stream.result();
    expect(aborted).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a reset and re-enabled replacement grant before routing", async () => {
    const controller = createXaiVisionRoutingController();
    controller.replaceCatalog([source, target]);
    controller.enable(sourceModel);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let hookModelInput: unknown;

    const stream = streamSimpleXaiResponses(
      sourceModel,
      {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe this." },
            { type: "image", data: Buffer.from(tinyPngBytes()).toString("base64"), mimeType: "image/png" },
          ],
          timestamp: Date.now(),
        }],
      } as any,
      {
        apiKey: "old-account-token",
        onPayload(payload: unknown, hookModel: { input: unknown }) {
          hookModelInput = hookModel.input;
          controller.reset();
          controller.replaceCatalog([source, target]);
          controller.enable(sourceModel);
          return payload;
        },
      } as any,
      controller,
    );
    const result = await stream.result();

    expect(hookModelInput).toEqual(["text"]);
    expect(result.errorMessage).toBe(XAI_VISION_ROUTING_INVALIDATED_ERROR);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prevents the source request after catalog invalidation", async () => {
    const controller = createXaiVisionRoutingController();
    controller.replaceCatalog([source, target]);
    controller.enable(sourceModel);
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: RequestInit = {}) => {
      const body = requestBody(init);
      requests.push(body);
      if (body.model === target.id) controller.replaceCatalog([source, target]);
      return jsonResponse({ id: "vision", output_text: "description" });
    }));

    const stream = streamSimpleXaiResponses(
      sourceModel,
      { messages: [{ role: "user", content: "describe", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          payload.input = [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/x.png" }] }];
        },
      } as any,
      controller,
    );
    const result = await stream.result();
    expect(result.errorMessage).toBe(XAI_VISION_ROUTING_INVALIDATED_ERROR);
    expect(requests).toHaveLength(1);
  });
});
