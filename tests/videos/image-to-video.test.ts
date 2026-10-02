import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildXaiImageToVideoPayload,
  executeXaiImageToVideo,
  validateVideoRequestId,
  validateXaiImageToVideoInput,
} from "../../extensions/xai/image-to-video";
import { createTempDir } from "../fixtures/temp";
import { tinyPngBytes } from "../fixtures/images";
import { jsonResponse, requestBody } from "../fixtures/http";

function mp4(): Buffer {
  return Buffer.from([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
    0x69, 0x73, 0x6f, 0x32, 0x6d, 0x70, 0x34, 0x32,
    0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76,
    0, 0, 0, 9, 0x6d, 0x64, 0x61, 0x74, 1,
  ]);
}

afterEach(() => vi.restoreAllMocks());

describe("xAI image-to-video", () => {
  it("validates input defaults and exact payload", () => {
    const dataUrl = `data:image/png;base64,${tinyPngBytes().toString("base64")}`;
    const input = validateXaiImageToVideoInput({ image: { data_url: dataUrl } });
    expect(input).toMatchObject({ duration: 6, resolution: "480p" });
    expect(buildXaiImageToVideoPayload(input, {
      dataUrl,
      mimeType: "image/png",
      byteLength: tinyPngBytes().length,
      width: 1,
      height: 1,
      wasCompressed: false,
    })).toEqual({
      model: "grok-imagine-video-1.5-preview",
      prompt: "",
      image: { url: dataUrl },
      duration: 6,
      resolution: "480p",
    });
  });

  it("rejects unsupported fields, remote paths, and unsafe request IDs", () => {
    expect(() => validateXaiImageToVideoInput({ image: { path: "https://example.test/a.png" } }))
      .toThrow(/do not accept URL schemes/);
    expect(() => validateXaiImageToVideoInput({ image: { data_url: "x" }, aspect_ratio: "16:9" }))
      .toThrow(/unsupported fields/);
    for (const id of ["", "a/b", "a.b", "a%2fb", " a", "a?b"]) {
      expect(() => validateVideoRequestId(id)).toThrow(/invalid request identifier/);
    }
  });

  it("runs create, wait, poll, unauthenticated download, and private storage", async () => {
    const temp = await createTempDir("pi-xai-video-");
    const workspace = join(temp.path, "workspace");
    const sessions = join(temp.path, "sessions");
    await Promise.all([mkdir(workspace), mkdir(sessions)]);
    const dataUrl = `data:image/png;base64,${tinyPngBytes().toString("base64")}`;
    const calls: any[] = [];
    const fetchMock = vi.fn(async (url: any, init: RequestInit = {}) => {
      calls.push({ url: String(url), init, body: requestBody(init) });
      if (String(url).endsWith("/videos/generations")) return jsonResponse({ request_id: "job_1" });
      return jsonResponse({ status: "done", video: { url: "https://cdn.example.test/output.mp4?signature=secret" } });
    });
    const request = vi.fn((_options: any, callback: any) => {
      const { EventEmitter } = require("node:events");
      const response = new (require("node:stream").Readable)({ read() {} });
      response.statusCode = 200;
      response.headers = { "content-type": "video/mp4", "content-length": String(mp4().length) };
      const req = new EventEmitter();
      req.end = () => {
        callback(response);
        response.push(mp4());
        response.push(null);
      };
      req.destroy = (error: any) => req.emit("error", error);
      req.once = req.once.bind(req);
      process.nextTick(() => {
        const socket = new EventEmitter();
        socket.remoteAddress = "93.184.216.34";
        req.emit("socket", socket);
        process.nextTick(() => socket.emit("secureConnect"));
      });
      return req;
    });
    const output = await executeXaiImageToVideo({
      credential: { kind: "oauth-session", token: "oauth-token" },
      input: validateXaiImageToVideoInput({ image: { data_url: dataUrl }, duration: 10, resolution: "720p" }),
      workspaceRoot: workspace,
      sessionManager: { getSessionDir: () => sessions, getSessionId: () => "private-session-id" },
    }, {
      fetch: fetchMock as any,
      sleep: async () => {},
      videoDownload: {
        lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as any,
        request: request as any,
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].init.headers.Authorization).toBe("Bearer oauth-token");
    expect(calls[1].init.method).toBe("GET");
    expect(calls[1].init.headers).not.toHaveProperty("Content-Type");
    expect(request.mock.calls[0][0].headers).not.toHaveProperty("Authorization");
    expect(output).toMatchObject({ mimeType: "video/mp4", duration: 10, resolution: "720p", byteLength: 41 });
    expect(output.path).not.toContain("private-session-id");
    if (process.platform !== "win32") expect((await stat(output.path)).mode & 0o777).toBe(0o600);
    await temp.cleanup();
  });

  it("continues through 202 and transient poll failures before terminal failure", async () => {
    const dataUrl = `data:image/png;base64,${tinyPngBytes().toString("base64")}`;
    const responses = [
      jsonResponse({ request_id: "job_1" }),
      jsonResponse({ status: "queued" }, 202),
      jsonResponse({}, 429),
      jsonResponse({ status: "failed" }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    await expect(executeXaiImageToVideo({
      credential: { kind: "oauth-session", token: "token" },
      input: validateXaiImageToVideoInput({ image: { data_url: dataUrl } }),
      workspaceRoot: process.cwd(),
      sessionManager: { getSessionDir: () => process.cwd(), getSessionId: () => "session" },
    }, {
      fetch: fetchMock as any,
      sleep: async () => {},
    })).rejects.toThrow(/generation failed/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("enforces the cumulative generation deadline", async () => {
    const dataUrl = `data:image/png;base64,${tinyPngBytes().toString("base64")}`;
    let now = 0;
    const fetchMock = vi.fn(async (url: any) =>
      String(url).endsWith("/generations")
        ? jsonResponse({ request_id: "job_1" })
        : jsonResponse({ status: "queued" }));
    await expect(executeXaiImageToVideo({
      credential: { kind: "oauth-session", token: "token" },
      input: validateXaiImageToVideoInput({ image: { data_url: dataUrl } }),
      workspaceRoot: process.cwd(),
      sessionManager: { getSessionDir: () => process.cwd(), getSessionId: () => "session" },
    }, {
      fetch: fetchMock as any,
      generationTimeoutMs: 10_000,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    })).rejects.toThrow(/five-minute deadline/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits before polling and reports local cancellation honestly", async () => {
    const controller = new AbortController();
    const dataUrl = `data:image/png;base64,${tinyPngBytes().toString("base64")}`;
    let sleeps = 0;
    await expect(executeXaiImageToVideo({
      credential: { kind: "oauth-session", token: "token" },
      input: validateXaiImageToVideoInput({ image: { data_url: dataUrl } }),
      workspaceRoot: process.cwd(),
      sessionManager: { getSessionDir: () => process.cwd(), getSessionId: () => "session" },
      signal: controller.signal,
    }, {
      fetch: vi.fn(async () => jsonResponse({ request_id: "job_1" })) as any,
      sleep: async () => {
        sleeps++;
        controller.abort();
        throw new DOMException("Cancelled", "AbortError");
      },
    })).rejects.toThrow(/remote xAI video job was not cancelled/);
    expect(sleeps).toBe(1);
  });
});
