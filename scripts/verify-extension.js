#!/usr/bin/env node

const assert = require("assert");
const path = require("path");
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

function loadExtension() {
  const providers = new Map();
  const tools = new Map();
  extension({
    registerProvider(name, config) {
      providers.set(name, config);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  });
  return { providers, tools };
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

async function runTool(tools, name, params = {}, expectedText = "OK") {
  const controller = new AbortController();
  const before = requests.length;
  const result = await tools.get(name).execute("call_test", params, controller.signal, () => {}, authContext());
  const request = requests.slice(before).find((entry) => entry.url?.startsWith("https://api.x.ai"));
  if (expectedText instanceof RegExp) {
    assert.match(result.content[0].text, expectedText, `${name} should surface mocked xAI text`);
  } else {
    assert.equal(result.content[0].text, expectedText, `${name} should surface mocked xAI text`);
  }
  assert.ok(request, `${name} should send a request`);
  assert.equal(request.headers.Authorization, "Bearer oauth-token", `${name} should use OAuth token from pi model registry`);
  assert.strictEqual(request.signal, controller.signal, `${name} should pass the pi cancellation signal`);
  return { body: request.body, result };
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

async function main() {
  process.env.HOME = path.join(repoRoot, ".tmp-empty-home-for-tests");
  process.env.XAI_API_KEY = "must-not-be-used";
  installFetchMock();

  try {
    const { providers, tools } = loadExtension();
    const secondLoad = loadExtension();
    const provider = providers.get("xai-auth");
    assert.ok(provider, "xai-auth provider should be registered");
    assert.equal(secondLoad.tools.size, tools.size, "extension reloads should register tools on the new pi API object");
    assert.equal(provider.api, "xai-responses");
    assert.equal(provider.models.find((model) => model.id === "grok-4.3")?.contextWindow, 1_000_000);
    assert.equal(provider.models.find((model) => model.id === "grok-4.20-0309-reasoning")?.contextWindow, 2_000_000);
    assert.ok(provider.models.some((model) => model.id === "grok-4.20-multi-agent-0309"));
    assert.equal(provider.models.find((model) => model.id === "grok-build")?.contextWindow, 512_000);
    assert.equal(provider.models.find((model) => model.id === "grok-build-0.1")?.contextWindow, 256_000);
    assert.equal(provider.models.find((model) => model.id === "grok-composer-2.5-fast")?.contextWindow, 200_000);
    assert.equal(provider.models.find((model) => model.id === "grok-composer-2.5-fast")?.reasoning, true);

    await verifyOAuthCallbackState(provider);

    const noAuthResult = await tools.get("xai_generate_text").execute("call_noauth", { prompt: "hi" }, undefined, () => {}, {
      modelRegistry: {
        find: () => undefined,
      },
    });
    assert.match(noAuthResult.content[0].text, /No xAI OAuth credentials/, "tools should not fall back to XAI_API_KEY");

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
