#!/usr/bin/env node

const assert = require("assert");
const path = require("path");
const fs = require("fs/promises");
const { createJiti } = require("jiti");

const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(__filename, { interopDefault: true });
const extensionModule = jiti(path.join(repoRoot, "extensions", "xai-oauth.ts"));
const extension = extensionModule.default || extensionModule;
const originalFetch = global.fetch;
const requests = [];

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock() {
  global.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith("http://127.0.0.1:")) {
      return originalFetch(url, init);
    }

    if (href === "https://auth.x.ai/.well-known/openid-configuration") {
      return jsonResponse({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      });
    }

    if (href === "https://auth.x.ai/oauth2/token") {
      const params = new URLSearchParams(String(init.body || ""));
      requests.push({ url: href, body: Object.fromEntries(params) });
      return jsonResponse({
        access_token: `access-${params.get("code") || "refresh"}`,
        refresh_token: "refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }

    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: href, headers: init.headers || {}, body, signal: init.signal });
    if (href.endsWith("/images/generations")) {
      return jsonResponse({ data: [{ url: "https://example.test/image.png" }] });
    }
    return jsonResponse({ id: "resp_test", output_text: "OK" });
  };
}

function restoreFetchMock() {
  global.fetch = originalFetch;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] || headers[name.toLowerCase()];
}

