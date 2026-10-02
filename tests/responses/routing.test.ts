import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageMetadata from "../../package.json";
import {
  XAI_CLI_RESPONSES_URL,
  XAI_GROK_BUILD_REVIEWED_REVISION,
  XAI_RESPONSES_URL,
  XAI_USER_AGENT,
} from "../../extensions/xai/constants";
import {
  CURATED_FALLBACK_MODELS,
  KNOWN_XAI_MODEL_METADATA,
  setXaiRuntimeModels,
} from "../../extensions/xai/models";
import { resolveXaiClientMode } from "../../extensions/xai/wire";
import {
  createXaiResponse,
  postXaiJson,
  streamSimpleXaiResponses,
} from "../../extensions/xai/responses";
import { headerValue, jsonResponse, requestBody } from "../fixtures/http";
import { TEST_MODEL } from "../fixtures/models";

const modelIds = [
  "grok-4.5",
  "grok-4.3",
  "grok-4.20-0309-reasoning",
  "grok-build",
  "grok-composer-2.5-fast",
];
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const proxyHeaderNames = [
  "x-grok-client-identifier",
  "x-grok-client-version",
  "x-xai-token-auth",
  "x-authenticateresponse",
  "x-grok-client-mode",
  "x-grok-conv-id",
  "x-grok-req-id",
  "x-grok-model-override",
  "x-grok-session-id",
];
const unsupportedProxyHeaderNames = [
  "session_id",
  "x-client-request-id",
  "x-session-id",
  "x-grok-agent-id",
  "x-grok-turn-idx",
  "x-grok-user-id",
  "x-grok-deployment-id",
  "x-grok-unknown-private-id",
];

let requests: Array<{ url: string; init: RequestInit; body: any }>;

beforeEach(() => {
  requests = [];
  setXaiRuntimeModels(KNOWN_XAI_MODEL_METADATA);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: RequestInit = {}) => {
      requests.push({ url: String(url), init, body: requestBody(init) });
      return jsonResponse({ id: "resp", output_text: "OK" });
    }),
  );
});

afterEach(() => setXaiRuntimeModels(CURATED_FALLBACK_MODELS));

