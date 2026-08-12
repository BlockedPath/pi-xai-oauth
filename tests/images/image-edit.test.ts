import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XAI_USER_AGENT } from "../../extensions/xai/constants";
import {
  buildXaiImageEditPayload,
  executeXaiImageEdit,
  ImageEditOperationError,
  validateXaiEditImageInput,
  type ImageEditDependencies,
  type XaiEditImageInput,
} from "../../extensions/xai/image-edit";
import type { ImageCodec } from "../../extensions/xai/media/compression";
import {
  IMAGE_EDIT_MAX_OUTPUT_BYTES,
  IMAGE_EDIT_MAX_OUTPUT_PIXELS,
  IMAGE_EDIT_MAX_REQUEST_JSON_BYTES,
  MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES,
} from "../../extensions/xai/media/constants";
import { imageEditOutputRoot } from "../../extensions/xai/media/output-storage";
import { xaiHttpErrorFromResponse } from "../../extensions/xai/wire";
import { createTempDir } from "../fixtures/temp";
import { jsonResponse, requestBody } from "../fixtures/http";
import { pngHeaderBytes, tinyPngBytes } from "../fixtures/images";

const png = tinyPngBytes();
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
const codec: ImageCodec = {
  verify: vi.fn(async (image) => ({ width: image.width, height: image.height })),
  compress: vi.fn(async () => null),
};

describe("image-edit validation and wire payload", () => {
  it("validates bounded prompt, reference shape/count, schemes, and multi-image ratio", () => {
    expect(validateXaiEditImageInput({ prompt: "edit", image: [{ data_url: dataUrl }] })).toMatchObject({
      prompt: "edit",
    });
    expect(validateXaiEditImageInput({
      prompt: "edit",
      image: [{ path: "C:\\workspace\\image.png" }],
    })).toMatchObject({ image: [{ path: "C:\\workspace\\image.png" }] });
    for (const input of [
      {},
      { prompt: " ", image: [{ data_url: dataUrl }] },
      { prompt: "edit", image: [] },
      { prompt: "edit", image: Array.from({ length: 4 }, () => ({ data_url: dataUrl })) },
      { prompt: "edit", image: [{ path: "a", data_url: dataUrl }] },
      { prompt: "edit", image: [{ path: "https://example.test/a.png" }] },
      { prompt: "edit", image: [{ path: "file:///tmp/a.png" }] },
      { prompt: "edit", image: [{ data_url: dataUrl }], aspect_ratio: "bad" },
      { prompt: "edit", image: [{ data_url: dataUrl }], aspect_ratio: 1 },
      { prompt: "edit", image: [{ data_url: dataUrl }, { data_url: dataUrl }] },
      { prompt: "edit", image: [{ data_url: dataUrl }, { data_url: dataUrl }], aspect_ratio: "bad" },
    ]) {
      expect(() => validateXaiEditImageInput(input)).toThrow(ImageEditOperationError);
    }
  });

  it("builds the exact singular body and omits aspect_ratio even when supplied", () => {
    const input = validateXaiEditImageInput({
      prompt: "edit",
      image: [{ data_url: dataUrl }],
      aspect_ratio: "16:9",
    });
    expect(buildXaiImageEditPayload(input, [{
      dataUrl,
      mimeType: "image/png",
      byteLength: png.length,
      width: 1,
      height: 1,
      wasCompressed: false,
    }])).toEqual({
      model: "grok-imagine-image-2.0",
      prompt: "edit",
      n: 1,
      resolution: "1k",
      response_format: "b64_json",
      image: { url: dataUrl },
    });
  });

  it("builds the exact plural body with a validated aspect ratio", () => {
    const input = validateXaiEditImageInput({
      prompt: "combine",
      image: [{ data_url: dataUrl }, { data_url: dataUrl }],
      aspect_ratio: "4:3",
    });
    const reference = { dataUrl, mimeType: "image/png" as const, byteLength: png.length, width: 1, height: 1, wasCompressed: false };
    expect(buildXaiImageEditPayload(input, [reference, reference])).toEqual({
      model: "grok-imagine-image-2.0",
      prompt: "combine",
      n: 1,
      resolution: "1k",
      response_format: "b64_json",
      images: [{ url: dataUrl }, { url: dataUrl }],
      aspect_ratio: "4:3",
    });
  });

  it("accepts three references but rejects four", () => {
    const three = Array.from({ length: 3 }, () => ({ data_url: dataUrl }));
    expect(validateXaiEditImageInput({
      prompt: "combine",
      image: three,
      aspect_ratio: "1:1",
    }).image).toHaveLength(3);
    expect(() => validateXaiEditImageInput({
      prompt: "combine",
      image: [...three, { data_url: dataUrl }],
      aspect_ratio: "1:1",
    })).toThrow(/1-3 references/);
  });

  it("rejects an oversized serialized request before transport", () => {
    const input = validateXaiEditImageInput({
      prompt: "edit",
      image: [{ data_url: dataUrl }],
    });
    expect(() => buildXaiImageEditPayload(input, [{
      dataUrl: `data:image/png;base64,${"A".repeat(IMAGE_EDIT_MAX_REQUEST_JSON_BYTES)}`,
      mimeType: "image/png",
      byteLength: 1,
      width: 1,
      height: 1,
      wasCompressed: false,
    }])).toThrow(/aggregate request-byte limit/);
  });
});