function urlOriginIs(url, expectedOrigin) {
  try {
    return new URL(url).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function loadExtension() {
  const providers = new Map();
  const tools = new Map();
  const handlers = new Map();
  let activeTools = ["read", "bash", "edit", "write"];
  extension({
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerProvider(name, config) {
      providers.set(name, config);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(toolNames) {
      activeTools = toolNames;
    },
  });
  return { providers, tools, handlers, getActiveTools: () => activeTools, setActiveTools: (toolNames) => { activeTools = toolNames; } };
}

function authContext() {
  return {
    modelRegistry: {
      find(provider, modelId) {
        return { provider, id: modelId, headers: {} };
      },
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "oauth-token" };
      },
    },
  };
}

async function runTool(tools, name, params = {}, expectedText = "OK", requestOrigin = "https://api.x.ai") {
  const controller = new AbortController();
  const before = requests.length;
  const result = await tools.get(name).execute("call_test", params, controller.signal, () => {}, authContext());
  const request = requests.slice(before).find((entry) => entry.url && urlOriginIs(entry.url, requestOrigin));
  if (expectedText instanceof RegExp) {
    assert.match(result.content[0].text, expectedText, `${name} should surface mocked xAI text`);
  } else {
    assert.equal(result.content[0].text, expectedText, `${name} should surface mocked xAI text`);
  }
  assert.ok(request, `${name} should send a request`);
  assert.equal(headerValue(request.headers, "Authorization"), "Bearer oauth-token", `${name} should use OAuth token from pi model registry`);
  assert.strictEqual(request.signal, controller.signal, `${name} should pass the pi cancellation signal`);
  return { body: request.body, request, result };
}

async function runCursorTool(tools, name, params = {}, ctx = {}) {
  const controller = new AbortController();
  return tools.get(name).execute("call_cursor", params, controller.signal, () => {}, { cwd: repoRoot, ...ctx });
}

async function verifyCursorToolShims(tools) {
  for (const name of ["Read", "Write", "StrReplace", "Edit", "Delete", "LS", "Grep", "Glob", "Shell", "WebSearch"]) {
    assert.ok(tools.has(name), `${name} Cursor/Grok CLI shim should be registered`);
  }

  const grepResult = await runCursorTool(tools, "Grep", { query: "export const DEFAULT_XAI_MODEL", include: "*.ts", path: "extensions", limit: 5 });
  assert.match(grepResult.content[0].text, /xai\/constants\.ts/, "Grep shim should map query/include to pi grep pattern/glob");

  const grepContextResult = await runCursorTool(tools, "Grep", {
    query: "DEFAULT_XAI_MODEL",
    include: "constants.ts",
    path: "extensions/xai",
    context: 1,
    limit: 1,
  });
  assert.match(grepContextResult.content[0].text, /constants\.ts-17-.*XAI_PROVIDER_ID/, "Grep shim should include leading context lines");
  assert.match(grepContextResult.content[0].text, /constants\.ts:18:.*DEFAULT_XAI_MODEL/, "Grep shim should mark the matched line");
  await assert.rejects(
    () => runCursorTool(tools, "Grep", { query: "(a+)+$", include: "constants.ts", path: "extensions/xai" }),
    /Unsafe regex pattern/,
    "Grep shim should reject regexes with obvious catastrophic-backtracking structure",
  );
  await assert.rejects(
    () => runCursorTool(tools, "Grep", { path: "extensions", include: "*.ts", limit: 5 }),
    /Grep requires a non-empty pattern \(or query alias\)/,
    "Grep shim should fail clearly when pattern/query is omitted",
  );
  await assert.rejects(
    () => runCursorTool(tools, "Grep", { pattern: "   ", path: "extensions" }),
    /Grep requires a non-empty pattern \(or query alias\)/,
    "Grep shim should reject whitespace-only patterns",
  );

  const grepByPattern = await runCursorTool(tools, "Grep", {
    pattern: "registerProvider",
    path: "extensions",
    include: "*.ts",
    limit: 3,
  });
  assert.match(grepByPattern.content[0].text, /registerProvider/, "Grep shim should accept pattern directly");

  const grepPrepared = tools.get("Grep").prepareArguments({
    query: "export const DEFAULT_XAI_MODEL",
    include: "*.ts",
    path: "extensions",
  });
  assert.equal(grepPrepared.pattern, "export const DEFAULT_XAI_MODEL", "Grep prepareArguments should map query to required pattern");
  assert.equal(grepPrepared.glob, "*.ts", "Grep prepareArguments should map include to glob");
  const grepParams = tools.get("Grep").parameters;
  assert.ok(
    Array.isArray(grepParams.required) && grepParams.required.includes("pattern"),
    "Grep schema should require pattern so models do not omit the search text",
  );
  assert.ok(grepParams.properties?.pattern, "Grep schema should expose a pattern property");
  assert.ok(grepParams.properties?.query, "Grep schema should keep query as a Cursor-style alias");

  const globResult = await runCursorTool(tools, "Glob", { glob: "xai-oauth.ts", limit: 5 });
  assert.match(globResult.content[0].text, /extensions\/xai-oauth\.ts/, "Glob shim should map glob to pi find");

  const readResult = await runCursorTool(tools, "Read", { file_path: "package.json", limit: 3 });
  assert.match(readResult.content[0].text, /"name": "pi-xai-oauth"/, "Read shim should map file_path to pi read path");

  const tmpDir = path.join(repoRoot, ".tmp-shim-tests");
  const tmpFile = path.join(tmpDir, "cursor-shim.txt");
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    const writeResult = await runCursorTool(tools, "Write", { file_path: ".tmp-shim-tests/cursor-shim.txt", contents: "hello old" });
    assert.match(writeResult.content[0].text, /Successfully wrote/, "Write shim should map contents to pi write content");

    const replaceResult = await runCursorTool(tools, "StrReplace", {
      file_path: ".tmp-shim-tests/cursor-shim.txt",
      old_string: "hello old",
      new_string: "hello new",
    });
    assert.match(replaceResult.content[0].text, /Successfully replaced/, "StrReplace shim should map old_string/new_string to pi edit");

    const shellResult = await runCursorTool(tools, "Shell", { cmd: "printf shim-ok" });
    assert.match(shellResult.content[0].text, /shim-ok/, "Shell shim should map cmd to pi bash command");

    const deleteResult = await runCursorTool(tools, "Delete", { file_path: ".tmp-shim-tests/cursor-shim.txt" });
    assert.match(deleteResult.content[0].text, /Deleted/, "Delete shim should remove files inside the workspace");
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
    await fs.rm(tmpDir, { force: true, recursive: true }).catch(() => {});
  }
}

