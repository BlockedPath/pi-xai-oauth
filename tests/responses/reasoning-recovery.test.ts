import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURATED_FALLBACK_MODELS,
  KNOWN_XAI_MODEL_METADATA,
  setXaiRuntimeModels,
} from "../../extensions/xai/models";
import { streamSimpleXaiResponses } from "../../extensions/xai/responses";
import { XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE } from "../../extensions/xai/wire";
import { headerValue, jsonResponse, requestBody } from "../fixtures/http";
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
  it.each(["http", "sse", "sse-http-400"] as const)("retries a %s mismatch in the same turn without exposing the failed attempt", async (transport) => {
    const requests: any[] = [];
    const responses = [
      transport === "http"
        ? jsonResponse({ error: { message: "HTTP_SECRET encrypted_content belongs to another model" } }, 400)
        : sse([
            { type: "response.created", response: { id: "resp_rejected" } },
            failedEvent(
              transport === "sse" ? "invalid_request" : "server_error",
              `${transport === "sse" ? "" : "HTTP 400 "}STREAM_SECRET encrypted_content belongs to another model`,
            ),
          ]),
      sse([completedEvent("resp_same_turn")]),
    ];
    const headers: Array<HeadersInit | undefined> = [];
    const fetchMock = vi.fn(async (_url: any, init: RequestInit = {}) => {
      requests.push(requestBody(init));
      headers.push(init.headers);
      expect(init.redirect).toBe("error");
      return responses.shift()!;
    });
    vi.stubGlobal("fetch", fetchMock);
    const stream = streamSimpleXaiResponses(
      model("grok-4.6"),
      { messages: [...priorToolHistory("xai-responses"), { role: "user", content: "continue", timestamp: 4 }] } as any,
      { apiKey: "oauth-token", sessionId: "issue-220" } as any,
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(result).toMatchObject({ stopReason: "stop", responseId: "resp_same_turn" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(inputTypes(requests[0])).toContain("reasoning");
    expectVisibleToolHistory(requests[1]);
    expect(JSON.stringify(requests[1])).not.toContain(encryptedContent);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(result.usage).toMatchObject({ input: 2, output: 1, totalTokens: 3 });
    expect(JSON.stringify(events)).not.toMatch(/resp_rejected|STREAM_SECRET|HTTP_SECRET/);
    expect(requests[1]).toMatchObject({ store: false, include: ["reasoning.encrypted_content"] });
    expect(headerValue(headers[0], "x-grok-req-id")).not.toBe(headerValue(headers[1], "x-grok-req-id"));
    for (const sentHeaders of headers) {
      expect(headerValue(sentHeaders, "x-grok-session-id")).toBe("issue-220");
      expect(headerValue(sentHeaders, "x-grok-conv-id")).toBe("issue-220");
      expect(headerValue(sentHeaders, "x-grok-model-override")).toBe("grok-4.6");
    }
  });

  it("strips hook-reintroduced reasoning and leaves caller history and later replay unchanged", async () => {
    const history = priorToolHistory("openai-responses");
    const snapshot = JSON.stringify(history);
    const requests: any[] = [];
    const responses = [
      sse([failedEvent("invalid_request", "encrypted_content rejected")]),
      sse([completedEvent("resp_recovered")]),
      sse([completedEvent("resp_next")]),
    ];
    const fetchMock = vi.fn(async (_url: any, init: RequestInit = {}) => {
      requests.push(requestBody(init));
      return responses.shift()!;
    });
    vi.stubGlobal("fetch", fetchMock);
    const onPayload = vi.fn((payload: any) => ({
      ...payload,
      input: [...payload.input, { ...reasoningItem, id: "rs_hook" }],
      store: true,
      include: ["other", "reasoning.encrypted_content", "other"],
    }));
    const recovered = await streamSimpleXaiResponses(
      model("grok-4.6"), { messages: history } as any, { apiKey: "token", onPayload },
    ).result();

    expect(recovered.stopReason).toBe("stop");
    expect(onPayload).toHaveBeenCalledTimes(2);
    expect(inputTypes(requests[0]).filter((type) => type === "reasoning")).toHaveLength(2);
    expect(inputTypes(requests[1])).not.toContain("reasoning");
    expect(requests[1]).toMatchObject({ store: true, include: ["other", "reasoning.encrypted_content"] });
    expect(JSON.stringify(history)).toBe(snapshot);

    await streamSimpleXaiResponses(
      model("grok-4.6"),
      { messages: [...history, recovered, { role: "user", content: "continue", timestamp: 5 }] } as any,
      { apiKey: "token" },
    ).result();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requests[2].input.find((item: any) => item.type === "reasoning")).toEqual(reasoningItem);
  });

  it.each([400, 401, 429, 500])("stops after a sanitized retry fails with HTTP %s", async (status) => {
    const requests: any[] = [];
    const fetchMock = vi.fn(async (_url: any, init: RequestInit = {}) => {
      requests.push(requestBody(init));
      return requests.length === 1
        ? sse([failedEvent("invalid_request", "FIRST_SECRET encrypted_content rejected")])
        : jsonResponse({ error: { message: "RETRY_SECRET encrypted_content rejected" } }, status);
    });
    vi.stubGlobal("fetch", fetchMock);
    const stream = streamSimpleXaiResponses(
      model("grok-4.6"), { messages: priorToolHistory("xai-responses") } as any, { apiKey: "token", maxRetries: 5 },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(inputTypes(requests[1])).not.toContain("reasoning");
    if (status === 400) expect(result.errorMessage).toBe(XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE);
    else expect(result.errorMessage).toContain(`status ${status}`);
    expect(result.stopReason).toBe("error");
    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(JSON.stringify(events)).not.toMatch(/FIRST_SECRET|RETRY_SECRET|encrypted_content/);
  });

  it("reports an unrelated HTTP failure from the sanitized retry", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      requests++;
      return requests === 1
        ? sse([failedEvent("invalid_request", "encrypted_content rejected")])
        : jsonResponse({ error: { message: "PRIVATE_SERVICE_DETAIL" } }, 503);
    }));

    const result = await streamSimpleXaiResponses(
      model("grok-4.6"), { messages: priorToolHistory("xai-responses") } as any, { apiKey: "token" },
    ).result();

    expect(requests).toBe(2);
    expect(result.errorMessage).toContain("status 503");
    expect(result.errorMessage).not.toBe(XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE);
    expect(result.errorMessage).not.toContain("PRIVATE_SERVICE_DETAIL");
  });

  it.each(["xai-responses", "openai-responses"] as const)(
    "remembers rejected reasoning across persisted %s service and catalog failures",
    async (sourceApi) => {
      const requests: any[] = [];
      const responses = [
        sse([failedEvent("invalid_request", "encrypted_content rejected")]),
        jsonResponse({ error: { message: "PRIVATE_SERVICE_DETAIL" } }, 503),
        jsonResponse({ error: { message: "PRIVATE_SERVICE_DETAIL" } }, 503),
        sse([completedEvent("resp_recovered")]),
      ];
      const fetchMock = vi.fn(async (_url: any, init: RequestInit = {}) => {
        requests.push(requestBody(init));
        return responses.shift()!;
      });
      vi.stubGlobal("fetch", fetchMock);
      let history = priorToolHistory(sourceApi);

      for (let turn = 0; turn < 3; turn++) {
        const result = await streamSimpleXaiResponses(
          model("grok-4.6"), { messages: history } as any, { apiKey: "token" },
        ).result();
        if (turn < 2) {
          expect(result.errorMessage).toContain("status 503");
          expect(JSON.stringify(result)).not.toContain("PRIVATE_SERVICE_DETAIL");
          history = JSON.parse(JSON.stringify([
            ...history,
            { ...result, api: sourceApi },
            { role: "user", content: "try again", timestamp: 5 + turn },
          ]));
          if (turn === 0) {
            setXaiRuntimeModels([]);
            const unavailable = await streamSimpleXaiResponses(
              model("grok-4.6"), { messages: history } as any, { apiKey: "token" },
            ).result();
            expect(unavailable.errorMessage).toContain("not present in the authenticated model catalog");
            expect(fetchMock).toHaveBeenCalledTimes(2);
            history = JSON.parse(JSON.stringify([
              ...history,
              { ...unavailable, api: sourceApi },
              { role: "user", content: "try after catalog recovery", timestamp: 6 },
            ]));
            setXaiRuntimeModels(KNOWN_XAI_MODEL_METADATA);
          }
        } else {
          expect(result).toMatchObject({ stopReason: "stop", responseId: "resp_recovered" });
        }
      }

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(inputTypes(requests[0])).toContain("reasoning");
      for (const request of requests.slice(1)) {
        expect(inputTypes(request)).not.toContain("reasoning");
        expect(JSON.stringify(request.input)).toContain("visible tool output");
        expect(JSON.stringify(request.input)).toContain("I will inspect it.");
      }
    },
  );

  it.each(["text", "thinking", "toolcall"] as const)("does not retry after forwarding %s content", async (kind) => {
    const item = kind === "text"
      ? { type: "message", id: "msg_partial", role: "assistant", content: [] }
      : kind === "thinking"
        ? { type: "reasoning", id: "rs_partial", summary: [] }
        : { type: "function_call", id: "fc_partial", call_id: "call_partial", name: "read_file", arguments: "" };
    const delta = kind === "text"
      ? { type: "response.output_text.delta", delta: "partial text" }
      : kind === "thinking"
        ? { type: "response.reasoning_summary_text.delta", delta: "partial thinking" }
        : { type: "response.function_call_arguments.delta", delta: "{\"path\":" };
    const fetchMock = vi.fn(async () => sse([
      { type: "response.output_item.added", output_index: 0, item },
      // Pi 0.80 needs the real protocol's part-added event before deltas.
      ...(kind === "text" ? [{
        type: "response.content_part.added", output_index: 0, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }] : kind === "thinking" ? [{
        type: "response.reasoning_summary_part.added", output_index: 0, summary_index: 0,
        part: { type: "summary_text", text: "" },
      }] : []),
      { ...delta, output_index: 0 },
      failedEvent("invalid_request", "STREAM_SECRET encrypted_content rejected"),
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const stream = streamSimpleXaiResponses(
      model("grok-4.6"), { messages: priorToolHistory("xai-responses") } as any, { apiKey: "token" },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(["start", `${kind}_start`, `${kind}_delta`, "error"]);
    expect(result.content).toHaveLength(1);
    expect(result.errorMessage).toBe(XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE);
  });

  it.each(["none", "cross-model", "cross-provider", "cross-api", "hook-removed", "already-omitted"])(
    "does not retry when replayable reasoning was not sent (%s)", async (scenario) => {
      let history = priorToolHistory("xai-responses");
      if (scenario === "none") history = [history[0]];
      if (scenario === "cross-model") history[1].model = "grok-4.5";
      if (scenario === "cross-provider") history[1].provider = "other-provider";
      if (scenario === "cross-api") history[1].api = "other-api";
      if (scenario === "already-omitted") history.push({
        ...history[1], content: [], stopReason: "error", errorMessage: XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE,
      });
      let sent: any;
      const fetchMock = vi.fn(async (_url: any, init: RequestInit = {}) => {
        sent = requestBody(init);
        return sse([failedEvent("invalid_request", "encrypted_content rejected")]);
      });
      vi.stubGlobal("fetch", fetchMock);
      const result = await streamSimpleXaiResponses(
        model("grok-4.6"), { messages: history } as any,
        {
          apiKey: "token",
          onPayload: scenario === "hook-removed"
            ? (payload: any) => ({ ...payload, input: payload.input.filter((item: any) => item.type !== "reasoning") })
            : undefined,
        },
      ).result();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(inputTypes(sent)).not.toContain("reasoning");
      expect(sent.include).toContain("reasoning.encrypted_content");
      expect(result.errorMessage).toBe(XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE);
    },
  );

  it.each([400, 429, 500])("does not blindly retry an unrelated HTTP %s", async (status) => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "UNRELATED_SECRET" } }, status));
    vi.stubGlobal("fetch", fetchMock);
    const result = await streamSimpleXaiResponses(
      model("grok-4.6"), { messages: priorToolHistory("xai-responses") } as any, { apiKey: "token", maxRetries: 5 },
    ).result();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.errorMessage).toBe(`xAI API error: Responses failed with status ${status}`);
  });

  it.each(["before", "between", "during-retry"])("preserves cancellation %s attempts", async (timing) => {
    const controller = new AbortController();
    const requests: any[] = [];
    const fetchMock = vi.fn(async (_url: any, init: RequestInit = {}) => {
      requests.push(requestBody(init));
      if (timing === "between" || requests.length === 2) controller.abort();
      if (requests.length === 2) {
        expect(init.signal?.aborted).toBe(true);
        throw new DOMException("ABORT_SECRET", "AbortError");
      }
      return sse([failedEvent("invalid_request", "encrypted_content rejected")]);
    });
    vi.stubGlobal("fetch", fetchMock);
    if (timing === "before") controller.abort();
    const result = await streamSimpleXaiResponses(
      model("grok-4.6"), { messages: priorToolHistory("xai-responses") } as any,
      { apiKey: "token", signal: controller.signal },
    ).result();

    expect(fetchMock).toHaveBeenCalledTimes(timing === "before" ? 0 : timing === "between" ? 1 : 2);
    expect(result.stopReason).toBe("aborted");
    // The mock may still deliver mismatch text after aborting. The terminal
    // reason must remain aborted even when that text is safely classified.
    expect(result.errorMessage).not.toContain("ABORT_SECRET");
  });

  it("stops before the retry request if its payload hook cancels", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => sse([failedEvent("invalid_request", "encrypted_content rejected")]));
    vi.stubGlobal("fetch", fetchMock);
    let attempts = 0;
    const result = await streamSimpleXaiResponses(
      model("grok-4.6"), { messages: priorToolHistory("xai-responses") } as any,
      { apiKey: "token", signal: controller.signal, onPayload() { if (++attempts === 2) controller.abort(); } },
    ).result();
    expect(attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("aborted");
  });

  it("forwards successful retry content using only the retry's tool routes", async () => {
    const text = { type: "message", id: "msg_retry", role: "assistant", content: [{ type: "output_text", text: "Recovered." }] };
    const tool = { type: "function_call", id: "fc_retry", call_id: "call_retry", name: "read_file", arguments: "{}" };
    const responses = [
      sse([failedEvent("invalid_request", "encrypted_content rejected")]),
      sse([
        { type: "response.output_item.added", output_index: 0, item: { ...text, content: [] } },
        {
          type: "response.content_part.added", output_index: 0, content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        { type: "response.output_text.delta", output_index: 0, delta: "Recovered." },
        { type: "response.output_item.done", output_index: 0, item: text },
        { type: "response.output_item.added", output_index: 1, item: tool },
        { type: "response.output_item.done", output_index: 1, item: tool },
        completedEvent("resp_retry_content"),
      ]),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    let attempts = 0;
    const stream = streamSimpleXaiResponses(
      model("grok-4.6"), { messages: priorToolHistory("xai-responses") } as any,
      {
        apiKey: "token",
        onPayload(payload: any) {
          return { ...payload, tools: [{ type: "function", name: ++attempts === 1 ? "xai_grok_read_file" : "read_file", parameters: {} }] };
        },
      },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual([
      "start", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_end", "done",
    ]);
    expect(result).toMatchObject({ stopReason: "toolUse", responseId: "resp_retry_content" });
    expect(result.content).toMatchObject([{ type: "text", text: "Recovered." }, { type: "toolCall", name: "read_file" }]);
    expect(events.find((event) => event.type === "toolcall_end")?.toolCall.name).toBe("read_file");
  });

  it("revalidates the catalog before sending the sanitized retry", async () => {
    const fetchMock = vi.fn(async () => {
      setXaiRuntimeModels([]);
      return sse([failedEvent("invalid_request", "encrypted_content rejected")]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onPayload = vi.fn();
    const result = await streamSimpleXaiResponses(
      model("grok-4.6"), { messages: priorToolHistory("xai-responses") } as any,
      { apiKey: "token", onPayload },
    ).result();
    expect(onPayload).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toBe(XAI_ENCRYPTED_CONTENT_MISMATCH_MESSAGE);
  });

  it.each(["xai-responses", "openai-responses"] as const)(
    "bounds a failed retry and recovers next-turn same-model history tagged %s",
    async (sourceApi) => {
      const requests: any[] = [];
      const responses = [
        sse([
          failedEvent(
            "invalid_request",
            "STREAM_SECRET encrypted_content belongs to another model",
          ),
        ]),
        sse([failedEvent("invalid_request", "RETRY_SECRET encrypted_content still rejected")]),
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

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(inputTypes(requests[1])).not.toContain("reasoning");
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
        /STREAM_SECRET|RETRY_SECRET|encrypted_content|invalid_request/,
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

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(recovered).toMatchObject({
        stopReason: "stop",
        responseId: "resp_recovered",
      });
      expectVisibleToolHistory(requests[2]);
      expect(
        requests[2].input.some((item: any) => item.type === "reasoning"),
      ).toBe(false);
      expect(requests[2]).toMatchObject({
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
      sse([failedEvent("server_error", "HTTP 400 RETRY_SECRET encrypted_content still rejected")]),
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

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(inputTypes(requests[1])).not.toContain("reasoning");
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

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recovered).toMatchObject({
      stopReason: "stop",
      responseId: "resp_recovered_400",
    });
    expectVisibleToolHistory(requests[2]);
    expect(
      requests[2].input.some((item: any) => item.type === "reasoning"),
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

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(restored).toMatchObject({
      stopReason: "stop",
      responseId: "resp_reasoning_restored",
    });
    expect(
      requests[3].input.find((item: any) => item.type === "reasoning"),
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
