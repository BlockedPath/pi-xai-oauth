#!/usr/bin/env node

const assert = require("assert");
const path = require("path");
const fs = require("fs/promises");
const { createJiti } = require("jiti");

const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(__filename, { interopDefault: true });
const extensionModule = jiti(path.join(repoRoot, "extensions", "xai-oauth.ts"));
const extension = extensionModule.default || extensionModule;
const { compactXaiInlineImages, MAX_XAI_INLINE_IMAGE_BASE64_BYTES } = jiti(
  path.join(repoRoot, "extensions", "xai", "images.ts"),
);
const { rewriteXaiResponsesPayload } = jiti(path.join(repoRoot, "extensions", "xai", "payload.ts"));
const { createXaiResponse } = jiti(path.join(repoRoot, "extensions", "xai", "responses.ts"));
const { XAI_NETWORK_TOOL_NAMES } = jiti(path.join(repoRoot, "extensions", "xai", "tools", "model-scope.ts"));
const originalFetch = global.fetch;
const requests = [];
let nextXaiResponse;

const TEST_XAI_MODEL = {
  id: "grok-4.5",
  provider: "xai-auth",
  api: "xai-responses",
  baseUrl: "https://api.x.ai/v1",
  headers: {},
  reasoning: true,
  input: ["text", "image"],
};

const XAI_NETWORK_TOOLS = [...XAI_NETWORK_TOOL_NAMES];
const CUSTOM_XAI_NETWORK_TOOLS = XAI_NETWORK_TOOLS.filter((name) => name !== "WebSearch");

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
    if (nextXaiResponse && urlOriginIs(href, "https://api.x.ai")) {
      const response = nextXaiResponse;
      nextXaiResponse = undefined;
      return jsonResponse(response.body, { status: response.status });
    }
    if (href.endsWith("/images/generations")) {
      return jsonResponse({ data: [{ url: "https://example.test/image.png" }] });
    }
    return jsonResponse({ id: "resp_test", output_text: "OK" });
  };
}

function restoreFetchMock() {
  global.fetch = originalFetch;
}