describe("bounded xAI image-edit execution", () => {
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  let workspaceRoot: string;
  let sessionRoot: string;
  let requests: Array<{ url: string; init: RequestInit; body: any }>;
  const sessionManager = () => ({ getSessionDir: () => sessionRoot, getSessionId: () => "image-edit-session" });
  const input = (): XaiEditImageInput => ({ prompt: "make it blue", image: [{ data_url: dataUrl }] });

  beforeEach(async () => {
    temp = await createTempDir("pi-xai-image-edit-");
    workspaceRoot = join(temp.path, "workspace");
    sessionRoot = join(temp.path, "sessions");
    await Promise.all([mkdir(workspaceRoot), mkdir(sessionRoot)]);
    requests = [];
  });
  afterEach(async () => temp.cleanup());

  function dependencies(response: Response = jsonResponse({ data: [{ b64_json: png.toString("base64") }] })): ImageEditDependencies {
    return {
      codec,
      fetch: vi.fn(async (url: any, init: RequestInit = {}) => {
        requests.push({ url: String(url), init, body: requestBody(init) });
        return response;
      }),
    };
  }

  it.each(["oauth-session", "api-key"] as const)(
    "posts %s only to the pinned edit route with protected direct-media headers",
    async (kind) => {
      const output = await executeXaiImageEdit({
        credential: { kind, token: "secret-token" },
        input: input(),
        workspaceRoot,
        sessionManager: sessionManager(),
      }, dependencies());
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("https://api.x.ai/v1/images/edits");
      expect(requests[0].init.redirect).toBe("error");
      const headers = new Headers(requests[0].init.headers);
      expect(headers.get("Accept")).toBe("application/json");
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("Authorization")).toBe("Bearer secret-token");
      expect(headers.get("User-Agent")).toBe(XAI_USER_AGENT);
      for (const name of [
        "x-authenticateresponse",
        "x-grok-client-identifier",
        "x-grok-client-mode",
        "x-grok-client-version",
        "x-grok-conv-id",
        "x-grok-model-override",
        "x-grok-req-id",
        "x-grok-session-id",
        "x-xai-token-auth",
      ]) {
        expect(headers.get(name)).toBeNull();
      }
      expect(requests[0].body).toMatchObject({
        model: "grok-imagine-image-2.0",
        n: 1,
        response_format: "b64_json",
        image: { url: dataUrl },
      });
      expect(requests[0].body).not.toHaveProperty("images");
      expect(requests[0].body).not.toHaveProperty("aspect_ratio");
      expect(output).toMatchObject({ mimeType: "image/png", width: 1, height: 1, byteLength: png.length });
      expect((await lstat(output.path)).mode & 0o777).toBe(0o600);
    },
  );

  it("preserves caller cancellation and performs no output save", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: any, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const pending = executeXaiImageEdit({
      credential: { kind: "oauth-session", token: "token" },
      input: input(),
      workspaceRoot,
      sessionManager: sessionManager(),
      signal: controller.signal,
    }, { codec, fetch: fetchMock });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await expect(lstat(imageEditOutputRoot(sessionManager()))).rejects.toThrow();
  });

  it("rejects pre-cancellation before session, codec, filesystem, or network access", async () => {
    const controller = new AbortController();
    controller.abort();
    const session = {
      getSessionDir: vi.fn(() => {
        throw new Error("must not inspect session storage");
      }),
      getSessionId: vi.fn(() => {
        throw new Error("must not inspect session storage");
      }),
    };
    const verify = vi.fn();
    const fetchMock = vi.fn();
    await expect(executeXaiImageEdit({
      credential: { kind: "oauth-session", token: "token" },
      input: input(),
      workspaceRoot,
      sessionManager: session,
      signal: controller.signal,
    }, {
      codec: { verify, compress: vi.fn() },
      fetch: fetchMock,
    })).rejects.toMatchObject({ code: "cancelled" });
    expect(session.getSessionDir).not.toHaveBeenCalled();
    expect(session.getSessionId).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a timed-out request", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: any, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init.signal as AbortSignal;
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    await expect(executeXaiImageEdit({
      credential: { kind: "oauth-session", token: "token" },
      input: input(),
      workspaceRoot,
      sessionManager: sessionManager(),
    }, { codec, fetch: fetchMock, requestTimeoutMs: 5 })).rejects.toMatchObject({ code: "timeout" });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("times out a stalled successful response body", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start() {},
    });
    await expect(executeXaiImageEdit({
      credential: { kind: "oauth-session", token: "token" },
      input: input(),
      workspaceRoot,
      sessionManager: sessionManager(),
    }, {
      ...dependencies(new Response(stalled, { status: 200 })),
      requestTimeoutMs: 5,
    })).rejects.toMatchObject({ code: "timeout" });
  });

  it("cancels a stalled successful response body", async () => {
    const controller = new AbortController();
    const stalled = new ReadableStream<Uint8Array>({
      start() {},
    });
    const pending = executeXaiImageEdit({
      credential: { kind: "oauth-session", token: "token" },
      input: input(),
      workspaceRoot,
      sessionManager: sessionManager(),
      signal: controller.signal,
    }, dependencies(new Response(stalled, { status: 200 })));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("redacts hostile HTTP bodies, prompt, source data, and bearer", async () => {
    const hostile = `secret-token make it blue ${dataUrl}`;
    const error = await executeXaiImageEdit({
      credential: { kind: "oauth-session", token: "secret-token" },
      input: input(),
      workspaceRoot,
      sessionManager: sessionManager(),
    }, dependencies(jsonResponse({ error: hostile }, 400, { "x-request-id": "safe-id" }))).catch((value) => value);
    expect(error).toMatchObject({ code: "http_failure", status: 400 });
    expect(String(error)).toContain("safe-id");
    expect(String(error)).not.toContain("secret-token");
    expect(String(error)).not.toContain("make it blue");
    expect(String(error)).not.toContain(dataUrl);
  });

  it("does not reflect a non-allowlisted upstream request ID", async () => {
    const hostileId = "unsafe request id SECRET";
    const error = await executeXaiImageEdit({
      credential: { kind: "oauth-session", token: "token" },
      input: input(),
      workspaceRoot,
      sessionManager: sessionManager(),
    }, dependencies(jsonResponse({}, 500, { "x-request-id": hostileId }))).catch((value) => value);
    expect(error).toMatchObject({ code: "http_failure", status: 500 });
    expect(String(error)).not.toContain(hostileId);
    expect(String(error)).not.toContain("Request ID:");
  });

  it("classifies the pinned edit route without reflecting its error body", async () => {
    const error = await xaiHttpErrorFromResponse(
      new Response("HOSTILE_EDIT_ERROR", { status: 422 }),
      "https://api.x.ai/v1/images/edits",
    );
    expect(error).toMatchObject({ status: 422, routeKind: "image-edit" });
    expect(error.message).toBe("xAI API error: image editing failed with status 422");
    expect(error.message).not.toContain("HOSTILE_EDIT_ERROR");
  });

  it("redacts arbitrary codec verification failures", async () => {
    const hostileCodec: ImageCodec = {
      verify: vi.fn(async () => {
        throw new Error(`CODEC_SECRET ${dataUrl}`);
      }),
      compress: vi.fn(async () => null),
    };
    const error = await executeXaiImageEdit({
      credential: { kind: "oauth-session", token: "token" },
      input: input(),
      workspaceRoot,
      sessionManager: sessionManager(),
    }, {
      ...dependencies(),
      codec: hostileCodec,
    }).catch((value) => value);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect(String(error)).toContain("could not be verified or compressed safely");
    expect(String(error)).not.toMatch(/CODEC_SECRET|data:image/);
    expect(requests).toHaveLength(0);
  });

  it("redacts arbitrary codec compression failures", async () => {
    const source = Buffer.concat([
      pngHeaderBytes(100, 100),
      Buffer.alloc(MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES),
    ]);
    const sourceUrl = `data:image/png;base64,${source.toString("base64")}`;
    const hostileCodec: ImageCodec = {
      verify: vi.fn(async (image) => ({ width: image.width, height: image.height })),
      compress: vi.fn(async () => {
        throw new Error(`COMPRESSION_SECRET ${sourceUrl}`);
      }),
    };
    const error = await executeXaiImageEdit({
      credential: { kind: "oauth-session", token: "token" },
      input: { prompt: "edit", image: [{ data_url: sourceUrl }] },
      workspaceRoot,
      sessionManager: sessionManager(),
    }, {
      ...dependencies(),
      codec: hostileCodec,
    }).catch((value) => value);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect(String(error)).toContain("could not be verified or compressed safely");
    expect(String(error)).not.toMatch(/COMPRESSION_SECRET|data:image/);
    expect(requests).toHaveLength(0);
  });

  it("rejects oversized response JSON before parsing", async () => {
    await expect(executeXaiImageEdit({
      credential: { kind: "oauth-session", token: "token" },
      input: input(),
      workspaceRoot,
      sessionManager: sessionManager(),
    }, {
      ...dependencies(new Response("x".repeat(65), { status: 200 })),
      responseMaxBytes: 64,
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("verifies and persists a real JPEG response with the matching extension", async () => {
    const jpeg = await readFile("preview.jpeg");
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [{ b64_json: jpeg.toString("base64") }],
    }));
    const output = await executeXaiImageEdit({
      credential: { kind: "oauth-session", token: "token" },
      input: input(),
      workspaceRoot,
      sessionManager: sessionManager(),
    }, { fetch: fetchMock });
    expect(output).toMatchObject({
      mimeType: "image/jpeg",
      width: 1672,
      height: 941,
      byteLength: jpeg.length,
    });
    expect(output.path).toMatch(/\.jpg$/);
  });

  it.each([
    ["decoded side", { width: 4_097, height: 1 }],
    ["decoded pixels", { width: 4_000, height: Math.floor(IMAGE_EDIT_MAX_OUTPUT_PIXELS / 4_000) + 1 }],
  ])("reapplies the %s limit after codec verification", async (_label, decoded) => {
    const decodedCodec: ImageCodec = {
      verify: vi.fn(async (image) => image.source === "output"
        ? decoded
        : { width: image.width, height: image.height }),
      compress: vi.fn(async () => null),
    };
    await expect(executeXaiImageEdit({
      credential: { kind: "oauth-session", token: "token" },
      input: input(),
      workspaceRoot,
      sessionManager: sessionManager(),
    }, {
      ...dependencies(),
      codec: decodedCodec,
    })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(lstat(imageEditOutputRoot(sessionManager()))).rejects.toThrow();
  });

  it.each([
    ["missing data", {}],
    ["empty data", { data: [] }],
    ["multiple data", { data: [{ b64_json: png.toString("base64") }, { b64_json: png.toString("base64") }] }],
    ["URL-only output", { data: [{ url: "https://example.test/image.png" }] }],
    ["malformed base64", { data: [{ b64_json: "%%%%" }] }],
    ["unsupported MIME", { data: [{ b64_json: Buffer.from("GIF89a").toString("base64") }] }],
    ["oversized dimensions", { data: [{ b64_json: pngHeaderBytes(4097, 1).toString("base64") }] }],
    [
      "oversized pixels",
      { data: [{ b64_json: pngHeaderBytes(4000, Math.floor(IMAGE_EDIT_MAX_OUTPUT_PIXELS / 4000) + 1).toString("base64") }] },
    ],
    [
      "oversized decoded bytes",
      { data: [{ b64_json: Buffer.concat([png, Buffer.alloc(IMAGE_EDIT_MAX_OUTPUT_BYTES)]).toString("base64") }] },
    ],
  ])("rejects %s without saving", async (_label, body) => {
    await expect(executeXaiImageEdit({
      credential: { kind: "oauth-session", token: "token" },
      input: input(),
      workspaceRoot,
      sessionManager: sessionManager(),
    }, dependencies(jsonResponse(body)))).rejects.toMatchObject({ code: "invalid_response" });
  });
});