async function verifyCursorToolActivation(loadResult) {
  const { handlers, getActiveTools } = loadResult;
  // The real pi ExtensionContext does NOT expose getActiveTools/setActiveTools;
  // those accessors live on the `pi` api object passed at load time. Mirror that
  // here (empty ctx) so the handlers are forced to use the pi accessors. This is
  // the regression guard for the "400 tools: Tool names must be unique" bug where
  // reading the accessors off ctx made the sync silently bail and left the
  // Read/Write/Edit shims colliding with pi's built-in tools.
  const ctx = {};
  const selectModel = (id, provider = "xai-auth") =>
    handlers.get("model_select")?.({ model: { provider, id } }, ctx);

  await selectModel("grok-composer-2.5-fast");
  assert.ok(getActiveTools().includes("Grep"), "Cursor shims should be enabled for Composer 2.5");

  await selectModel("grok-4.3");
  assert.ok(!getActiveTools().includes("Grep"), "Cursor shims should be disabled for non-Grok-CLI xAI models");

  // session_start reads the model from ctx.model (not the event). Verify it prunes
  // the shims for a non-Grok model so their names can't duplicate the built-ins.
  await selectModel("grok-composer-2.5-fast");
  assert.ok(getActiveTools().includes("Grep"), "Cursor shims should re-enable for Composer 2.5");
  await handlers.get("session_start")?.({}, { model: { provider: "anthropic", id: "claude-opus-4-8" } });
  assert.ok(!getActiveTools().includes("Grep"), "session_start should prune Cursor shims for non-Grok models");
  for (const shim of ["Read", "Write", "Edit"]) {
    assert.ok(
      !getActiveTools().includes(shim),
      `${shim} shim must not stay active for non-Grok models (would duplicate pi's built-in tool name)`,
    );
  }

  // before_agent_start also reads the model from ctx.model.
  await selectModel("grok-composer-2.5-fast");
  assert.ok(getActiveTools().includes("Grep"), "Cursor shims should re-enable before before_agent_start check");
  await handlers.get("before_agent_start")?.({}, { model: { provider: "anthropic", id: "claude-opus-4-8" } });
  assert.ok(!getActiveTools().includes("Grep"), "before_agent_start should prune Cursor shims for non-Grok models");
}

function lastResultErrorMessage(result) {
  return result && typeof result.errorMessage === "string" ? result.errorMessage : "";
}

