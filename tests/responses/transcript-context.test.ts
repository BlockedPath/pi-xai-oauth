import * as piAi from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURATED_FALLBACK_MODELS,
  KNOWN_XAI_MODEL_METADATA,
  setXaiRuntimeModels,
} from "../../extensions/xai/models";
import { streamSimpleXaiResponses } from "../../extensions/xai/responses";
import { toXaiDelegateContext } from "../../extensions/xai/responses-delegate";
import { jsonResponse, requestBody } from "../fixtures/http";

let requests: Array<{ url: string; body: any }>;

beforeEach(() => {
  requests = [];
  setXaiRuntimeModels(KNOWN_XAI_MODEL_METADATA);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: RequestInit = {}) => {
      requests.push({ url: String(url), body: requestBody(init) });
      return jsonResponse({ id: "resp", output_text: "OK" });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setXaiRuntimeModels(CURATED_FALLBACK_MODELS);
});

function streamModel() {
  return {
    ...KNOWN_XAI_MODEL_METADATA.find(({ id }) => id === "grok-4.6")!,
    provider: "xai-auth",
    api: "xai-responses",
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
    headers: {},
  } as any;
}

describe("delegate transcript context", () => {
  it("delivers a raw Context's system prompt and tools to xAI on every supported Pi", async () => {
    const stream = streamSimpleXaiResponses(
      streamModel(),
      {
        systemPrompt: "Answer tersely.",
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
        tools: [
          {
            name: "lookup_order",
            description: "Look up an order by id",
            parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          },
        ],
      } as any,
      { apiKey: "oauth-token", sessionId: "transcript-session" } as any,
    );
    await stream.result();

    const request = requests.find(({ url }) => url.endsWith("/responses"));
    expect(request).toBeDefined();
    expect(request!.body.instructions).toContain("Answer tersely.");
    expect((request!.body.tools ?? []).map((tool: any) => tool.name)).toContain("lookup_order");
  });

  it("keeps a hybrid context's shorthand prompt and tools on every supported Pi", async () => {
    const stream = streamSimpleXaiResponses(
      streamModel(),
      {
        systemPrompt: "Shorthand prompt.",
        messages: [
          { role: "system", content: "Leading system note.", timestamp: 0 },
          { role: "user", content: "hello", timestamp: Date.now() },
        ],
        tools: [
          {
            name: "lookup_order",
            description: "Look up an order by id",
            parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          },
        ],
      } as any,
      { apiKey: "oauth-token", sessionId: "hybrid-session" } as any,
    );
    await stream.result();

    const request = requests.find(({ url }) => url.endsWith("/responses"));
    expect(request).toBeDefined();
    expect(request!.body.instructions).toContain("Shorthand prompt.");
    expect((request!.body.tools ?? []).map((tool: any) => tool.name)).toContain("lookup_order");
    // Pi 0.86+ replays both system sources into one prompt; earlier delegates read only
    // the shorthand fields and have no system-message role.
    if (typeof (piAi as unknown as Record<string, unknown>).normalizeContext === "function") {
      expect(request!.body.instructions).toContain("Leading system note.");
    }
  });
});

describe("toXaiDelegateContext", () => {
  const user = { role: "user", content: "hi", timestamp: 1 } as const;
  const folded = { messages: [{ role: "system", content: "folded" }, user] };
  const normalize = vi.fn(() => folded as any);

  beforeEach(() => normalize.mockClear());

  it("passes through unchanged when Pi has no normalizeContext (before 0.86)", () => {
    const context = { systemPrompt: "p", messages: [user] } as any;
    expect(toXaiDelegateContext(context, null)).toBe(context);
  });

  it("passes an already normalized transcript through without normalizing again", () => {
    const transcript = { messages: [user] } as any;
    expect(toXaiDelegateContext(transcript, normalize)).toBe(transcript);
    expect(normalize).not.toHaveBeenCalled();
  });

  it("folds a hybrid context like Pi's public streamSimple instead of dropping its shorthand", () => {
    const context = { systemPrompt: "p", messages: [{ role: "system", content: "s" }, user] } as any;
    expect(toXaiDelegateContext(context, normalize)).toBe(folded);
    expect(normalize).toHaveBeenCalledWith(context);
  });

  it("folds a raw Context's systemPrompt or tools when normalizeContext exists", () => {
    const withPrompt = { systemPrompt: "p", messages: [user] } as any;
    const withTools = { tools: [], messages: [user] } as any;
    expect(toXaiDelegateContext(withPrompt, normalize)).toBe(folded);
    expect(toXaiDelegateContext(withTools, normalize)).toBe(folded);
    expect(normalize).toHaveBeenNthCalledWith(1, withPrompt);
    expect(normalize).toHaveBeenNthCalledWith(2, withTools);
  });
});
