import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_XAI_INLINE_IMAGE_BASE64_BYTES } from "../../extensions/xai/images";
import {
  CURATED_FALLBACK_MODELS,
  KNOWN_XAI_MODEL_METADATA,
  setXaiRuntimeModels,
  XaiModelInputProvenance,
} from "../../extensions/xai/models";
import {
  streamSimpleXaiResponses,
} from "../../extensions/xai/responses";
import { createXaiResponse } from "../../extensions/xai/responses-request";
import { XAI_PAYLOAD_CANONICALIZATION_ERROR } from "../../extensions/xai/payload";
import { jsonResponse, requestBody } from "../fixtures/http";
import { TEST_MODEL } from "../fixtures/models";
let requests: any[];
let oversized: string;
let input: any[];
const textOnlyEntitlement = {
  ...KNOWN_XAI_MODEL_METADATA[0],
  input: ["text"] as ["text"],
  inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
};
const authenticatedImageEntitlement = {
  ...KNOWN_XAI_MODEL_METADATA[0],
  input: ["text", "image"] as ["text", "image"],
  inputProvenance: XaiModelInputProvenance.AuthenticatedInputModalities,
};
function images(value: any) {
  const result: string[] = [];
  const walk = (item: any) => {
    if (Array.isArray(item)) return item.forEach(walk);
    if (!item || typeof item !== "object") return;
    if (item.type === "input_image" && typeof item.image_url === "string")
      result.push(item.image_url);
    Object.values(item).forEach(walk);
  };
  walk(value);
  return result;
}
beforeEach(async () => {
  setXaiRuntimeModels(KNOWN_XAI_MODEL_METADATA);
  requests = [];
  const bytes = Buffer.concat(Array(10).fill(await readFile("preview.jpeg")));
  oversized = `data:image/jpeg;base64,${bytes.toString("base64")}`;
  input = [
    {
      role: "user",
      content: [
        { type: "input_image", image_url: oversized },
        { type: "input_image", image_url: oversized },
        { type: "input_text", text: "OK" },
      ],
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: RequestInit = {}) => {
      requests.push({ url: String(url), body: requestBody(init) });
      return jsonResponse({ id: "resp", output_text: "OK" });
    }),
  );
});
afterEach(() => setXaiRuntimeModels(CURATED_FALLBACK_MODELS));
function bytes(value: any) {
  return images(value).reduce(
    (total, url) => total + Buffer.byteLength(url.split(",")[1] ?? ""),
    0,
  );
}
describe("Responses image preparation", () => {
  it("rejects direct image input for authenticated text-only evidence before fetch", async () => {
    setXaiRuntimeModels([textOnlyEntitlement]);
    await expect(
      createXaiResponse(
        { kind: "oauth-session", token: "oauth-token" },
        {
          model: "grok-4.5",
          input: [
            {
              role: "user",
              content: [
                { type: "input_image", image_url: "https://example.test/private.png" },
                { type: "input_text", text: "describe" },
              ],
            },
          ],
        },
      ),
    ).rejects.toThrow(/explicitly text-only.*no xAI request was sent/);
    expect(requests).toHaveLength(0);
  });

  it("rejects a direct image exposed by a custom serializer before fetch", async () => {
    setXaiRuntimeModels([textOnlyEntitlement]);
    let serializerCalls = 0;
    await expect(
      createXaiResponse(
        { kind: "oauth-session", token: "oauth-token" },
        {
          model: "grok-4.5",
          input: "apparent text",
          toJSON() {
            serializerCalls++;
            return {
              model: "grok-4.5",
              input: [{
                role: "user",
                content: [{
                  type: "input_image",
                  image_url: "https://example.test/serializer-private.png",
                }],
              }],
            };
          },
        },
      ),
    ).rejects.toThrow(/explicitly text-only.*no xAI request was sent/);
    expect(serializerCalls).toBe(1);
    expect(requests).toHaveLength(0);
  });

  it("transports a benign direct custom serializer's inert result", async () => {
    let serializerCalls = 0;
    await createXaiResponse(
      { kind: "oauth-session", token: "oauth-token" },
      {
        model: "apparent",
        input: "apparent",
        toJSON() {
          serializerCalls++;
          return { model: "grok-4.5", input: "canonical direct text" };
        },
      },
    );
    expect(serializerCalls).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({
      model: "grok-4.5",
      input: "canonical direct text",
    });
    expect(requests[0].body).not.toHaveProperty("toJSON");
  });

  it("redacts direct and streaming custom serializer failures before fetch", async () => {
    await expect(
      createXaiResponse(
        { kind: "oauth-session", token: "oauth-token" },
        {
          toJSON() {
            throw new Error("DIRECT_SERIALIZER_SECRET");
          },
        },
      ),
    ).rejects.toThrow(XAI_PAYLOAD_CANONICALIZATION_ERROR);

    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload() {
          return {
            toJSON() {
              throw new Error("STREAM_SERIALIZER_SECRET");
            },
          };
        },
      } as any,
    );
    const result = await stream.result();
    expect(result.errorMessage).toBe(XAI_PAYLOAD_CANONICALIZATION_ERROR);
    expect(result.errorMessage).not.toMatch(/DIRECT_SERIALIZER_SECRET|STREAM_SERIALIZER_SECRET/);
    expect(requests).toHaveLength(0);
  });

  it("rejects non-canonical direct payloads before fetch", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const body of [
      cyclic,
      { value: 1n },
      [],
      undefined,
    ]) {
      await expect(
        createXaiResponse(
          { kind: "oauth-session", token: "oauth-token" },
          body as any,
        ),
      ).rejects.toThrow(XAI_PAYLOAD_CANONICALIZATION_ERROR);
    }
    expect(requests).toHaveLength(0);
  });

  it("allows text and follows a replaced authenticated image-capable snapshot", async () => {
    setXaiRuntimeModels([textOnlyEntitlement]);
    await createXaiResponse(
      { kind: "oauth-session", token: "oauth-token" },
      { model: "grok-4.5", input: "text only" },
    );
    expect(requests).toHaveLength(1);

    setXaiRuntimeModels([authenticatedImageEntitlement]);
    await createXaiResponse(
      { kind: "oauth-session", token: "oauth-token" },
      {
        model: "grok-4.5",
        input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/ok.png" }] }],
      },
    );
    expect(requests).toHaveLength(2);
  });

  it("rejects images injected by the final payload hook before stream transport", async () => {
    setXaiRuntimeModels([textOnlyEntitlement]);
    const baseFetch = globalThis.fetch;
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        sessionId: "text-only-hook",
        onPayload(payload: any) {
          payload.input = [
            {
              role: "user",
              content: [{ type: "input_image", image_url: "https://example.test/hook-private.png" }],
            },
          ];
        },
      } as any,
    );
    const result = await stream.result();
    expect(result.errorMessage).toMatch(/explicitly text-only.*no xAI request was sent/);
    expect(result.errorMessage).not.toContain("hook-private.png");
    expect(requests).toHaveLength(0);
    expect(globalThis.fetch).toBe(baseFetch);
  });

  it("rejects a stream image exposed by a custom serializer before fetch", async () => {
    setXaiRuntimeModels([textOnlyEntitlement]);
    let serializerCalls = 0;
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        sessionId: "serializer-hook",
        onPayload() {
          return {
            model: "grok-4.5",
            input: "apparent text",
            toJSON() {
              serializerCalls++;
              return {
                model: "grok-4.5",
                input: [{
                  role: "user",
                  content: [{
                    type: "input_image",
                    image_url: "https://example.test/hook-serializer-private.png",
                  }],
                }],
              };
            },
          };
        },
      } as any,
    );
    const result = await stream.result();
    expect(serializerCalls).toBe(1);
    expect(result.errorMessage).toMatch(/explicitly text-only.*no xAI request was sent/);
    expect(result.errorMessage).not.toContain("hook-serializer-private.png");
    expect(requests).toHaveLength(0);
  });

  it("rejects payload hooks that change the selected model before fetch", async () => {
    const alternateTextOnly = {
      ...KNOWN_XAI_MODEL_METADATA[1],
      input: ["text"] as ["text"],
      inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
    };
    setXaiRuntimeModels([authenticatedImageEntitlement, alternateTextOnly]);
    const baseFetch = globalThis.fetch;
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        sessionId: "model-hook",
        onPayload(payload: any, hookModel: any) {
          payload.model = alternateTextOnly.id;
          hookModel.id = alternateTextOnly.id;
          payload.input = [
            {
              role: "user",
              content: [{ type: "input_image", image_url: "https://example.test/private.png" }],
            },
          ];
        },
      } as any,
    );

    const result = await stream.result();
    expect(result.errorMessage).toMatch(/payload hooks cannot change the selected model/);
    expect(result.errorMessage).not.toContain(alternateTextOnly.id);
    expect(requests).toHaveLength(0);
    expect(globalThis.fetch).toBe(baseFetch);
  });

  it("rejects a model change exposed only by a custom serializer", async () => {
    const alternate = KNOWN_XAI_MODEL_METADATA[1];
    setXaiRuntimeModels([authenticatedImageEntitlement, alternate]);
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        sessionId: "model-serializer-hook",
        onPayload() {
          return {
            model: "grok-4.5",
            input: "apparent text",
            toJSON() {
              return { model: alternate.id, input: "canonical text" };
            },
          };
        },
      } as any,
    );
    const result = await stream.result();
    expect(result.errorMessage).toBe(
      "xAI OAuth payload hooks cannot change the selected model; no xAI request was sent",
    );
    expect(requests).toHaveLength(0);
  });

  it("rejects both computer screenshot reference forms before fetch", async () => {
    setXaiRuntimeModels([textOnlyEntitlement]);
    await expect(
      createXaiResponse(
        { kind: "oauth-session", token: "oauth-token" },
        {
          model: "grok-4.5",
          input: [{
            type: "computer_call_output",
            call_id: "call_file",
            output: { type: "computer_screenshot", file_id: "file_private" },
          }],
        },
      ),
    ).rejects.toThrow(/explicitly text-only.*no xAI request was sent/);

    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          payload.input = [{
            type: "computer_call_output",
            call_id: "call_url",
            output: {
              type: "computer_screenshot",
              image_url: "https://example.test/screenshot-private.png",
            },
          }];
        },
      } as any,
    );
    const result = await stream.result();
    expect(result.errorMessage).toMatch(/explicitly text-only.*no xAI request was sent/);
    expect(result.errorMessage).not.toContain("screenshot-private.png");
    expect(requests).toHaveLength(0);
  });

  it("uses the canonical runtime model ID in text-only errors", async () => {
    setXaiRuntimeModels([textOnlyEntitlement]);
    const aliasModel = { ...TEST_MODEL, id: "xai-auth/grok-4.5" } as any;
    const stream = streamSimpleXaiResponses(
      aliasModel,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          payload.input = [{
            role: "user",
            content: [{ type: "input_image", image_url: "https://example.test/private.png" }],
          }];
        },
      } as any,
    );
    const result = await stream.result();
    expect(result.errorMessage).toBe(
      "xAI OAuth model grok-4.5 is explicitly text-only in the authenticated model catalog; no xAI request was sent",
    );
    expect(result.errorMessage).not.toContain("xai-auth/");
    expect(requests).toHaveLength(0);
  });

  it("rechecks the current entitlement after an asynchronous hook", async () => {
    setXaiRuntimeModels([authenticatedImageEntitlement]);
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        async onPayload(payload: any) {
          payload.input = [{
            role: "user",
            content: [{
              type: "input_image",
              image_url: "https://example.test/entitlement-race-private.png",
            }],
          }];
          await Promise.resolve();
          setXaiRuntimeModels([]);
        },
      } as any,
    );
    const result = await stream.result();
    expect(result.errorMessage).not.toContain("entitlement-race-private.png");
    expect(requests).toHaveLength(0);
  });

  it("allows a payload hook to remove image input before the final guard", async () => {
    setXaiRuntimeModels([textOnlyEntitlement]);
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
            timestamp: Date.now(),
          },
        ],
      } as any,
      {
        apiKey: "oauth-token",
        sessionId: "remove-image-hook",
        onPayload(payload: any) {
          payload.input = "image removed";
        },
      } as any,
    );
    await stream.result();
    expect(requests).toHaveLength(1);
    expect(requests[0].body.input).toBe("image removed");
  });

  it("transports a benign stream custom serializer's inert result", async () => {
    let serializerCalls = 0;
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload() {
          return {
            model: "grok-4.5",
            toJSON() {
              serializerCalls++;
              return { model: "grok-4.5", input: "canonical stream text" };
            },
          };
        },
      } as any,
    );
    await stream.result();
    expect(serializerCalls).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({
      model: "grok-4.5",
      input: "canonical stream text",
    });
    expect(requests[0].body).not.toHaveProperty("toJSON");
  });

  it("compacts direct helper images before transport", async () => {
    await createXaiResponse(
      { kind: "oauth-session", token: "oauth-token" },
      { model: "grok-4.5", input },
    );
    const body = requests.at(-1).body;
    expect(bytes(body)).toBeLessThanOrEqual(MAX_XAI_INLINE_IMAGE_BASE64_BYTES);
    expect(images(body)).not.toContain(oversized);
  });
  it("compacts provider stream images before transport", async () => {
    const data = oversized.split(",")[1];
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "image", data, mimeType: "image/jpeg" },
              { type: "image", data, mimeType: "image/jpeg" },
            ],
            timestamp: Date.now(),
          },
        ],
      } as any,
      { apiKey: "oauth-token", sessionId: "image-session" } as any,
    );
    await stream.result();
    const body = requests.find(({ url }) => url.endsWith("/responses")).body;
    expect(bytes(body)).toBeLessThanOrEqual(MAX_XAI_INLINE_IMAGE_BASE64_BYTES);
    expect(images(body)).not.toContain(oversized);
  }, 30_000);
  it("compacts in-place payload-hook mutations", async () => {
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      {
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      } as any,
      {
        apiKey: "oauth-token",
        sessionId: "hook",
        onPayload(payload: any) {
          payload.input = input;
        },
      } as any,
    );
    await stream.result();
    const body = requests.find(({ url }) => url.endsWith("/responses")).body;
    expect(bytes(body)).toBeLessThanOrEqual(MAX_XAI_INLINE_IMAGE_BASE64_BYTES);
  }, 30_000);
});