async function captureStreamResultMessage(createStream) {
  try {
    const result = await createStream().result();
    return lastResultErrorMessage(result);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function verifyRealGuardSemantics() {
  const { streamSimpleOpenAIResponses } = await import("@earendil-works/pi-ai");
  const context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
  const baseModel = {
    id: "grok-4.3",
    provider: "xai-auth",
    baseUrl: "https://api.x.ai/v1",
    headers: {},
    reasoning: true,
    input: ["text", "image"],
  };

  const rejectedMessage = await captureStreamResultMessage(() =>
    streamSimpleOpenAIResponses({ ...baseModel, api: "xai-responses" }, context, { apiKey: "oauth-token" }),
  );
  assert.match(
    rejectedMessage,
    /Mismatched api/,
    "installed @earendil-works/pi-ai must API-guard openai-responses (bump dev dep to 0.79.8)",
  );

  const before = requests.length;
  const acceptedMessage = await captureStreamResultMessage(() =>
    streamSimpleOpenAIResponses({ ...baseModel, api: "openai-responses" }, context, { apiKey: "oauth-token" }),
  );
  assert.doesNotMatch(acceptedMessage, /Mismatched api/, "an openai-responses model must satisfy the real guard");
  assert.ok(
    requests.slice(before).some((entry) => entry.url && urlOriginIs(entry.url, "https://api.x.ai")),
    "guarded call should reach the xAI endpoint",
  );
}

async function verifyXaiStreamPassesRealGuard(provider) {
  const before = requests.length;
  const message = await captureStreamResultMessage(() =>
    provider.streamSimple(
      {
        id: "grok-4.3",
        provider: "xai-auth",
        api: "xai-responses",
        baseUrl: "https://api.x.ai/v1",
        headers: {},
        reasoning: true,
        input: ["text", "image"],
      },
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
      { apiKey: "oauth-token", sessionId: "guard-session" },
    ),
  );
  assert.doesNotMatch(message, /Mismatched api/, "xAI provider stream must satisfy pi 0.79.8 API guard");
  assert.ok(
    requests.slice(before).some((entry) => entry.url && urlOriginIs(entry.url, "https://api.x.ai")),
    "xAI stream should reach the xAI endpoint past the guard",
  );
}


async function verifyCliModelStreamRouting(provider) {
  const composer = provider.models.find((model) => model.id === "grok-composer-2.5-fast");
  const model = {
    ...composer,
    provider: "xai-auth",
    api: provider.api,
    baseUrl: provider.baseUrl,
  };
  const before = requests.length;
  const stream = provider.streamSimple(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    { apiKey: "oauth-token", sessionId: "session-test" },
  );
  await stream.result();
  const request = requests.slice(before).find((entry) => entry.url && urlOriginIs(entry.url, "https://cli-chat-proxy.grok.com"));
  assert.ok(request, "Composer 2.5 provider streams should route to the Grok CLI endpoint");
  assert.equal(request.body.model, "grok-composer-2.5-fast");
  assert.equal(request.body.reasoning, undefined, "Composer 2.5 provider streams should not send reasoning effort");
  assert.equal(headerValue(request.headers, "Authorization"), "Bearer oauth-token");
  assert.equal(headerValue(request.headers, "x-xai-token-auth"), "xai-grok-cli");
  assert.equal(headerValue(request.headers, "x-grok-model-override"), "grok-composer-2.5-fast");
  assert.equal(headerValue(request.headers, "x-grok-conv-id"), "session-test");
}

async function verifyOAuthCallbackState(provider) {
  let authUrl;
  const login = provider.oauth.login({
    onPrompt: async () => "n",
    onProgress: () => {},
    onAuth(auth) {
      authUrl = new URL(auth.url);
      const redirectUri = authUrl.searchParams.get("redirect_uri");
      const expectedState = authUrl.searchParams.get("state");
      setTimeout(async () => {
        const bad = new URL(redirectUri);
        bad.searchParams.set("code", "bad-code");
        bad.searchParams.set("state", "wrong-state");
        const badResponse = await originalFetch(bad);
        assert.equal(badResponse.status, 400, "bad OAuth state should be rejected without resolving login");

        const good = new URL(redirectUri);
        good.searchParams.set("code", "good-code");
        good.searchParams.set("state", expectedState);
        await originalFetch(good);
      }, 10);
    },
  });

  const credentials = await login;
  assert.equal(credentials.access, "access-good-code", "login should ignore the bad callback and exchange the good code");
  assert.ok(authUrl, "login should provide an authorization URL");
}

async function verifyOAuthManualRawCode(provider) {
  const rawCode = "bMmOusw8w9arz1aNEuDCY02jhiOs22O5j-92yEKTzMCbPShyToONJWSc2KITti2CgoM0clOeFMUosJm76y_2MA";
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 500);
  let authUrl;

  try {
    const credentials = await provider.oauth.login({
      onPrompt: async () => "n",
      onProgress: () => {},
      onAuth(auth) {
        authUrl = new URL(auth.url);
      },
      onManualCodeInput: async () => rawCode,
      signal: controller.signal,
    });

    assert.equal(credentials.access, `access-${rawCode}`, "raw pasted xAI authorization code should be accepted and exchanged");
    assert.ok(authUrl, "login should provide an authorization URL before accepting manual code");
  } finally {
    clearTimeout(abortTimer);
  }
}

async function verifyOAuthManualCallbackUrlState(provider) {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 500);
  let callbackUrl;

  try {
    const credentials = await provider.oauth.login({
      onPrompt: async () => "n",
      onProgress: () => {},
      onAuth(auth) {
        const authUrl = new URL(auth.url);
        callbackUrl = new URL(authUrl.searchParams.get("redirect_uri"));
        callbackUrl.searchParams.set("code", "manual-url-code");
        callbackUrl.searchParams.set("state", authUrl.searchParams.get("state"));
      },
      onManualCodeInput: async () => callbackUrl.toString(),
      signal: controller.signal,
    });

    assert.equal(credentials.access, "access-manual-url-code", "manual callback URL with matching state should be exchanged");
  } finally {
    clearTimeout(abortTimer);
  }
}

async function verifyOAuthManualWrongStateIgnored(provider) {
  const progress = [];
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 5_000);
  let authUrl;

  try {
    const credentials = await provider.oauth.login({
      onPrompt: async () => "n",
      onProgress(message) {
        progress.push(message);
      },
      onAuth(auth) {
        authUrl = new URL(auth.url);
        const redirectUri = authUrl.searchParams.get("redirect_uri");
        const expectedState = authUrl.searchParams.get("state");
        setTimeout(async () => {
          const good = new URL(redirectUri);
          good.searchParams.set("code", "manual-wrong-state-fallback-good");
          good.searchParams.set("state", expectedState);
          await originalFetch(good);
        }, 10);
      },
      onManualCodeInput: async () => "code=bad-manual-state-code&state=wrong-state",
      signal: controller.signal,
    });

    assert.equal(credentials.access, "access-manual-wrong-state-fallback-good", "manual callback query with wrong state should be ignored");
    assert.ok(progress.some((message) => /OAuth state did not match/.test(message)), "wrong-state manual callback should log that it was ignored");
    assert.ok(authUrl, "login should provide an authorization URL");
  } finally {
    clearTimeout(abortTimer);
  }
}

