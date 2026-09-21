import * as PiAi from "@earendil-works/pi-ai";
import type { Context, Tool } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURATED_FALLBACK_MODELS, setXaiRuntimeModels } from "../../extensions/xai/models";
import { streamSimpleXaiResponses } from "../../extensions/xai/responses";
import { TEST_MODEL } from "../fixtures/models";

// Pi <0.86 has no transcript helpers; never import a missing named export.
const normalizeContext = (PiAi as unknown as {
  normalizeContext?: (context: Context) => Context;
}).normalizeContext;
const readTool: Tool = {
  name: "xai_grok_read_file",
  description: "Read a file",
  parameters: { type: "object", properties: {} } as Tool["parameters"],
};
const userMessage = { role: "user" as const, content: "hello", timestamp: 1 };
let requests: Array<Record<string, unknown>>;

beforeEach(() => {
  setXaiRuntimeModels([{ ...CURATED_FALLBACK_MODELS[0], id: TEST_MODEL.id }]);
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit = {}) => {
    requests.push(JSON.parse(String(init.body)));
    const event = { type: "response.completed", response: {
      id: "resp", status: "completed", output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    } };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }));
});
afterEach(() => setXaiRuntimeModels(CURATED_FALLBACK_MODELS));

async function send(context: Context, requestCount = 1) {
  const original = structuredClone(context);
  const stream = streamSimpleXaiResponses(TEST_MODEL, context, { apiKey: "test-token" });
  expect((await stream.result()).stopReason).toBe("stop");
  expect(context).toEqual(original);
  expect(requests).toHaveLength(requestCount);
  return requests.at(-1)!;
}

describe("cross-version Responses context boundary", () => {
  it.each([
    { prompt: "Keep this system instruction", tools: [readTool] },
    { prompt: "Prompt without tools", tools: [] },
    { prompt: undefined, tools: [readTool] },
    { prompt: undefined, tools: [] },
  ])("preserves legacy prompt $prompt and tool declarations", async ({ prompt, tools }) => {
    const sent = await send({ systemPrompt: prompt, tools, messages: [userMessage] });
    if (prompt) expect(sent.instructions).toBe(prompt);
    else expect(sent.instructions ?? "").toBe("");
    expect(sent.tools ?? []).toEqual(tools.length ? [expect.objectContaining({ name: "read_file" })] : []);
  });

  it("accepts an empty legacy context", async () => {
    const sent = await send({ messages: [] });
    expect(sent.input).toEqual([]);
    expect(sent.instructions ?? "").toBe("");
    expect(sent.tools ?? []).toEqual([]);
  });

  // These shapes are produced by Pi 0.86+ only; legacy behavior above is tested
  // unconditionally on the minimum supported Pi version.
  describe.skipIf(!normalizeContext)("native Pi transcript contexts", () => {
    it("does not duplicate already-normalized prompt and tools", async () => {
      const context = normalizeContext!({
        systemPrompt: "Exactly one prompt",
        tools: [readTool],
        messages: [userMessage],
      });
      const sent = await send(context);
      expect(sent.instructions).toBe("Exactly one prompt");
      expect(sent.tools).toEqual([expect.objectContaining({ name: "read_file" })]);
    });

    it.each([false, true])("preserves system/tool deltas across reasoning replay (retry=%s)", async (retry) => {
      if (retry) {
        const respond = globalThis.fetch;
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
          if (requests.length === 0) {
            requests.push(JSON.parse(String(init.body)));
            return new Response(JSON.stringify({ error: { message: "encrypted_content belongs to another model" } }), {
              status: 400, headers: { "content-type": "application/json" },
            });
          }
          return respond(input, init);
        }));
      }
      const reasoning = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "opaque-test" };
      const addedTool = { ...readTool, name: "xai_grok_list_dir" };
      const context = { messages: [
        { role: "system", content: "Base", sections: { policy: "old", remove: "obsolete" }, toolsAdded: [readTool], timestamp: 0 },
        userMessage,
        {
          role: "assistant",
          api: TEST_MODEL.api, provider: TEST_MODEL.provider, model: TEST_MODEL.id,
          content: [{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning) }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", timestamp: 2,
        },
        { role: "system", content: "Update", sections: { policy: "new", remove: null }, toolsRemoved: [{ name: readTool.name }], toolsAdded: [addedTool], timestamp: 3 },
        { ...userMessage, content: "continue", timestamp: 4 },
      ] } as unknown as Context;
      const sent = await send(normalizeContext!(context), retry ? 2 : 1);
      expect(sent.instructions).toContain("Base");
      expect(sent.instructions).toContain("Update");
      expect(sent.instructions).toContain("new");
      expect(sent.instructions).not.toContain("old");
      expect(sent.instructions).not.toContain("obsolete");
      expect(sent.tools).toEqual([expect.objectContaining({ name: "list_dir" })]);
      expect(requests[0].input).toEqual(expect.arrayContaining([reasoning]));
      if (retry) expect(sent.input).not.toEqual(expect.arrayContaining([reasoning]));
      for (const request of requests) {
        expect(request.instructions).toBe(sent.instructions);
        expect(request.tools).toEqual(sent.tools);
        expect(request.include).toContain("reasoning.encrypted_content");
      }
    });
  });
});
