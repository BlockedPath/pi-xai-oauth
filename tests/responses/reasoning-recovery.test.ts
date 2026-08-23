import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURATED_FALLBACK_MODELS,
  KNOWN_XAI_MODEL_METADATA,
  setXaiRuntimeModels,
} from "../../extensions/xai/models";
import { streamSimpleXaiResponses } from "../../extensions/xai/responses";
import { XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE } from "../../extensions/xai/wire";
import { requestBody } from "../fixtures/http";
import { TEST_MODEL } from "../fixtures/models";

const encryptedContent = "opaque-rejected-reasoning";
const reasoningItem = {
  id: "rs_prior",
  type: "reasoning",
  summary: [],
  encrypted_content: encryptedContent,
  status: "completed",
};
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(modelId: string) {
  return { ...TEST_MODEL, id: modelId } as any;
}

function priorToolHistory(
  api: "xai-responses" | "openai-responses",
  modelId = "grok-4.6",
) {
  return [
    { role: "user", content: "inspect the project", timestamp: 1 },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: JSON.stringify(reasoningItem),
        },
        {
          type: "text",
          text: "I will inspect it.",
          textSignature: "msg_prior",
        },
        {
          type: "toolCall",
          id: "call_prior|fc_prior",
          name: "read_file",
          arguments: { path: "README.md" },
        },
      ],
      api,
      provider: "xai-auth",
      model: modelId,
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call_prior|fc_prior",
      toolName: "read_file",
      content: [{ type: "text", text: "visible tool output" }],
      isError: false,
      timestamp: 3,
    },
  ] as any[];
}

function sse(events: unknown[]) {
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function failedEvent(code: string, message: string) {
  return {
    type: "response.failed",
    response: {
      status: "failed",
      error: { code, message },
    },
  };
}

function completedEvent(id: string) {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: [],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    },
  };
}

function inputTypes(body: any): string[] {
  return body.input.map((item: any) => item.type ?? item.role);
}

function expectVisibleToolHistory(body: any) {
  expect(inputTypes(body)).toEqual([
    "user",
    "message",
    "function_call",
    "function_call_output",
    "user",
  ]);
  expect(JSON.stringify(body.input)).toContain("I will inspect it.");
  expect(JSON.stringify(body.input)).toContain("visible tool output");
}

beforeEach(() => setXaiRuntimeModels(KNOWN_XAI_MODEL_METADATA));
afterEach(() => setXaiRuntimeModels(CURATED_FALLBACK_MODELS));

