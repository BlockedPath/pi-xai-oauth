import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerApiProvider,
  resetApiProviders,
  streamSimple,
} from "@earendil-works/pi-ai/compat";
import {
  XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME,
} from "../../extensions/xai/constants";
import {
  CURATED_FALLBACK_MODELS,
  KNOWN_XAI_MODEL_METADATA,
  setXaiRuntimeModels,
} from "../../extensions/xai/models";
import { streamSimpleXaiResponses } from "../../extensions/xai/responses";
import { jsonResponse } from "../fixtures/http";
import { TEST_MODEL } from "../fixtures/models";
beforeEach(() => {
  setXaiRuntimeModels(KNOWN_XAI_MODEL_METADATA);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ id: "resp", output_text: "OK" })),
  );
});
afterEach(() => {
  resetApiProviders();
  setXaiRuntimeModels(CURATED_FALLBACK_MODELS);
});

describe("xAI streaming adapter", () => {
  it("uses Pi's real OpenAI Responses transport for the configured xAI endpoint", async () => {
    const model = {
      ...TEST_MODEL,
      id: "grok-4.3",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    } as any;
    const stream = streamSimple(
      model,
      {
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      } as any,
      { apiKey: "oauth-token" } as any,
    );
    await stream.result();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/api\.x\.ai\/v1\/responses/),
      expect.any(Object),
    );
  });
  it("bypasses conflicting compat registrations and exposes a terminal result", async () => {
    let called = false;
    registerApiProvider(
      {
        api: "openai-responses",
        stream() {
          called = true;
          throw new Error("conflict");
        },
        streamSimple() {
          called = true;
          throw new Error("conflict");
        },
      } as any,
      "test-conflict",
    );
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      {
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      } as any,
      { apiKey: "oauth-token", sessionId: "session" } as any,
    );
    const result = await stream.result();
    expect(called).toBe(false);
    expect(result).toBeDefined();
    expect(result).toMatchObject({
      api: TEST_MODEL.api,
      provider: TEST_MODEL.provider,
      model: TEST_MODEL.id,
    });
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("enforces the OAuth Responses policy after caller payload hooks", async () => {
    let sent: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: RequestInit = {}) => {
      sent = JSON.parse(String(init.body));
      return jsonResponse({ id: "resp", output_text: "OK" });
    }));
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          return {
            ...payload,
            store: true,
            include: ["other", "reasoning.encrypted_content", "other", "reasoning.encrypted_content"],
          };
        },
      } as any,
    );
    await stream.result();

    expect(sent.store).toBe(true);
    expect(sent.include).toEqual(["other", "reasoning.encrypted_content"]);
  });

  it("resolves Grok-native name collisions after caller payload hooks", async () => {
    let sent: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: RequestInit = {}) => {
      sent = JSON.parse(String(init.body));
      return jsonResponse({ id: "resp", output_text: "OK" });
    }));
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          return {
            ...payload,
            tools: [
              { type: "function", name: "read_file", description: "foreign" },
              { type: "function", name: "xai_grok_read_file", description: "xAI" },
              { type: "function", name: "web_search", description: "foreign search" },
            ],
          };
        },
      } as any,
    );
    await stream.result();

    expect(sent.tools).toEqual([
      { type: "function", name: "read_file", description: "xAI" },
      { type: "function", name: "web_search", description: "foreign search" },
    ]);
    expect(JSON.stringify(sent)).not.toContain("xai_grok_read_file");
    expect(JSON.stringify(sent)).not.toContain(XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME);
  });

  it("internalizes streamed Grok tool calls only for dispatchers exposed by that request", async () => {
    const item = {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: "{\"target_file\":\"README.md\"}",
    };
    const terminalResponse = {
      id: "resp",
      status: "completed",
      output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    const events = [
      { type: "response.created", response: { id: "resp" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: item.arguments,
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: terminalResponse },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )));

    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          return {
            ...payload,
            tools: [{ type: "function", name: "xai_grok_read_file", parameters: {} }],
          };
        },
      } as any,
    );
    const foreignStream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload(payload: any) {
          return {
            ...payload,
            tools: [{ type: "function", name: "read_file", parameters: {} }],
          };
        },
      } as any,
    );
    const streamed: any[] = [];
    for await (const event of stream) streamed.push(event);
    const result = await stream.result();
    const foreignResult = await foreignStream.result();

    const start = streamed.find((event) => event.type === "toolcall_start");
    const delta = streamed.find((event) => event.type === "toolcall_delta");
    const end = streamed.find((event) => event.type === "toolcall_end");
    expect(start.partial.content[0].name).toBe("xai_grok_read_file");
    expect(delta.partial.content[0].name).toBe("xai_grok_read_file");
    expect(end.toolCall.name).toBe("xai_grok_read_file");
    expect(end.partial.content[0].name).toBe("xai_grok_read_file");
    expect(result.content[0].name).toBe("xai_grok_read_file");
    expect(foreignResult.content[0].name).toBe("read_file");
  });
  it("returns a local terminal error for an unentitled model without network", async () => {
    setXaiRuntimeModels(CURATED_FALLBACK_MODELS);
    const model = { ...TEST_MODEL, id: "grok-build" } as any;
    const stream = streamSimpleXaiResponses(
      model,
      { messages: [] } as any,
      { apiKey: "token" } as any,
    );
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(
      /not present in the authenticated model catalog/,
    );
    expect(events.at(-1).type).toBe("error");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("forwards an xAI-labeled terminal error when transport throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ code: "internal", error: "Auth context expired." }, 500),
      ),
    );
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      {
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      } as any,
      { apiKey: "oauth-token" } as any,
    );
    const result = await stream.result();
    expect(result.errorMessage).toMatch(/^xAI API error/i);
    expect(result.errorMessage).not.toMatch(/^OpenAI API error/i);
  });

  it("terminates when terminal error rendering also throws", async () => {
    let poisonErrorRendering = false;
    const model = {
      ...TEST_MODEL,
      get api() {
        if (poisonErrorRendering) throw new Error("must not escape the terminal fallback");
        return TEST_MODEL.api;
      },
    } as any;
    const stream = streamSimpleXaiResponses(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as any,
      {
        apiKey: "oauth-token",
        onPayload() {
          poisonErrorRendering = true;
          throw new Error("payload hook failed");
        },
      } as any,
    );
    const events: unknown[] = [];
    const iteration = (async () => {
      for await (const event of stream) events.push(event);
    })();
    await expect(stream.result()).resolves.toBeUndefined();
    await expect(iteration).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });
});