function respondToNextXaiRequest(status, body) {
  nextXaiResponse = { status, body };
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
  const commands = new Map();
  let activeTools = ["read", "bash", "edit", "write"];
  let throwOnGetActiveTools = false;
  let throwOnSetActiveTools = false;
  extension({
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerProvider(name, config) {
      providers.set(name, config);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    getActiveTools() {
      if (throwOnGetActiveTools) throw new Error("tool registry not ready");
      return activeTools;
    },
    setActiveTools(toolNames) {
      if (throwOnSetActiveTools) throw new Error("tool registry temporarily unavailable");
      activeTools = toolNames;
    },
  });
  return {
    providers,
    tools,
    handlers,
    commands,
    getActiveTools: () => activeTools,
    setActiveTools: (toolNames) => { activeTools = toolNames; },
    setToolRegistryFailures({ get = false, set = false } = {}) {
      throwOnGetActiveTools = get;
      throwOnSetActiveTools = set;
    },
  };
}

function authContext(model = TEST_XAI_MODEL) {
  return {
    model,
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

function extensionCommandContext(model, notifications = [], select, custom, mode = "tui") {
  return {
    model,
    mode,
    hasUI: true,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      async select(title, options) {
        return select?.(title, options);
      },
      async custom(factory) {
        return custom?.(factory);
      },
    },
  };
}

async function runTool(
  tools,
  name,
  params = {},
  expectedText = "OK",
  requestOrigin = "https://api.x.ai",
  model = TEST_XAI_MODEL,
) {
  const controller = new AbortController();
  const before = requests.length;
  const result = await tools.get(name).execute("call_test", params, controller.signal, () => {}, authContext(model));
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

async function verifyCursorToolShims(loadResult) {
  const { commands, tools } = loadResult;
  for (const name of ["Read", "Write", "StrReplace", "Edit", "Delete", "LS", "Grep", "Glob", "Shell", "WebSearch"]) {
    assert.ok(tools.has(name), `${name} Cursor/Grok CLI shim should be registered`);
  }

  const composerModel = { ...TEST_XAI_MODEL, id: "grok-composer-2.5-fast" };
  const beforeDisabledWebSearch = requests.length;
  const disabledWebSearchResult = await runCursorTool(tools, "WebSearch", { query: "must opt in" }, authContext(composerModel));
  assert.match(disabledWebSearchResult.content[0].text, /WebSearch is disabled/);
  assert.equal(requests.length, beforeDisabledWebSearch, "inactive Cursor WebSearch must fail before network access");

  await commands.get("xai-tools").handler("enable WebSearch", extensionCommandContext(composerModel));
  const beforeWebSearch = requests.length;
  const webSearchResult = await runCursorTool(tools, "WebSearch", { query: "xAI docs" }, authContext(composerModel));
  assert.equal(webSearchResult.content[0].text, "OK");
  const webSearchRequest = requests
    .slice(beforeWebSearch)
    .find((entry) => entry.url && urlOriginIs(entry.url, "https://cli-chat-proxy.grok.com"));
  assert.ok(webSearchRequest, "Cursor WebSearch should route through the active Grok CLI model");
  assert.equal(webSearchRequest.body.model, composerModel.id);

  const beforeStaleWebSearch = requests.length;
  const staleWebSearchResult = await runCursorTool(
    tools,
    "WebSearch",
    { query: "must not run" },
    authContext({ provider: "anthropic", id: "claude-opus-4-8" }),
  );
  assert.match(staleWebSearchResult.content[0].text, /requires an active xAI/);
  assert.equal(requests.length, beforeStaleWebSearch, "stale Cursor WebSearch calls must fail before network access");

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
  const { handlers, getActiveTools, setActiveTools } = loadResult;
  // Real ExtensionContext objects do not expose the active-tool accessors.
  // Keeping this context empty prevents the test from masking the regression.
  const ctx = {};
  const selectModel = (id, provider = "xai-auth") =>
    handlers.get("model_select")?.({ model: { provider, id } }, ctx);

  await selectModel("grok-composer-2.5-fast");
  assert.ok(getActiveTools().includes("Grep"), "Cursor shims should be enabled for Composer 2.5");
  assert.ok(!getActiveTools().includes("WebSearch"), "selecting a Grok CLI model must not activate paid WebSearch");
  const composerTools = getActiveTools();
  await selectModel("grok-composer-2.5-fast");
  assert.deepStrictEqual(getActiveTools(), composerTools, "Repeated Composer sync should not duplicate shims");
  await handlers.get("before_agent_start")?.({}, { model: { provider: "xai-auth", id: "grok-composer-2.5-fast" } });
  assert.ok(!getActiveTools().includes("WebSearch"), "before-agent synchronization must preserve a manual WebSearch disable");

  setActiveTools([...getActiveTools(), "WebSearch"]);
  await selectModel("grok-4.3");
  assert.ok(!getActiveTools().includes("WebSearch"), "switching to a non-CLI xAI model must disable Cursor WebSearch");
  await selectModel("grok-composer-2.5-fast");
  assert.ok(!getActiveTools().includes("WebSearch"), "switching back to a Grok CLI model must not restore Cursor WebSearch");

  await selectModel("grok-4.3");
  assert.ok(!getActiveTools().includes("Grep"), "Cursor shims should be disabled for non-Grok-CLI xAI models");
  for (const shim of ["Read", "Write", "StrReplace", "Edit", "Delete", "LS", "Grep", "Glob", "Shell", "WebSearch"]) {
    assert.ok(!getActiveTools().includes(shim), `${shim} shim must be removed for non-Grok models`);
  }

  await selectModel("grok-composer-2.5-fast");
  await handlers.get("session_start")?.({}, { model: { provider: "anthropic", id: "claude-opus-4-8" } });
  assert.ok(!getActiveTools().includes("Grep"), "session_start should prune shims for Anthropic models");

  await selectModel("grok-composer-2.5-fast");
  await handlers.get("before_agent_start")?.({}, { model: { provider: "anthropic", id: "claude-opus-4-8" } });
  assert.ok(!getActiveTools().includes("Grep"), "before_agent_start should prune shims for Anthropic models");

  loadResult.setToolRegistryFailures({ get: true });
  await assert.doesNotReject(
    async () => handlers.get("session_start")?.({}, { model: { provider: "anthropic", id: "claude-opus-4-8" } }),
    "session_start should tolerate an unavailable tool registry",
  );
  loadResult.setToolRegistryFailures({ get: false, set: true });
  await selectModel("grok-composer-2.5-fast");
  assert.ok(!getActiveTools().includes("Grep"), "a failed set should not partially update the tool list");
  loadResult.setToolRegistryFailures();
}

async function verifyXaiNetworkToolActivation(loadResult) {
  const { handlers, tools, getActiveTools, setActiveTools } = loadResult;
  const anthropicModel = { provider: "anthropic", id: "claude-opus-4-8" };
  const requestsBeforeLifecycle = requests.length;

  assert.deepStrictEqual(
    [...tools.keys()].filter((name) => name.startsWith("xai_")).sort(),
    [...CUSTOM_XAI_NETWORK_TOOLS].sort(),
    "every registered xai_* tool must be present in the network opt-in catalog",
  );
  assert.ok(XAI_NETWORK_TOOLS.every((name) => getActiveTools().includes(name)), "pi activates newly registered extension tools by default");
  await handlers.get("session_start")?.({}, { model: TEST_XAI_MODEL });
  assert.ok(XAI_NETWORK_TOOLS.every((name) => !getActiveTools().includes(name)), "session start must make every network-backed xAI tool opt-in");

  await handlers.get("model_select")?.({ model: TEST_XAI_MODEL }, { model: TEST_XAI_MODEL });
  assert.ok(
    XAI_NETWORK_TOOLS.every((name) => !getActiveTools().includes(name)),
    "selecting an xAI model must not implicitly activate network-backed tools",
  );
  assert.equal(requests.length, requestsBeforeLifecycle, "session/model lifecycle hooks must never send an xAI request");

  setActiveTools([...getActiveTools(), ...XAI_NETWORK_TOOLS]);
  loadResult.setToolRegistryFailures({ get: true });
  await assert.doesNotReject(
    async () => handlers.get("session_start")?.({}, { model: TEST_XAI_MODEL }),
    "network-tool reset should tolerate an unavailable registry",
  );
  loadResult.setToolRegistryFailures();
  await handlers.get("before_agent_start")?.({}, { model: TEST_XAI_MODEL });
  assert.ok(XAI_NETWORK_TOOLS.every((name) => !getActiveTools().includes(name)), "before_agent_start should retry a failed registry read");

  setActiveTools([...getActiveTools(), ...XAI_NETWORK_TOOLS]);
  loadResult.setToolRegistryFailures({ set: true });
  await handlers.get("session_start")?.({}, { model: TEST_XAI_MODEL });
  await handlers.get("before_agent_start")?.({}, { model: TEST_XAI_MODEL });
  const requestsBeforePersistentSetFailure = requests.length;
  const persistentFailureResult = await tools.get("xai_generate_image").execute(
    "call_persistent_registry_failure",
    { prompt: "must fail closed" },
    undefined,
    () => {},
    authContext(TEST_XAI_MODEL),
  );
  assert.match(persistentFailureResult.content[0].text, /is disabled/);
  assert.equal(
    requests.length,
    requestsBeforePersistentSetFailure,
    "persistent registry write failures must keep network-backed tools fail-closed",
  );
  loadResult.setToolRegistryFailures();
  await handlers.get("before_agent_start")?.({}, { model: TEST_XAI_MODEL });
  assert.ok(XAI_NETWORK_TOOLS.every((name) => !getActiveTools().includes(name)), "before_agent_start should retry a failed registry write");

  setActiveTools([...getActiveTools(), ...XAI_NETWORK_TOOLS]);
  await handlers.get("before_agent_start")?.({}, { model: TEST_XAI_MODEL });
  assert.ok(
    XAI_NETWORK_TOOLS.every((name) => !getActiveTools().includes(name)),
    "direct registry additions must not bypass package-owned network-tool opt-in",
  );

  await handlers.get("model_select")?.({ model: anthropicModel }, { model: anthropicModel });
  assert.ok(XAI_NETWORK_TOOLS.every((name) => !getActiveTools().includes(name)), "switching away from xAI must disable network-backed tools immediately");
  await handlers.get("model_select")?.({ model: TEST_XAI_MODEL }, { model: TEST_XAI_MODEL });
  assert.ok(XAI_NETWORK_TOOLS.every((name) => !getActiveTools().includes(name)), "switching back to xAI must not silently restore network-backed tools");

  setActiveTools([...getActiveTools(), ...XAI_NETWORK_TOOLS]);
  const guardedCalls = {
    xai_generate_text: { prompt: "guard test" },
    xai_web_search: { query: "guard test" },
    xai_x_search: { query: "guard test" },
    xai_multi_agent: { query: "guard test" },
    xai_deep_research: { topic: "guard test" },
    xai_code_execution: { code: "print('guard test')" },
    xai_generate_image: { prompt: "guard test" },
    xai_analyze_image: { image: "https://example.test/guard.png" },
    xai_critique: { content: "guard test" },
  };
  const requestsBeforeGuards = requests.length;
  let registryTouches = 0;
  const guardedContext = {
    model: TEST_XAI_MODEL,
    modelRegistry: {
      find() {
        registryTouches += 1;
        throw new Error("disabled tools must not resolve OAuth credentials");
      },
    },
  };
  for (const [name, params] of Object.entries(guardedCalls)) {
    const result = await tools.get(name).execute("call_guard", params, undefined, () => {}, guardedContext);
    assert.match(result.content[0].text, /is disabled/, `${name} should reject an unauthorized invocation`);
  }
  assert.equal(registryTouches, 0, "disabled network tools must fail before OAuth credential lookup");
  assert.equal(requests.length, requestsBeforeGuards, "disabled network-tool guards must run before network access");

  setActiveTools(getActiveTools().filter((name) => name !== "WebSearch"));
}

async function verifyXaiToolsCommand(loadResult) {
  const { commands, handlers, tools, getActiveTools, setToolRegistryFailures } = loadResult;
  const command = commands.get("xai-tools");
  assert.ok(command, "the package should register /xai-tools");

  const notifications = [];
  const runCommand = (args, model, select, custom, mode) => command.handler(
    args,
    extensionCommandContext(model, notifications, select, custom, mode),
  );

  await handlers.get("session_start")?.({}, { model: TEST_XAI_MODEL });
  assert.ok(XAI_NETWORK_TOOLS.every((name) => !getActiveTools().includes(name)));

  const imageTool = tools.get("xai_generate_image");
  assert.ok(
    imageTool.promptGuidelines.some((guideline) => /explicitly asks to generate an image/.test(guideline)),
    "xai_generate_image must require explicit user intent",
  );
  await runCommand("enable xai_generate_image", TEST_XAI_MODEL);
  assert.ok(getActiveTools().includes("xai_generate_image"), "/xai-tools should provide a real image-generation enable path");
  assert.match(notifications.at(-1).message, /may use xAI credits/);
  await handlers.get("before_agent_start")?.({}, { model: TEST_XAI_MODEL });
  assert.ok(getActiveTools().includes("xai_generate_image"), "before-agent sync should preserve deliberate image-generation opt-in");

  const anthropicModel = { provider: "anthropic", id: "claude-opus-4-8" };
  await handlers.get("model_select")?.({ model: anthropicModel }, { model: anthropicModel });
  assert.ok(!getActiveTools().includes("xai_generate_image"), "leaving xAI must disable image generation");
  await handlers.get("model_select")?.({ model: TEST_XAI_MODEL }, { model: TEST_XAI_MODEL });
  assert.ok(!getActiveTools().includes("xai_generate_image"), "returning to xAI must not restore image generation");

  await runCommand("enable xai_generate_image", TEST_XAI_MODEL);
  await handlers.get("session_start")?.({}, { model: TEST_XAI_MODEL });
  assert.ok(!getActiveTools().includes("xai_generate_image"), "a new session must reset image-generation opt-in");

  await runCommand("enable xai_generate_image", TEST_XAI_MODEL);
  await runCommand("disable xai_generate_image", TEST_XAI_MODEL);
  assert.ok(!getActiveTools().includes("xai_generate_image"), "/xai-tools should disable image generation");

  let tuiPickerClosed = false;
  let selectedAfterPageWrap = "";
  let selectedBeforeToggle = "";
  let selectedAfterToggle = "";
  await runCommand("", TEST_XAI_MODEL, undefined, async (factory) => {
    let component;
    const tui = {
      requestRender() {},
    };
    const theme = {
      fg: (_color, text) => text,
      bg: (_color, text) => text,
      bold: (text) => text,
    };
    const bindings = {
      "tui.select.up": "up",
      "tui.select.down": "down",
      "tui.select.pageUp": "pageup",
      "tui.select.pageDown": "pagedown",
      "tui.select.confirm": "enter",
      "tui.select.cancel": "escape",
    };
    const keybindings = {
      matches: (data, id) => bindings[id] === data,
    };
    component = await factory(tui, theme, keybindings, () => {
      tuiPickerClosed = true;
    });

    component.handleInput("pageup");
    selectedAfterPageWrap = component.render(160).find((line) => line.startsWith("> ")) || "";
    component.handleInput("pagedown");
    for (let index = 0; index < 6; index += 1) component.handleInput("down");
    selectedBeforeToggle = component.render(160).find((line) => line.startsWith("> ")) || "";
    component.handleInput("enter");
    selectedAfterToggle = component.render(160).find((line) => line.startsWith("> ")) || "";
    component.handleInput("escape");
  });
  assert.match(selectedAfterPageWrap, /> \[ \] xai_critique/);
  assert.match(selectedBeforeToggle, /> \[ \] xai_generate_image/);
  assert.match(selectedAfterToggle, /> \[x\] xai_generate_image/);
  assert.ok(tuiPickerClosed, "Escape should close the stateful xAI tool picker");
  assert.ok(getActiveTools().includes("xai_generate_image"), "the stateful picker should toggle image generation");
  await runCommand("disable xai_generate_image", TEST_XAI_MODEL);

  // Grok Build/Composer exposes all 10 tools (including WebSearch). Page size
  // equals list length, so Page Up/Down must still wrap rather than no-op.
  let selectedAfterTenItemPageWrap = "";
  let selectedAfterTenItemPageDown = "";
  await runCommand("", { ...TEST_XAI_MODEL, id: "grok-composer-2.5-fast" }, undefined, async (factory) => {
    const tui = { requestRender() {} };
    const theme = {
      fg: (_color, text) => text,
      bg: (_color, text) => text,
      bold: (text) => text,
    };
    const bindings = {
      "tui.select.up": "up",
      "tui.select.down": "down",
      "tui.select.pageUp": "pageup",
      "tui.select.pageDown": "pagedown",
      "tui.select.confirm": "enter",
      "tui.select.cancel": "escape",
    };
    const keybindings = {
      matches: (data, id) => bindings[id] === data,
    };
    const component = await factory(tui, theme, keybindings, () => {});
    component.handleInput("pageup");
    selectedAfterTenItemPageWrap = component.render(160).find((line) => line.startsWith("> ")) || "";
    component.handleInput("pagedown");
    selectedAfterTenItemPageDown = component.render(160).find((line) => line.startsWith("> ")) || "";
    component.handleInput("escape");
  });
  assert.match(
    selectedAfterTenItemPageWrap,
    /> \[ \] WebSearch/,
    "Page Up must wrap to the last row when exactly ten tools are listed",
  );
  assert.match(
    selectedAfterTenItemPageDown,
    /> \[ \] xai_generate_text/,
    "Page Down must wrap from the last row when exactly ten tools are listed",
  );

  await runCommand("enable xai_web_search", TEST_XAI_MODEL);
  assert.ok(getActiveTools().includes("xai_web_search"), "/xai-tools should explicitly enable an eligible tool");
  assert.match(notifications.at(-1).message, /may use xAI credits/);
  await handlers.get("before_agent_start")?.({}, { model: TEST_XAI_MODEL });
  assert.ok(getActiveTools().includes("xai_web_search"), "before-agent sync should preserve command-based opt-in");

  await runCommand("disable xai_web_search", TEST_XAI_MODEL);
  assert.ok(!getActiveTools().includes("xai_web_search"), "/xai-tools should disable an enabled tool");

  await runCommand("enable WebSearch", TEST_XAI_MODEL);
  assert.ok(!getActiveTools().includes("WebSearch"), "standard xAI models must not enable the Grok CLI WebSearch shim");
  assert.match(notifications.at(-1).message, /only with xAI Grok Build or Composer/);

  const composerModel = { ...TEST_XAI_MODEL, id: "grok-composer-2.5-fast" };
  await handlers.get("model_select")?.({ model: composerModel }, { model: composerModel });
  await runCommand("enable WebSearch", composerModel);
  assert.ok(getActiveTools().includes("WebSearch"), "Grok CLI models should allow deliberate WebSearch enablement");
  await handlers.get("before_agent_start")?.({}, { model: composerModel });
  assert.ok(getActiveTools().includes("WebSearch"), "Grok CLI sync should preserve command-based WebSearch opt-in");

  await handlers.get("model_select")?.({ model: anthropicModel }, { model: anthropicModel });
  await runCommand("enable xai_x_search", anthropicModel);
  assert.ok(!getActiveTools().includes("xai_x_search"), "non-xAI models must not enable paid xAI tools");
  assert.match(notifications.at(-1).message, /Select an xAI\/Grok model/);

  await handlers.get("model_select")?.({ model: TEST_XAI_MODEL }, { model: TEST_XAI_MODEL });
  await runCommand("enable xai_web_search", TEST_XAI_MODEL);
  await runCommand("enable xai_generate_image", TEST_XAI_MODEL);
  assert.ok(getActiveTools().includes("xai_web_search"), "fixture: web search should be authorized");
  assert.ok(getActiveTools().includes("xai_generate_image"), "fixture: image generation should be authorized");
  // Disable with a non-xAI command model (without model_select sync) must remove
  // only the named tool — not wipe every remaining authorization (issue #60).
  await runCommand("disable xai_web_search", anthropicModel);
  assert.ok(!getActiveTools().includes("xai_web_search"), "disable without an xAI model should remove the named tool");
  assert.ok(
    getActiveTools().includes("xai_generate_image"),
    "disable without an xAI model must preserve other authorized tools in the registry",
  );
  await handlers.get("before_agent_start")?.({}, { model: TEST_XAI_MODEL });
  assert.ok(
    getActiveTools().includes("xai_generate_image"),
    "remaining authorization must survive lifecycle sync after a selective disable",
  );
  await runCommand("status", TEST_XAI_MODEL);
  assert.match(notifications.at(-1).message, /xai_web_search=disabled/);
  assert.match(notifications.at(-1).message, /xai_generate_image=enabled/);
  await runCommand("disable xai_generate_image", TEST_XAI_MODEL);

  let pickerPass = 0;
  let pickerTitle = "";
  let pickerOptions = [];
  await runCommand("", TEST_XAI_MODEL, (title, options) => {
    pickerTitle = title;
    pickerOptions = options;
    pickerPass += 1;
    return pickerPass === 1
      ? options.find((option) => option.includes("xai_web_search"))
      : "Done";
  }, undefined, "rpc");
  assert.ok(getActiveTools().includes("xai_web_search"), "RPC /xai-tools should toggle the selected network tool");
  assert.match(pickerTitle, /explicit opt-in/);
  assert.ok(
    pickerOptions.some((option) => option.includes("xai_generate_image") && option.includes("image") && option.includes("per image")),
    "interactive /xai-tools should expose image generation with category and cost-risk context",
  );

  await runCommand("status", TEST_XAI_MODEL);
  assert.match(notifications.at(-1).message, /xai_web_search=enabled/);
  assert.match(notifications.at(-1).message, /xai_generate_image=disabled/);
  for (const toolName of XAI_NETWORK_TOOLS) {
    assert.match(
      notifications.at(-1).message,
      new RegExp(`${toolName}=(?:enabled|disabled|unavailable)`),
      `/xai-tools status must include ${toolName}`,
    );
  }

  await runCommand("disable xai_web_search", TEST_XAI_MODEL);
  setToolRegistryFailures({ get: true });
  await runCommand("enable xai_web_search", TEST_XAI_MODEL);
  setToolRegistryFailures();
  assert.ok(!getActiveTools().includes("xai_web_search"), "registry read failures must keep command enablement fail-closed");
  assert.match(notifications.at(-1).message, /could not be read/);
  setToolRegistryFailures({ set: true });
  await runCommand("enable xai_web_search", TEST_XAI_MODEL);
  assert.ok(!getActiveTools().includes("xai_web_search"), "registry write failures must not partially enable a paid tool");
  assert.match(notifications.at(-1).message, /could not be updated/);
  setToolRegistryFailures();

  loadResult.setActiveTools([...getActiveTools(), ...XAI_NETWORK_TOOLS]);
  setToolRegistryFailures({ set: true });
  await handlers.get("session_start")?.({}, { model: TEST_XAI_MODEL });
  setToolRegistryFailures();
  assert.ok(XAI_NETWORK_TOOLS.every((name) => getActiveTools().includes(name)), "the fixture should retain stale default-active tools after a failed reset");
  await runCommand("enable xai_web_search", TEST_XAI_MODEL);
  assert.ok(getActiveTools().includes("xai_web_search"), "the deliberately selected tool should be enabled after registry recovery");
  assert.ok(
    XAI_NETWORK_TOOLS.filter((name) => name !== "xai_web_search").every((name) => !getActiveTools().includes(name)),
    "enabling one tool after reset recovery must strip every stale unauthorized network tool",
  );
  await handlers.get("before_agent_start")?.({}, { model: TEST_XAI_MODEL });
  assert.deepStrictEqual(
    XAI_NETWORK_TOOLS.filter((name) => getActiveTools().includes(name)),
    ["xai_web_search"],
    "lifecycle sync must preserve only individually authorized network tools",
  );
}

function inlineImageUrls(value, urls = []) {
  if (Array.isArray(value)) {
    for (const item of value) inlineImageUrls(item, urls);
    return urls;
  }
  if (!value || typeof value !== "object") return urls;
  if (value.type === "input_image" && typeof value.image_url === "string" && value.image_url.startsWith("data:image/")) {
    urls.push(value.image_url);
  }
  for (const child of Object.values(value)) inlineImageUrls(child, urls);
  return urls;
}

function inlineImageBase64Bytes(value) {
  return inlineImageUrls(value).reduce((total, url) => total + Buffer.byteLength(url.split(",", 2)[1] || "", "utf8"), 0);
}

function toolImageOutput(imageUrl, callId = "call_image") {
  return {
    type: "function_call_output",
    call_id: callId,
    output: [
      { type: "input_text", text: "screenshot result" },
      { type: "input_image", image_url: imageUrl, detail: "auto" },
    ],
  };
}

async function verifyXaiImageLifecycle() {
  const tinyImageUrl = `data:image/png;base64,${Buffer.from("tiny-image-fixture").toString("base64")}`;
  const assistantOutputs = [
    { type: "reasoning", summary: [] },
    { type: "function_call", call_id: "next_call", name: "read", arguments: "{}" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ];

  for (const assistantOutput of assistantOutputs) {
    const rewritten = rewriteXaiResponsesPayload(
      { model: TEST_XAI_MODEL.id, input: [toolImageOutput(tinyImageUrl), assistantOutput, { role: "user", content: "next" }] },
      TEST_XAI_MODEL,
    );
    assert.equal(inlineImageUrls(rewritten).length, 0, `${assistantOutput.type} should consume earlier tool-result images`);
    assert.match(JSON.stringify(rewritten), /historical tool image.*omitted/, "consumed tool images should leave an explicit marker");
  }

  const pending = rewriteXaiResponsesPayload(
    { model: TEST_XAI_MODEL.id, input: [toolImageOutput(tinyImageUrl)] },
    TEST_XAI_MODEL,
  );
  assert.equal(inlineImageUrls(pending).length, 1, "a tool image awaiting its first assistant response must be retained");

  const nonAssistantTail = rewriteXaiResponsesPayload(
    {
      model: TEST_XAI_MODEL.id,
      input: [
        toolImageOutput(tinyImageUrl, "pending_a"),
        { role: "user", content: [{ type: "input_text", text: "continue" }] },
        { type: "function_call_output", call_id: "pending_b", output: "text only" },
      ],
    },
    TEST_XAI_MODEL,
  );
  assert.equal(inlineImageUrls(nonAssistantTail).length, 1, "user and tool-output items must not consume a pending tool image");

  const mixed = rewriteXaiResponsesPayload(
    {
      model: TEST_XAI_MODEL.id,
      input: [
        toolImageOutput(tinyImageUrl, "historical"),
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "seen" }] },
        toolImageOutput(tinyImageUrl, "current"),
      ],
    },
    TEST_XAI_MODEL,
  );
  assert.equal(inlineImageUrls(mixed).length, 1, "mixed history should omit consumed images and retain the current pending image");

  const ordinaryUserImage = rewriteXaiResponsesPayload(
    {
      model: TEST_XAI_MODEL.id,
      input: [
        { role: "user", content: [{ type: "input_image", image_url: tinyImageUrl, detail: "auto" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "seen" }] },
      ],
    },
    TEST_XAI_MODEL,
  );
  assert.equal(inlineImageUrls(ordinaryUserImage).length, 1, "ordinary user images must never be pruned by the tool-image lifecycle");
}

async function verifyXaiImageCompaction() {
  const sourceBytes = await fs.readFile(path.join(repoRoot, "preview.jpeg"));
  const sourceBase64 = sourceBytes.toString("base64");
  const sourceUrl = `data:image/jpeg;base64,${sourceBase64}`;
  const payload = {
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: sourceUrl, detail: "auto" },
          { type: "input_image", image_url: sourceUrl, detail: "auto" },
        ],
      },
    ],
  };

  const underBudget = await compactXaiInlineImages(payload, sourceBase64.length * 2 + 1);
  assert.deepEqual(inlineImageUrls(underBudget), [sourceUrl, sourceUrl], "under-budget images within 2000px should remain byte-identical");

  const compactBudget = Math.floor(sourceBase64.length * 1.5);
  const compacted = await compactXaiInlineImages(payload, compactBudget);
  const compactedUrls = inlineImageUrls(compacted);
  assert.equal(compactedUrls.length, 2);
  assert.ok(inlineImageBase64Bytes(compacted) <= compactBudget, "compacted inline images must obey the aggregate budget");
  const { resizeImage } = await import("@earendil-works/pi-coding-agent");
  for (const url of compactedUrls) {
    assert.match(url, /^data:image\/(?:png|jpeg);base64,/);
    const [metadata, data] = url.split(",", 2);
    const inspected = await resizeImage(Buffer.from(data, "base64"), metadata.slice(5).split(";", 1)[0], {
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: Buffer.byteLength(data, "utf8") + 1,
      jpegQuality: 95,
    });
    assert.ok(inspected && inspected.width <= 2000 && inspected.height <= 2000, "compacted image dimensions must stay within 2000px");
  }

  await assert.rejects(
    () => compactXaiInlineImages({ input: [{ type: "input_image", image_url: "data:image/png;base64,bm90LWFuLWltYWdl" }] }, 2),
    /exceeds the safe transport budget and could not be compacted/,
    "undecodable oversized inline images should fail locally instead of reaching xAI",
  );
}

