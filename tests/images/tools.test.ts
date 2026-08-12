import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCustomXaiTools } from "../../extensions/xai/tools/custom-tools";
import { setXaiNetworkToolActive } from "../../extensions/xai/tools/model-scope";
import {
  CURATED_FALLBACK_MODELS,
  KNOWN_XAI_MODEL_METADATA,
  setXaiRuntimeModels,
} from "../../extensions/xai/models";
import { createExtensionHarness } from "../fixtures/extension-api";
import { authContext, TEST_MODEL } from "../fixtures/models";
import { jsonResponse, requestBody } from "../fixtures/http";
import { XAI_USER_AGENT } from "../../extensions/xai/constants";
let h: ReturnType<typeof createExtensionHarness>;
let requests: any[];
beforeEach(() => {
  h = createExtensionHarness();
  registerCustomXaiTools(h.api);
  setXaiRuntimeModels(KNOWN_XAI_MODEL_METADATA);
  setXaiNetworkToolActive(h.api, TEST_MODEL, "xai_generate_image", true);
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: RequestInit = {}) => {
      requests.push({ url: String(url), init, body: requestBody(init) });
      return jsonResponse({
        data: [{ url: "https://example.test/image.png" }],
      });
    }),
  );
});
afterEach(() => setXaiRuntimeModels(CURATED_FALLBACK_MODELS));
async function execute(params: any) {
  return h.tools
    .get("xai_generate_image")
    .execute("call", params, undefined, () => {}, authContext());
}

describe("xAI image generation tool", () => {
  it("uses the public Images endpoint and omits unsupported defaults", async () => {
    const controller = new AbortController();
    const result = await h.tools
      .get("xai_generate_image")
      .execute(
        "call",
        { prompt: "a diagram" },
        controller.signal,
        () => {},
        authContext(),
      );
    expect(result.content[0].text).toMatch(/Generated 1 image/);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.x.ai/v1/images/generations");
    expect(requests[0].init.redirect).toBe("error");
    expect(requests[0].body).toEqual({
      model: "grok-imagine-image-2.0",
      prompt: "a diagram",
    });
    expect(new Headers(requests[0].init.headers).get("Authorization")).toBe(
      "Bearer oauth-token",
    );
    expect(new Headers(requests[0].init.headers).get("Accept")).toBe(
      "application/json",
    );
    expect(new Headers(requests[0].init.headers).get("User-Agent")).toBe(
      XAI_USER_AGENT,
    );
    expect(new Headers(requests[0].init.headers).get("X-XAI-Token-Auth")).toBeNull();
    expect(new Headers(requests[0].init.headers).get("x-grok-client-mode")).toBeNull();
    expect(requests[0].init.signal).toBe(controller.signal);
    const schema = h.tools.get("xai_generate_image").parameters.properties;
    expect(schema).not.toHaveProperty("size");
    expect(schema.n).toMatchObject({ minimum: 1, maximum: 4 });
    expect(schema.n).not.toHaveProperty("default");
  });
  it("forwards an explicit image count", async () => {
    await execute({ prompt: "three", n: 3 });
    expect(requests[0].body).toMatchObject({ n: 3 });
    expect(requests[0].body).not.toHaveProperty("size");
  });
  it("rejects unsupported size and invalid count before network", async () => {
    expect(
      (await execute({ prompt: "bad", size: "1024x1024" })).content[0].text,
    ).toMatch(/does not support the 'size'/);
    expect(requests).toHaveLength(0);
    expect((await execute({ prompt: "bad", n: 0 })).content[0].text).toMatch(
      /integer from 1 to 4/,
    );
    expect(requests).toHaveLength(0);
  });
  it("passes the Pi cancellation signal to transport", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return jsonResponse({ data: [] });
      }),
    );
    await h.tools
      .get("xai_generate_image")
      .execute(
        "call",
        { prompt: "signal" },
        controller.signal,
        () => {},
        authContext(),
      );
    expect(signal).toBe(controller.signal);
  });
});