describe("encrypted reasoning stream recovery", () => {
  it.each(["xai-responses", "openai-responses"] as const)(
    "classifies a streamed mismatch and recovers same-model history tagged %s",
    async (sourceApi) => {
      const requests: any[] = [];
      const responses = [
        sse([
          failedEvent(
            "invalid_request",
            "STREAM_SECRET encrypted_content belongs to another model",
          ),
        ]),
        sse([completedEvent("resp_recovered")]),
      ];
      const fetchMock = vi.fn(async (_url: any, init: RequestInit = {}) => {
        requests.push(requestBody(init));
        return responses.shift()!;
      });
      vi.stubGlobal("fetch", fetchMock);
      const selectedModel = model("grok-4.6");
      const history = priorToolHistory(sourceApi);

      const first = streamSimpleXaiResponses(
        selectedModel,
        { messages: history } as any,
        { apiKey: "oauth-token", sessionId: "issue-188" } as any,
      );
      const failure = await first.result();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(inputTypes(requests[0])).toContain("reasoning");
      expect(
        requests[0].input.find((item: any) => item.type === "reasoning"),
      ).toEqual(reasoningItem);
      expect(failure).toMatchObject({
        api: "xai-responses",
        provider: "xai-auth",
        model: "grok-4.6",
        stopReason: "error",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
      });
      expect(failure).not.toHaveProperty("responseId");
      expect(failure.errorMessage).toMatch(
        /Start a clean session or turn using the same xAI model/,
      );
      expect(failure.errorMessage).not.toMatch(
        /STREAM_SECRET|encrypted_content|invalid_request/,
      );

      const second = streamSimpleXaiResponses(
        selectedModel,
        {
          messages: [
            ...history,
            failure,
            { role: "user", content: "continue", timestamp: 5 },
          ],
        } as any,
        { apiKey: "oauth-token", sessionId: "issue-188" } as any,
      );
      const recovered = await second.result();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(recovered).toMatchObject({
        stopReason: "stop",
        responseId: "resp_recovered",
      });
      expectVisibleToolHistory(requests[1]);
      expect(
        requests[1].input.some((item: any) => item.type === "reasoning"),
      ).toBe(false);
      expect(requests[1]).toMatchObject({
        store: false,
        include: ["reasoning.encrypted_content"],
      });
    },
  );

  it.each(["xai-responses", "openai-responses"] as const)(
    "keeps cross-model replay protection for history tagged %s",
    async (sourceApi) => {
      let sent: any;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: any, init: RequestInit = {}) => {
          sent = requestBody(init);
          return sse([completedEvent("resp_switched")]);
        }),
      );

      const result = await streamSimpleXaiResponses(
        model("grok-4.5"),
        {
          messages: [
            ...priorToolHistory(sourceApi, "grok-4.6"),
            {
              role: "user",
              content: "continue on the other model",
              timestamp: 4,
            },
          ],
        } as any,
        { apiKey: "oauth-token", sessionId: "issue-188-switch" } as any,
      ).result();

      expect(result).toMatchObject({
        stopReason: "stop",
        responseId: "resp_switched",
      });
      expectVisibleToolHistory(sent);
      expect(sent.input.some((item: any) => item.type === "reasoning")).toBe(
        false,
      );
    },
  );

  it("classifies a streamed mismatch from text-extracted HTTP 400 without an invalid_request code", async () => {
    const requests: any[] = [];
    const responses = [
      sse([
        failedEvent(
          "server_error",
          "HTTP 400 STREAM_SECRET encrypted_content belongs to another model",
        ),
      ]),
      sse([completedEvent("resp_recovered_400")]),
      sse([completedEvent("resp_reasoning_restored")]),
    ];
    const fetchMock = vi.fn(async (_url: any, init: RequestInit = {}) => {
      requests.push(requestBody(init));
      return responses.shift()!;
    });
    vi.stubGlobal("fetch", fetchMock);
    const selectedModel = model("grok-4.6");
    const history = priorToolHistory("openai-responses");

    const failure = await streamSimpleXaiResponses(
      selectedModel,
      { messages: history } as any,
      { apiKey: "oauth-token", sessionId: "issue-191" } as any,
    ).result();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      requests[0].input.find((item: any) => item.type === "reasoning"),
    ).toEqual(reasoningItem);
    expect(failure).toMatchObject({
      provider: "xai-auth",
      model: "grok-4.6",
      stopReason: "error",
    });
    expect(failure.errorMessage).toBe(XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE);
    expect(failure.errorMessage).not.toMatch(
      /STREAM_SECRET|encrypted_content|server_error|400/,
    );

    const recovered = await streamSimpleXaiResponses(
      selectedModel,
      {
        messages: [
          ...history,
          failure,
          { role: "user", content: "continue", timestamp: 5 },
        ],
      } as any,
      { apiKey: "oauth-token", sessionId: "issue-191" } as any,
    ).result();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recovered).toMatchObject({
      stopReason: "stop",
      responseId: "resp_recovered_400",
    });
    expectVisibleToolHistory(requests[1]);
    expect(
      requests[1].input.some((item: any) => item.type === "reasoning"),
    ).toBe(false);

    const restored = await streamSimpleXaiResponses(
      selectedModel,
      {
        messages: [
          ...history,
          failure,
          { role: "user", content: "continue", timestamp: 5 },
          recovered,
          { role: "user", content: "keep going", timestamp: 7 },
        ],
      } as any,
      { apiKey: "oauth-token", sessionId: "issue-191" } as any,
    ).result();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(restored).toMatchObject({
      stopReason: "stop",
      responseId: "resp_reasoning_restored",
    });
    expect(
      requests[2].input.find((item: any) => item.type === "reasoning"),
    ).toEqual(reasoningItem);
  });

  it("does not clear reasoning after an unrelated streamed failure and preserves numeric status text", async () => {
    const requests: any[] = [];
    const responses = [
      sse([
        failedEvent(
          "server_error",
          "HTTP 429 transient encrypted_content observer STREAM_SECRET",
        ),
      ]),
      sse([completedEvent("resp_after_transient")]),
    ];
    const fetchMock = vi.fn(async (_url: any, init: RequestInit = {}) => {
      requests.push(requestBody(init));
      return responses.shift()!;
    });
    vi.stubGlobal("fetch", fetchMock);
    const selectedModel = model("grok-4.6");
    const history = priorToolHistory("openai-responses");

    const failure = await streamSimpleXaiResponses(
      selectedModel,
      { messages: history } as any,
      { apiKey: "oauth-token", sessionId: "issue-188-transient" } as any,
    ).result();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failure.errorMessage).toBe(
      "xAI API error: Responses failed with status 429",
    );
    expect(failure.errorMessage).not.toMatch(
      /STREAM_SECRET|encrypted_content|server_error/,
    );

    const result = await streamSimpleXaiResponses(
      selectedModel,
      {
        messages: [
          ...history,
          failure,
          { role: "user", content: "continue", timestamp: 5 },
        ],
      } as any,
      { apiKey: "oauth-token", sessionId: "issue-188-transient" } as any,
    ).result();

    expect(result).toMatchObject({
      stopReason: "stop",
      responseId: "resp_after_transient",
    });
    expect(
      requests[1].input.find((item: any) => item.type === "reasoning"),
    ).toEqual(reasoningItem);
  });
});