async function verifyXaiImageTransport(provider) {
  const sourceBytes = await fs.readFile(path.join(repoRoot, "preview.jpeg"));
  const oversizedBytes = Buffer.concat(Array(10).fill(sourceBytes));
  const oversizedBase64 = oversizedBytes.toString("base64");
  const oversizedUrl = `data:image/jpeg;base64,${oversizedBase64}`;
  const input = [
    {
      role: "user",
      content: [
        { type: "input_image", image_url: oversizedUrl, detail: "auto" },
        { type: "input_image", image_url: oversizedUrl, detail: "auto" },
        { type: "input_text", text: "Reply exactly OK." },
      ],
    },
  ];

  const beforeDirect = requests.length;
  await createXaiResponse("oauth-token", { model: TEST_XAI_MODEL.id, input, max_output_tokens: 32 });
  const directRequest = requests.slice(beforeDirect).find((entry) => entry.url?.endsWith("/responses"));
  assert.ok(directRequest, "createXaiResponse should send the prepared payload");
  assert.ok(inlineImageBase64Bytes(directRequest.body) <= MAX_XAI_INLINE_IMAGE_BASE64_BYTES);
  assert.ok(inlineImageUrls(directRequest.body).every((url) => url !== oversizedUrl), "direct Responses calls should compact oversized images");

  const beforeStream = requests.length;
  const stream = provider.streamSimple(
    TEST_XAI_MODEL,
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", data: oversizedBase64, mimeType: "image/jpeg" },
            { type: "image", data: oversizedBase64, mimeType: "image/jpeg" },
            { type: "text", text: "Reply exactly OK." },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey: "oauth-token", sessionId: "image-transport-session" },
  );
  await stream.result();
  const streamRequest = requests.slice(beforeStream).find((entry) => entry.url?.endsWith("/responses"));
  assert.ok(streamRequest, "provider streaming should send the prepared payload");
  assert.ok(inlineImageBase64Bytes(streamRequest.body) <= MAX_XAI_INLINE_IMAGE_BASE64_BYTES);
  assert.ok(inlineImageUrls(streamRequest.body).every((url) => url !== oversizedUrl), "streaming Responses calls should compact oversized images");

  const beforeMutatingHook = requests.length;
  const mutatingHookStream = provider.streamSimple(
    TEST_XAI_MODEL,
    { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    {
      apiKey: "oauth-token",
      sessionId: "image-mutating-hook-session",
      onPayload(payload) {
        payload.input = input;
      },
    },
  );
  await mutatingHookStream.result();
  const mutatingHookRequest = requests.slice(beforeMutatingHook).find((entry) => entry.url?.endsWith("/responses"));
  assert.ok(mutatingHookRequest, "an in-place payload hook should still send a prepared request");
  assert.ok(
    inlineImageBase64Bytes(mutatingHookRequest.body) <= MAX_XAI_INLINE_IMAGE_BASE64_BYTES,
    "in-place payload hook mutations must be compacted before transport",
  );
}

