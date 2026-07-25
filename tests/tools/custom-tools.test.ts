import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCustomXaiTools } from "../../extensions/xai/tools/custom-tools";
import {
  setXaiNetworkToolActive,
  XAI_NETWORK_TOOL_NAMES,
} from "../../extensions/xai/tools/model-scope";
import {
  CURATED_FALLBACK_MODELS,
  KNOWN_XAI_MODEL_METADATA,
  setXaiRuntimeModels,
  XaiModelInputProvenance,
} from "../../extensions/xai/models";
import { createExtensionHarness } from "../fixtures/extension-api";
import { authContext, TEST_MODEL } from "../fixtures/models";
import { jsonResponse, requestBody } from "../fixtures/http";
import { tinyPngBytes } from "../fixtures/images";
import { createTempDir } from "../fixtures/temp";
let h: ReturnType<typeof createExtensionHarness>;
let requests: Array<{ url: string; init: RequestInit; body: any }>;
beforeEach(() => {
  vi.stubEnv("HOME", `/tmp/pi-xai-no-auth-${crypto.randomUUID()}`);
  h = createExtensionHarness();
  registerCustomXaiTools(h.api);
  setXaiRuntimeModels(KNOWN_XAI_MODEL_METADATA);
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: RequestInit = {}) => {
      requests.push({ url: String(url), init, body: requestBody(init) });
      return jsonResponse({ id: "resp", output_text: "OK" });
    }),
  );
});
afterEach(() => setXaiRuntimeModels(CURATED_FALLBACK_MODELS));
async function run(name: any, params: any, model: any = TEST_MODEL) {
  setXaiNetworkToolActive(h.api, model, name, true);
  const controller = new AbortController();
  const requestStart = requests.length;
  const result = await h.tools
    .get(name)
    .execute("call", params, controller.signal, () => {}, authContext(model));
  const request = requests.slice(requestStart).at(-1)!;
  expect(result.content[0].text).toBe("OK");
  expect(new Headers(request.init.headers).get("Authorization")).toBe(
    "Bearer oauth-token",
  );
  expect(request.init.signal).toBe(controller.signal);
  return result;
}