function proxyHeaders(request: (typeof requests)[number]) {
  return Object.fromEntries(
    proxyHeaderNames.flatMap((name) => {
      const value = headerValue(request.init.headers, name);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function expectProxy(
  request: (typeof requests)[number],
  modelId: string,
  conversationId: string,
  accept: "application/json" | "text/event-stream",
): string {
  const requestId = headerValue(request.init.headers, "x-grok-req-id") ?? "";
  expect(request.init.method).toBe("POST");
  expect(request.init.redirect).toBe("error");
  expect(request.body.model).toBe(modelId);
  expect(request.url).toBe(XAI_CLI_RESPONSES_URL);
  expect(new URL(request.url).origin).toBe("https://cli-chat-proxy.grok.com");
  expect(headerValue(request.init.headers, "Content-Type")).toBe(
    "application/json",
  );
  expect(headerValue(request.init.headers, "Authorization")).toBe(
    "Bearer oauth-token",
  );
  expect(headerValue(request.init.headers, "Accept")).toBe(accept);
  expect(headerValue(request.init.headers, "User-Agent")).toBe(XAI_USER_AGENT);
  expect(requestId).toMatch(uuid);
  expect(proxyHeaders(request)).toEqual({
    "x-grok-client-identifier": packageMetadata.name,
    "x-grok-client-version": packageMetadata.version,
    "x-xai-token-auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-mode": resolveXaiClientMode(),
    "x-grok-conv-id": conversationId,
    "x-grok-req-id": requestId,
    "x-grok-model-override": modelId,
    "x-grok-session-id": conversationId,
  });
  for (const name of unsupportedProxyHeaderNames) {
    expect(headerValue(request.init.headers, name)).toBeUndefined();
  }
  return requestId;
}

describe("Responses routing and protected metadata", () => {
  it.each(modelIds)(
    "routes stream and direct OAuth requests for %s through the CLI proxy",
    async (modelId) => {
      const catalogModel = KNOWN_XAI_MODEL_METADATA.find(
        ({ id }) => id === modelId,
      )!;
      const model = {
        ...catalogModel,
        provider: "xai-auth",
        api: "xai-responses",
        baseUrl: "https://cli-chat-proxy.grok.com/v1",
        headers: {},
      } as any;
      const sessionId = `stream-${modelId}`;

      const streamStart = requests.length;
      const stream = streamSimpleXaiResponses(
        model,
        {
          messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
        } as any,
        { apiKey: "oauth-token", sessionId } as any,
      );
      await stream.result();
      const streamRequest = requests
        .slice(streamStart)
        .find(({ url }) => url.endsWith("/responses"))!;
      const streamRequestId = expectProxy(
        streamRequest,
        modelId,
        sessionId,
        "text/event-stream",
      );
      expect(streamRequest.body.prompt_cache_key).toBe(sessionId);
      expect(streamRequest.body.store).toBe(false);
      expect(streamRequest.body.include).toEqual(["reasoning.encrypted_content"]);
      if (modelId === "grok-composer-2.5-fast") {
        expect(streamRequest.body.reasoning).toBeUndefined();
      }

      const directStart = requests.length;
      await createXaiResponse(
        { kind: "oauth-session", token: "oauth-token" },
        {
          model: modelId,
          input: "hello",
          previous_response_id: "not-session-metadata",
        },
      );
      const directRequest = requests
        .slice(directStart)
        .find(({ url }) => url.endsWith("/responses"))!;
      const directConversationId =
        headerValue(directRequest.init.headers, "x-grok-conv-id") ?? "";
      expect(directConversationId).toMatch(uuid);
      expect(directConversationId).not.toBe(
        directRequest.body.previous_response_id,
      );
      const directRequestId = expectProxy(
        directRequest,
        modelId,
        directConversationId,
        "application/json",
      );
      expect(directRequestId).not.toBe(streamRequestId);
      expect(directRequest.body.store).toBe(false);
      expect(directRequest.body.include).toEqual(["reasoning.encrypted_content"]);
    },
  );

  it("mints a session UUID and overwrites caller-spoofed authorization and proxy headers", async () => {
    const spoofed = {
      Authorization: "Bearer spoofed",
      "x-grok-client-identifier": "spoofed-client",
      "x-grok-client-version": "999",
      "x-xai-token-auth": "spoofed-mode",
      "x-authenticateresponse": "spoofed-auth",
      "x-grok-client-mode": "spoofed-mode",
      "x-grok-conv-id": "spoofed-conversation",
      "x-grok-req-id": "spoofed-request",
      "x-grok-model-override": "spoofed-model",
      "x-grok-session-id": "spoofed-session",
      session_id: "spoofed-openai-session",
      "x-client-request-id": "spoofed-client-request",
      "x-session-id": "spoofed-openrouter-session",
      "x-grok-agent-id": "spoofed-agent",
      "x-grok-turn-idx": "999",
      "x-grok-user-id": "spoofed-user",
      "x-userid": "spoofed-billing-user",
      "x-grok-deployment-id": "spoofed-deployment",
      "x-grok-unknown-private-id": "spoofed-private",
      Accept: "application/x-spoofed",
      "Content-Type": "application/x-spoofed",
      "User-Agent": "grok-shell/spoofed",
      "X-Custom-Safe": "preserved",
    };
    const model = { ...TEST_MODEL, headers: spoofed } as any;
    const stream = streamSimpleXaiResponses(
      model,
      {
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      } as any,
      { apiKey: "oauth-token", headers: spoofed } as any,
    );
    await stream.result();

    const request = requests.find(({ url }) => url.endsWith("/responses"))!;
    const conversationId =
      headerValue(request.init.headers, "x-grok-conv-id") ?? "";
    expect(conversationId).toMatch(uuid);
    expectProxy(request, "grok-4.5", conversationId, "text/event-stream");
    expect(headerValue(request.init.headers, "X-Custom-Safe")).toBe(
      "preserved",
    );
    expect(headerValue(request.init.headers, "x-userid")).toBeUndefined();
  });

  it.each(["xai-auth/grok-4.5", "XAI-AUTH/GROK-4.5"])(
    "canonicalizes the OAuth model alias %s in body and proxy metadata",
    async (alias) => {
      const aliasModel = { ...TEST_MODEL, id: alias } as any;
      const sessionId = `alias-${alias}`;
      const stream = streamSimpleXaiResponses(
        aliasModel,
        { messages: [{ role: "user", content: "hello", timestamp: 1 }] } as any,
        { apiKey: "oauth-token", sessionId } as any,
      );
      await stream.result();
      const streamRequest = requests.at(-1)!;
      expectProxy(streamRequest, "grok-4.5", sessionId, "text/event-stream");

      await createXaiResponse(
        { kind: "oauth-session", token: "oauth-token" },
        { model: alias, input: "hello" },
      );
      const directRequest = requests.at(-1)!;
      const directConversationId =
        headerValue(directRequest.init.headers, "x-grok-conv-id") ?? "";
      expectProxy(
        directRequest,
        "grok-4.5",
        directConversationId,
        "application/json",
      );
    },
  );

  it("scopes redirect rejection across overlapping xAI streams", async () => {
    const pending: Array<() => void> = [];
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const baseFetch = vi.fn(async (url: any, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      if (String(url) === XAI_CLI_RESPONSES_URL) {
        await new Promise<void>((resolve) => pending.push(resolve));
      }
      return jsonResponse({ id: "resp", output_text: "OK" });
    });
    vi.stubGlobal("fetch", baseFetch);

    const streamA = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "a", timestamp: 1 }] } as any,
      { apiKey: "oauth-token", sessionId: "session-a" } as any,
    );
    const streamB = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "b", timestamp: 2 }] } as any,
      { apiKey: "oauth-token", sessionId: "session-b" } as any,
    );
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    expect(globalThis.fetch).not.toBe(baseFetch);
    await globalThis.fetch("https://example.test/unrelated");
    const unrelated = calls.find(({ url }) => url.includes("unrelated"))!;
    expect(unrelated.init.redirect).toBeUndefined();
    for (const release of pending.splice(0)) release();
    await Promise.all([streamA.result(), streamB.result()]);

    const xaiCalls = calls.filter(({ url }) => url === XAI_CLI_RESPONSES_URL);
    expect(xaiCalls).toHaveLength(2);
    expect(xaiCalls.every(({ init }) => init.redirect === "error")).toBe(true);
    expect(globalThis.fetch).toBe(baseFetch);
  });

  it("routes explicit API keys through api.x.ai with no proxy metadata", async () => {
    await createXaiResponse(
      { kind: "api-key", token: "api-key-token" },
      { model: "grok-build", input: "hello" },
    );
    const request = requests.at(-1)!;
    expect(request.init.method).toBe("POST");
    expect(request.init.redirect).toBe("error");
    expect(new URL(request.url).origin).toBe("https://api.x.ai");
    expect(request.url).toBe(XAI_RESPONSES_URL);
    expect(headerValue(request.init.headers, "Content-Type")).toBe(
      "application/json",
    );
    expect(headerValue(request.init.headers, "Authorization")).toBe(
      "Bearer api-key-token",
    );
    expect(headerValue(request.init.headers, "Accept")).toBe(
      "application/json",
    );
    expect(headerValue(request.init.headers, "User-Agent")).toBe(
      XAI_USER_AGENT,
    );
    expect(proxyHeaders(request)).toEqual({});
    expect(request.body.store).toBeUndefined();
    expect(request.body.include).toBeUndefined();
    for (const name of unsupportedProxyHeaderNames) {
      expect(headerValue(request.init.headers, name)).toBeUndefined();
    }
  });

  it("rejects an unentitled OAuth model before network", async () => {
    setXaiRuntimeModels(CURATED_FALLBACK_MODELS);
    await expect(
      createXaiResponse(
        { kind: "oauth-session", token: "oauth-token" },
        { model: "grok-build", input: "no" },
      ),
    ).rejects.toThrow(/not present in the authenticated model catalog/);
    expect(requests).toHaveLength(0);
  });

  it("uses non-reflective xAI error labels and preserves HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("OpenAI API error: failed", { status: 500 }),
      ),
    );
    const error = await postXaiJson("token", "https://example.test", {}).catch(
      (value) => value as any,
    );
    expect(error.status).toBe(500);
    expect(error.message).toBe("xAI API error: request failed with status 500");
    expect(error.message).not.toContain("OpenAI API error: failed");
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
    expect(result.errorMessage).not.toContain("OpenAI API error: failed");
  });

  it("forces streaming SDK retries to zero", async () => {
    const retryableFetch = vi.fn(async () =>
      jsonResponse(
        { error: { message: "RETRY_BODY_SECRET" } },
        429,
        { "Retry-After": "0" },
      ),
    );
    vi.stubGlobal("fetch", retryableFetch);
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] } as any,
      {
        apiKey: "oauth-token",
        maxRetries: 4,
      } as any,
    );
    const result = await stream.result();
    expect(retryableFetch).toHaveBeenCalledTimes(1);
    expect(result.errorMessage).not.toContain("RETRY_BODY_SECRET");
  });

  it("classifies proxy version gates without reflecting raw bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "unsupported_client_version",
            message: "TOKEN_SECRET update required",
          }),
          { status: 426, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const error = await postXaiJson(
      "OAUTH_TOKEN_SECRET",
      XAI_CLI_RESPONSES_URL,
      {},
    ).catch((value) => value as any);
    expect(error).toMatchObject({
      status: 426,
      routeKind: "responses-proxy",
      code: "proxy-version-gate",
    });
    expect(error.message).toMatch(/Update pi-xai-oauth/);
    expect(error.message).toContain(XAI_GROK_BUILD_REVIEWED_REVISION);
    expect(error.message).not.toMatch(/TOKEN_SECRET|unsupported_client_version/);
  });

  it("classifies encrypted reasoning mismatch without reflecting raw bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "invalid_request",
            message: "RAW_MISMATCH_SECRET encrypted_content belongs to another model",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const error = await postXaiJson(
      "OAUTH_TOKEN_SECRET",
      XAI_CLI_RESPONSES_URL,
      {},
    ).catch((value) => value as any);
    expect(error).toMatchObject({
      status: 400,
      routeKind: "responses-proxy",
      code: "encrypted-content-mismatch",
    });
    expect(error.message).toMatch(/Start a clean session or turn using the same xAI model/);
    expect(error.message).not.toMatch(/RAW_MISMATCH_SECRET|encrypted_content|invalid_request/);
  });

  it("keeps encrypted-content markers generic outside the narrow proxy 400 case", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("encrypted_content RAW_SECRET", { status: 400 })),
    );
    const direct = await postXaiJson("token", XAI_RESPONSES_URL, {}).catch((value) => value as any);
    expect(direct).toMatchObject({ code: "http", routeKind: "responses-direct", status: 400 });
    expect(direct.message).toBe("xAI API error: Responses failed with status 400");
    expect(direct.message).not.toContain("RAW_SECRET");
  });

  it("surfaces encrypted reasoning mismatch guidance for streaming with one attempt", async () => {
    const mismatchFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ message: "STREAM_SECRET encrypted_content is incompatible" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", mismatchFetch);
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] } as any,
      { apiKey: "oauth-token", sessionId: "session" } as any,
    );
    const result = await stream.result();
    expect(mismatchFetch).toHaveBeenCalledTimes(1);
    expect(result.errorMessage).toMatch(/Start a clean session or turn using the same xAI model/);
    expect(result.errorMessage).not.toMatch(/STREAM_SECRET|encrypted_content/);
  });

  it("surfaces the same safe proxy gate guidance for streaming", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "unsupported_client_version",
            message: "STREAM_TOKEN_SECRET update required",
          }),
          { status: 426, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const stream = streamSimpleXaiResponses(
      TEST_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] } as any,
      { apiKey: "oauth-token", sessionId: "session" } as any,
    );
    const result = await stream.result();
    expect(result.errorMessage).toMatch(/Update pi-xai-oauth/);
    expect(result.errorMessage).toContain(XAI_GROK_BUILD_REVIEWED_REVISION);
    expect(result.errorMessage).not.toMatch(
      /STREAM_TOKEN_SECRET|unsupported_client_version/,
    );
  });

  it("bounds oversized error bodies and never reflects their contents", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode("RAW_ERROR_SECRET".repeat(100)));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 500 })),
    );
    const error = await postXaiJson("token", "https://example.test", {}).catch(
      (value) => value as any,
    );
    expect(error.status).toBe(500);
    expect(error.message).not.toContain("RAW_ERROR_SECRET");
    expect(pulls).toBeLessThanOrEqual(12);
    expect(cancelled).toBe(true);
  });
});