async function verifyXaiStreamErrorPrefix(provider) {
  respondToNextXaiRequest(500, { code: "internal", error: "Auth context expired." });
  const message = await captureStreamResultMessage(() =>
    provider.streamSimple(
      TEST_XAI_MODEL,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
      { apiKey: "oauth-token", sessionId: "error-prefix-session" },
    ),
  );
  assert.match(message, /^xAI API error\b/i, "delegated xAI transport errors should be labeled as xAI errors");
  assert.doesNotMatch(message, /^OpenAI API error\b/i);
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

async function verifyOpenAIResponsesTransport() {
  const { streamSimple } = await import("@earendil-works/pi-ai/compat");
  const context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
  const baseModel = {
    id: "grok-4.3",
    provider: "xai-auth",
    baseUrl: "https://api.x.ai/v1",
    headers: {},
    reasoning: true,
    input: ["text", "image"],
  };

  const before = requests.length;
  await captureStreamResultMessage(() =>
    streamSimple({ ...baseModel, api: "openai-responses" }, context, { apiKey: "oauth-token" }),
  );
  assert.ok(
    requests.slice(before).some((entry) => entry.url && urlOriginIs(entry.url, "https://api.x.ai")),
    "OpenAI Responses transport should reach the configured xAI endpoint",
  );
}

async function verifyXaiResponsesTransport(provider) {
  const { registerApiProvider, resetApiProviders } = await import("@earendil-works/pi-ai/compat");
  let compatDispatcherCalled = false;
  registerApiProvider({
    api: "openai-responses",
    stream() {
      compatDispatcherCalled = true;
      throw new Error("conflicting compat stream should not be called");
    },
    streamSimple() {
      compatDispatcherCalled = true;
      throw new Error("conflicting compat streamSimple should not be called");
    },
  }, "verify-conflicting-extension");

  const before = requests.length;
  let message;
  try {
    message = await captureStreamResultMessage(() =>
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
  } finally {
    resetApiProviders();
  }
  assert.ok(typeof message === "string", "xAI provider stream should expose a terminal result message");
  assert.equal(compatDispatcherCalled, false, "xAI stream should bypass conflicting compat API registrations");
  assert.ok(
    requests.slice(before).some((entry) => entry.url && urlOriginIs(entry.url, "https://api.x.ai")),
    "xAI stream should reach the xAI endpoint through the OpenAI Responses transport",
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
    assert.ok(firstLoad.commands.has("xai-tools"), "the xAI paid-tool command should be registered");
    assert.equal(secondLoad.commands.size, firstLoad.commands.size, "extension reloads should register commands on the new pi API object");
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

    await verifyXaiNetworkToolActivation(firstLoad);
    await verifyXaiToolsCommand(firstLoad);
    await verifyXaiImageLifecycle();
    await verifyXaiImageCompaction();

    await verifyOpenAIResponsesTransport();
    await verifyXaiResponsesTransport(provider);

    await verifyXaiImageTransport(provider);
    await verifyXaiStreamErrorPrefix(provider);

    await verifyCliModelStreamRouting(provider);
    await verifyCursorToolActivation(firstLoad);
    await verifyCursorToolShims(firstLoad);

    await verifyOAuthCallbackState(provider);
    await verifyOAuthManualRawCode(provider);
    await verifyOAuthManualCallbackUrlState(provider);
    await verifyOAuthManualWrongStateIgnored(provider);

    await firstLoad.commands.get("xai-tools").handler(
      "enable xai_generate_text",
      extensionCommandContext(TEST_XAI_MODEL),
    );
    const noAuthResult = await tools.get("xai_generate_text").execute("call_noauth", { prompt: "hi" }, undefined, () => {}, {
      model: TEST_XAI_MODEL,
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

    for (const toolName of CUSTOM_XAI_NETWORK_TOOLS) {
      await firstLoad.commands.get("xai-tools").handler(
        `enable ${toolName}`,
        extensionCommandContext(TEST_XAI_MODEL),
      );
    }
    const { body: webBody } = await runTool(tools, "xai_web_search", { query: "xAI docs" });
    assert.deepEqual(webBody.tools, [{ type: "web_search", enable_image_understanding: true }]);
    assert.equal(webBody.model, TEST_XAI_MODEL.id, "xai_web_search should use the active xAI model");

    respondToNextXaiRequest(403, {
      code: "personal-team-blocked:spending-limit",
      error: "You have run out of credits or need a Grok subscription.",
    });
    const beforeProviderError = requests.length;
    const selectedGrok43 = { ...TEST_XAI_MODEL, id: "grok-4.3" };
    const providerErrorResult = await tools.get("xai_web_search").execute(
      "call_provider_error",
      { query: "one attempt" },
      undefined,
      () => {},
      authContext(selectedGrok43),
    );
    assert.match(providerErrorResult.content[0].text, /xAI API Error 403/);
    const providerErrorRequests = requests.slice(beforeProviderError).filter((entry) => urlOriginIs(entry.url, "https://api.x.ai"));
    assert.equal(providerErrorRequests.length, 1, "a provider failure should result in one xAI request, not an implicit retry loop");
    assert.equal(providerErrorRequests[0].body.model, selectedGrok43.id, "provider errors should still use the active selected model");

    const { body: xBody } = await runTool(tools, "xai_x_search", { query: "grok", since: "2026-05-01", until: "2026-05-22" });
    assert.equal(xBody.tools[0].type, "x_search");
    assert.equal(xBody.model, TEST_XAI_MODEL.id, "xai_x_search should use the active xAI model");
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

    const requestsBeforeImageGeneration = requests.length;
    const { body: imageGenBody } = await runTool(tools, "xai_generate_image", { prompt: "a crisp diagram" }, /Generated 1 image/);
    assert.equal(requests.length, requestsBeforeImageGeneration + 1, "enabled image generation should send exactly one xAI request");
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