describe("custom xAI tools", () => {
  it("registers exactly the custom network-tool catalog", () => {
    expect([...h.tools.keys()].sort()).toEqual(
      XAI_NETWORK_TOOL_NAMES.filter((name) => !name.startsWith("xai_grok_")).sort(),
    );
  });
  it("does not advertise unverified constrained-sampling capability", () => {
    for (const tool of h.tools.values()) {
      expect(tool).not.toHaveProperty("constrainedSampling");
    }
  });
  it.each([
    ["xai_generate_text", { prompt: "guard" }],
    ["xai_x_search", { query: "guard" }],
    ["xai_multi_agent", { query: "guard" }],
    ["xai_deep_research", { topic: "guard" }],
    ["xai_code_execution", { code: "print(1)" }],
    ["xai_generate_image", { prompt: "guard" }],
    ["xai_edit_image", { prompt: "guard", image: [{ path: "secret.png" }] }],
    ["xai_image_to_video", { image: { path: "secret.png" } }],
    ["xai_analyze_image", { image: "https://example.test/a.png" }],
    ["xai_critique", { content: "guard" }],
  ])(
    "blocks disabled %s before credentials or network",
    async (name, params) => {
      let registryTouches = 0;
      const result = await h.tools
        .get(name)
        .execute("call", params, undefined, () => {}, {
          model: TEST_MODEL,
          modelRegistry: {
            find() {
              registryTouches++;
              throw new Error("should not resolve");
            },
          },
        });
      expect(result.content[0].text).toMatch(/is disabled/);
      expect(registryTouches).toBe(0);
      expect(requests).toHaveLength(0);
    },
  );
  it.each(["xai_edit_image", "xai_image_to_video"] as const)(
    "blocks disabled %s without touching params, credentials, filesystem context, or network",
    async (toolName) => {
    const params = new Proxy({}, {
      get() {
        throw new Error("disabled tool must not inspect inputs");
      },
    });
    const result = await h.tools.get(toolName).execute(
      "call",
      params,
      undefined,
      () => {},
      {
        get model() {
          throw new Error("disabled tool must not inspect active model context");
        },
        get cwd() {
          throw new Error("disabled tool must not inspect cwd");
        },
        get sessionManager() {
          throw new Error("disabled tool must not inspect session storage");
        },
        get modelRegistry() {
          throw new Error("disabled tool must not resolve credentials");
        },
      },
    );
    expect(result.content[0].text).toContain(`${toolName} is disabled`);
    expect(requests).toHaveLength(0);
    },
  );
  it("does not fall back to an API-key environment variable", async () => {
    vi.stubEnv("XAI_API_KEY", "must-not-use");
    setXaiNetworkToolActive(h.api, TEST_MODEL, "xai_generate_text", true);
    const result = await h.tools
      .get("xai_generate_text")
      .execute("call", { prompt: "hi" }, undefined, () => {}, {
        model: TEST_MODEL,
        modelRegistry: { find: () => undefined },
      });
    expect(result.content[0].text).toMatch(/No xAI OAuth credentials/);
    expect(requests).toHaveLength(0);
  });
  it("uses Grok 4.5 and high reasoning by default", async () => {
    await run("xai_generate_text", { prompt: "hi", model: "grok-4.5" });
    expect(requests.at(-1)?.body).toMatchObject({
      model: "grok-4.5",
      reasoning: { effort: "high" },
    });
  });
  it("omits reasoning for Composer and uses protected proxy metadata", async () => {
    await run("xai_generate_text", {
      prompt: "hi",
      model: "grok-composer-2.5-fast",
      reasoning_effort: "high",
    });
    const request = requests.at(-1)!;
    expect(request.body.reasoning).toBeUndefined();
    expect(new Headers(request.init.headers).get("x-grok-model-override")).toBe(
      "grok-composer-2.5-fast",
    );
    expect(
      new Headers(request.init.headers).get("x-grok-conv-id"),
    ).toBeTruthy();
  });
  it("maps X date filters and code interpreter", async () => {
    await run("xai_x_search", {
      query: "grok",
      since: "2026-05-01",
      until: "2026-05-22",
    });
    expect(requests.at(-1)?.body.tools[0]).toMatchObject({
      type: "x_search",
      from_date: "2026-05-01",
      to_date: "2026-05-22",
    });
    await run("xai_code_execution", { code: "print(4)" });
    expect(requests.at(-1)?.body.tools).toEqual([{ type: "code_interpreter" }]);
  });
  it("maps image analysis content in image then text order", async () => {
    await run("xai_analyze_image", {
      image: "https://example.test/cat.png",
      question: "what?",
    });
    expect(
      requests.at(-1)?.body.input[0].content.map(({ type }: any) => type),
    ).toEqual(["input_image", "input_text"]);
  });
  it.each([
    ["xai_generate_text", "image_url"],
    ["xai_analyze_image", "image"],
  ] as const)("sends a verified workspace image as a data URL for %s", async (name, imageField) => {
    const temp = await createTempDir("pi-xai-tool-local-image-");
    try {
      const workspace = join(temp.path, "workspace");
      await mkdir(workspace);
      await writeFile(join(workspace, "inside.png"), tinyPngBytes());
      setXaiNetworkToolActive(h.api, TEST_MODEL, name, true);

      const result = await h.tools.get(name).execute(
        "call",
        {
          ...(name === "xai_generate_text" ? { prompt: "describe" } : { question: "what?" }),
          [imageField]: "inside.png",
        },
        undefined,
        () => {},
        { ...authContext(TEST_MODEL), cwd: workspace },
      );

      expect(result.content[0].text).toBe("OK");
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0].body)).toContain("data:image/png;base64,");
      expect(JSON.stringify(requests[0].body)).not.toContain("inside.png");
    } finally {
      await temp.cleanup();
    }
  });
  it.each([
    ["xai_generate_text", "image_url"],
    ["xai_analyze_image", "image"],
  ] as const)(
    "rejects absolute, file URL, traversal, and symlink escapes for %s before fetch",
    async (name, imageField) => {
      const temp = await createTempDir("pi-xai-tool-image-escape-");
      try {
        const workspace = join(temp.path, "workspace");
        const external = join(temp.path, "external");
        const outside = join(external, "SENSITIVE-private.png");
        await mkdir(workspace);
        await mkdir(external);
        await writeFile(outside, tinyPngBytes());
        const inputs = [
          outside,
          pathToFileURL(outside).href,
          relative(workspace, outside),
        ];
        if (process.platform !== "win32") {
          await symlink(outside, join(workspace, "escape.png"));
          inputs.push("escape.png");
        }
        setXaiNetworkToolActive(h.api, TEST_MODEL, name, true);

        for (const input of inputs) {
          const result = await h.tools.get(name).execute(
            "call",
            {
              ...(name === "xai_generate_text" ? { prompt: "describe" } : { question: "what?" }),
              [imageField]: input,
            },
            undefined,
            () => {},
            { ...authContext(TEST_MODEL), cwd: workspace },
          );
          expect(result.content[0].text).toMatch(/Invalid image input.*No xAI request was sent/);
          expect(JSON.stringify(result)).not.toMatch(/SENSITIVE|private\.png|external/);
          expect(requests).toHaveLength(0);
        }
      } finally {
        await temp.cleanup();
      }
    },
  );
  it.each([
    ["xai_generate_text", { prompt: "describe", image_url: "inside.png" }],
    ["xai_analyze_image", { image: "inside.png", question: "what?" }],
  ])("fails closed for local %s input without a workspace context", async (name, params) => {
    setXaiNetworkToolActive(h.api, TEST_MODEL, name as any, true);
    let credentialTouches = 0;
    const result = await h.tools
      .get(name)
      .execute("call", params, undefined, () => {}, {
        model: TEST_MODEL,
        modelRegistry: {
          find() {
            credentialTouches++;
            throw new Error("invalid local input must not resolve or refresh credentials");
          },
          async getApiKeyAndHeaders() {
            credentialTouches++;
            throw new Error("invalid local input must not resolve or refresh credentials");
          },
        },
      });

    expect(result.content[0].text).toMatch(/Invalid image input.*No xAI request was sent/);
    expect(credentialTouches).toBe(0);
    expect(requests).toHaveLength(0);
  });
  it.each([
    ["xai_generate_text", { prompt: "describe", image_url: "https://example.test/generate.png" }],
    ["xai_analyze_image", { image: "https://example.test/analyze.png", question: "what?" }],
  ])("keeps remote %s input compatible without a workspace context", async (name, params) => {
    await run(name, params);
    expect(requests).toHaveLength(1);
  });
  it.each([
    ["xai_generate_text", { prompt: "describe", image_url: "/private/missing/generate-secret.png" }],
    ["xai_analyze_image", { image: "/private/missing/analyze-secret.png", question: "what?" }],
  ])("sanitizes invalid local image errors for %s", async (name, params) => {
    setXaiNetworkToolActive(h.api, TEST_MODEL, name as any, true);

    const result = await h.tools
      .get(name)
      .execute("call", params, undefined, () => {}, authContext(TEST_MODEL));

    expect(result.content[0].text).toMatch(/Invalid image input.*No xAI request was sent/);
    expect(JSON.stringify(result)).not.toMatch(/private|missing|secret\.png/);
    expect(requests).toHaveLength(0);
  });
  it.each([
    ["xai_generate_text", { prompt: "describe", image_url: "https://example.test/generate-private.png" }],
    ["xai_analyze_image", { image: "https://example.test/analyze-private.png", question: "what?" }],
  ])("blocks %s image input for authenticated text-only evidence before fetch", async (name, params) => {
    const catalogModel = {
      ...KNOWN_XAI_MODEL_METADATA[0],
      input: ["text"] as ["text"],
      inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
    };
    const activeModel = { ...TEST_MODEL, input: ["text"] } as any;
    setXaiRuntimeModels([catalogModel]);
    setXaiNetworkToolActive(h.api, activeModel, name as any, true);

    const result = await h.tools
      .get(name)
      .execute("call", params, undefined, () => {}, authContext(activeModel));

    expect(result.content[0].text).toMatch(/explicitly text-only.*no xAI request was sent/);
    expect(JSON.stringify(result)).not.toMatch(/generate-private|analyze-private/);
    expect(requests).toHaveLength(0);
  });
  it("keeps image generation separate from active-model image-input capability", async () => {
    const catalogModel = {
      ...KNOWN_XAI_MODEL_METADATA[0],
      input: ["text"] as ["text"],
      inputProvenance: XaiModelInputProvenance.AuthenticatedAcceptsImages,
    };
    const activeModel = { ...TEST_MODEL, input: ["text"] } as any;
    setXaiRuntimeModels([catalogModel]);
    setXaiNetworkToolActive(h.api, activeModel, "xai_generate_image", true);

    const result = await h.tools
      .get("xai_generate_image")
      .execute(
        "call",
        { prompt: "draw a safe diagram" },
        undefined,
        () => {},
        authContext(activeModel),
      );

    expect(result.content[0].text).toMatch(/Image generation completed/);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toMatch(/\/images\/generations$/);
  });
  it("maps multi-agent effort, tools, and details", async () => {
    const result = await run("xai_multi_agent", {
      query: "latest",
      num_agents: 4,
    });
    const body = requests.at(-1)?.body;
    expect(body).toMatchObject({
      model: "grok-4.20-multi-agent-0309",
      reasoning: { effort: "medium" },
    });
    expect(body.tools.map(({ type }: any) => type)).toEqual([
      "web_search",
      "x_search",
    ]);
    expect(result.details.agents_used).toBe(4);
  });
  it("maps critique and deep research through the active model", async () => {
    await run("xai_critique", { content: "code", aspect: "security" });
    expect(requests.at(-1)?.body).toMatchObject({
      model: "grok-4.5",
      reasoning: { effort: "high" },
    });
    await run("xai_deep_research", { topic: "OAuth", depth: "high" });
    expect(requests.at(-1)?.body.tools.map(({ type }: any) => type)).toEqual([
      "web_search",
      "x_search",
    ]);
  });
});