async function main() {
  process.env.HOME = path.join(repoRoot, ".tmp-empty-home-for-tests");
  process.env.XAI_API_KEY = "must-not-be-used";
  installFetchMock();

  try {
    const firstLoad = loadExtension();
    const { providers, tools } = firstLoad;
    const secondLoad = loadExtension();
    const provider = providers.get("xai-auth");
    assert.ok(provider, "xai-auth provider should be registered");
    assert.equal(secondLoad.tools.size, tools.size, "extension reloads should register tools on the new pi API object");
    assert.equal(provider.api, "xai-responses");
    const grok45 = provider.models.find((model) => model.id === "grok-4.5");
    assert.ok(grok45, "grok-4.5 should be registered in the xAI model catalog");
    assert.equal(grok45?.contextWindow, 500_000);
    assert.equal(grok45?.reasoning, true);
    assert.equal(grok45?.cost.input, 2);
    assert.equal(grok45?.cost.cacheRead, 0.5);
    assert.equal(grok45?.cost.output, 6);
    assert.equal(grok45?.thinkingLevelMap?.off, null, "Grok 4.5 reasoning cannot be disabled");
    assert.equal(provider.models.find((model) => model.id === "grok-4.3")?.contextWindow, 1_000_000);
    assert.equal(provider.models.find((model) => model.id === "grok-build")?.contextWindow, 512_000);
    assert.equal(provider.models.find((model) => model.id === "grok-composer-2.5-fast")?.contextWindow, 200_000);
    assert.equal(provider.models.find((model) => model.id === "grok-composer-2.5-fast")?.reasoning, false);
    assert.equal(provider.models.find((model) => model.id === "grok-4.20-0309-reasoning")?.contextWindow, 2_000_000);
    assert.ok(provider.models.some((model) => model.id === "grok-4.20-multi-agent-0309"));

    await verifyRealGuardSemantics();
    await verifyXaiStreamPassesRealGuard(provider);

    await verifyCliModelStreamRouting(provider);
    await verifyCursorToolActivation(firstLoad);
    await verifyCursorToolShims(tools);

    await verifyOAuthCallbackState(provider);
    await verifyOAuthManualRawCode(provider);
    await verifyOAuthManualCallbackUrlState(provider);
    await verifyOAuthManualWrongStateIgnored(provider);

    const noAuthResult = await tools.get("xai_generate_text").execute("call_noauth", { prompt: "hi" }, undefined, () => {}, {
      modelRegistry: {
        find: () => undefined,
      },
    });
    assert.match(noAuthResult.content[0].text, /No xAI OAuth credentials/, "tools should not fall back to XAI_API_KEY");

    const { body: grok45TextBody } = await runTool(tools, "xai_generate_text", {
      prompt: "hi",
      model: "grok-4.5",
    });
    assert.equal(grok45TextBody.model, "grok-4.5", "xai_generate_text should support explicit Grok 4.5 requests");
    assert.equal(grok45TextBody.reasoning.effort, "high", "Grok 4.5 text generation should default to high reasoning");

    const { body: composerBody, request: composerRequest } = await runTool(
      tools,
      "xai_generate_text",
      { prompt: "hi", model: "grok-composer-2.5-fast", reasoning_effort: "high" },
      "OK",
      "https://cli-chat-proxy.grok.com",
    );
    assert.equal(composerBody.model, "grok-composer-2.5-fast");
    assert.equal(composerBody.reasoning, undefined, "Composer 2.5 should not send reasoning effort");
    assert.equal(headerValue(composerRequest.headers, "x-xai-token-auth"), "xai-grok-cli");
    assert.equal(headerValue(composerRequest.headers, "x-grok-model-override"), "grok-composer-2.5-fast");
    assert.ok(headerValue(composerRequest.headers, "x-grok-conv-id"), "Composer 2.5 tool calls should include a Grok conversation id");

    const { body: buildBody, request: buildRequest } = await runTool(
      tools,
      "xai_generate_text",
      { prompt: "hi", model: "grok-build" },
      "OK",
      "https://cli-chat-proxy.grok.com",
    );
    assert.equal(buildBody.model, "grok-build");
    assert.equal(headerValue(buildRequest.headers, "x-grok-model-override"), "grok-build");
    assert.ok(headerValue(buildRequest.headers, "x-grok-conv-id"), "Grok Build tool calls should include a Grok conversation id");

    const { body: webBody } = await runTool(tools, "xai_web_search", { query: "xAI docs" });
    assert.deepEqual(webBody.tools, [{ type: "web_search", enable_image_understanding: true }]);

    const { body: xBody } = await runTool(tools, "xai_x_search", { query: "grok", since: "2026-05-01", until: "2026-05-22" });
    assert.equal(xBody.tools[0].type, "x_search");
    assert.equal(xBody.tools[0].from_date, "2026-05-01");
    assert.equal(xBody.tools[0].to_date, "2026-05-22");

    const { body: codeBody } = await runTool(tools, "xai_code_execution", { code: "print(2 + 2)" });
    assert.deepEqual(codeBody.tools, [{ type: "code_interpreter" }]);

    const { body: imageAnalysisBody } = await runTool(tools, "xai_analyze_image", {
      image: "https://example.test/cat.png",
      question: "what is here?",
    });
    const imageContent = imageAnalysisBody.input[0].content;
    assert.equal(imageContent[0].type, "input_image");
    assert.equal(imageContent[1].type, "input_text");

    const { body: imageGenBody } = await runTool(tools, "xai_generate_image", { prompt: "a crisp diagram" }, /Generated 1 image/);
    assert.equal(imageGenBody.model, "grok-imagine-image-quality");
    const imageTool = tools.get("xai_generate_image");
    assert.equal(Object.hasOwn(imageGenBody, "size"), false, "image generation should not send unsupported size defaults");
    assert.equal(Object.hasOwn(imageGenBody, "n"), false, "image generation should not send n unless explicitly requested");
    assert.equal(imageTool.parameters.properties.size, undefined, "image tool schema should not advertise unsupported size");
    assert.equal(imageTool.parameters.properties.n.default, undefined, "image tool schema should not inject n when omitted");
    assert.equal(imageTool.parameters.properties.n.minimum, 1, "image tool schema should reject image counts below one");
    assert.equal(imageTool.parameters.properties.n.maximum, 4, "image tool schema should reject image counts above four");

    const { body: imageBatchBody } = await runTool(
      tools,
      "xai_generate_image",
      { prompt: "three crisp diagrams", n: 3 },
      /Generated 1 image/,
    );
    assert.equal(imageBatchBody.n, 3, "image generation should forward an explicit n value");
    assert.equal(Object.hasOwn(imageBatchBody, "size"), false, "explicit n requests should still omit size");

    const requestsBeforeUnsupportedSize = requests.length;
    const unsupportedSizeResult = await imageTool.execute(
      "call_unsupported_size",
      { prompt: "a crisp diagram", size: "1024x1024" },
      undefined,
      () => {},
      authContext(),
    );
    assert.match(unsupportedSizeResult.content[0].text, /does not support the 'size' parameter/);
    assert.equal(requests.length, requestsBeforeUnsupportedSize, "unsupported size should fail before sending a request");

    const invalidCountResult = await imageTool.execute(
      "call_invalid_image_count",
      { prompt: "a crisp diagram", n: 0 },
      undefined,
      () => {},
      authContext(),
    );
    assert.match(invalidCountResult.content[0].text, /must be an integer from 1 to 4/);
    assert.equal(requests.length, requestsBeforeUnsupportedSize, "invalid n should fail before sending a request");

    const { body: multiAgentBody, result: multiAgentResult } = await runTool(tools, "xai_multi_agent", { query: "latest xAI tools", num_agents: 4 });
    assert.equal(multiAgentBody.model, "grok-4.20-multi-agent-0309");
    assert.equal(multiAgentBody.reasoning.effort, "medium");
    assert.equal(multiAgentResult.details.agents_used, 4);
    assert.ok(multiAgentBody.tools.some((tool) => tool.type === "web_search"));
    assert.ok(multiAgentBody.tools.some((tool) => tool.type === "x_search"));

    console.log("verify-extension: ok");
  } finally {
    restoreFetchMock();
  }
}

main().catch((error) => {
  restoreFetchMock();
  console.error(error);
  process.exit(1);
});
