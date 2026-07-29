import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  executeXaiImageToVideo,
  ImageToVideoOperationError,
  validateXaiImageToVideoInput,
} from "../../extensions/xai/image-to-video";
import { IMAGE_TO_VIDEO_MAX_PROMPT_CHARS } from "../../extensions/xai/media/constants";
import { tinyPngBytes } from "../fixtures/images";
import { jsonResponse } from "../fixtures/http";

function dataUrl(): string {
  return `data:image/png;base64,${tinyPngBytes().toString("base64")}`;
}

function stalledResponse(): Response {
  return new Response(new ReadableStream({ start() {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function run(
  overrides: Partial<Parameters<typeof executeXaiImageToVideo>[0]> = {},
  dependencies: Parameters<typeof executeXaiImageToVideo>[1] = {},
) {
  return executeXaiImageToVideo({
    credential: { kind: "oauth-session", token: "token" },
    input: validateXaiImageToVideoInput({ image: { data_url: dataUrl() } }),
    workspaceRoot: process.cwd(),
    sessionManager: { getSessionDir: () => process.cwd(), getSessionId: () => "session" },
    ...overrides,
  }, { sleep: async () => {}, ...dependencies });
}

async function expectFailure(promise: Promise<unknown>, code: string, message: RegExp): Promise<void> {
  const error = await promise.then(() => undefined, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(ImageToVideoOperationError);
  expect((error as ImageToVideoOperationError).code).toBe(code);
  expect((error as ImageToVideoOperationError).message).toMatch(message);
}

describe("image-to-video input validation", () => {
  it("rejects non-object inputs and malformed image references", () => {
    for (const value of [undefined, null, "input", []]) {
      expect(() => validateXaiImageToVideoInput(value)).toThrow(/must be an object/);
    }
    for (const image of [undefined, null, "image", [], {}, { path: "a", data_url: "b" }, { url: "a" }]) {
      expect(() => validateXaiImageToVideoInput({ image })).toThrow(/exactly one path or data_url/);
    }
    for (const image of [{ path: "" }, { path: "   " }, { data_url: 5 }]) {
      expect(() => validateXaiImageToVideoInput({ image })).toThrow(/must be non-empty/);
    }
  });

  it("accepts Windows drive paths while rejecting URL schemes", () => {
    expect(validateXaiImageToVideoInput({ image: { path: "C:\\frames\\first.png" } }).image)
      .toEqual({ path: "C:\\frames\\first.png" });
    expect(() => validateXaiImageToVideoInput({ image: { path: "file:///frames/first.png" } }))
      .toThrow(/do not accept URL schemes/);
  });

  it("bounds prompts and enumerates duration and resolution", () => {
    expect(() => validateXaiImageToVideoInput({ image: { data_url: dataUrl() }, prompt: "  " }))
      .toThrow(/prompt must be non-empty/);
    expect(() => validateXaiImageToVideoInput({ image: { data_url: dataUrl() }, prompt: 7 }))
      .toThrow(/prompt must be non-empty/);
    expect(() => validateXaiImageToVideoInput({
      image: { data_url: dataUrl() },
      prompt: "a".repeat(IMAGE_TO_VIDEO_MAX_PROMPT_CHARS + 1),
    })).toThrow(/exceeds the length limit/);
    expect(() => validateXaiImageToVideoInput({ image: { data_url: dataUrl() }, prompt: "\u00e9".repeat(9_000) }))
      .toThrow(/exceeds the length limit/);
    expect(() => validateXaiImageToVideoInput({ image: { data_url: dataUrl() }, duration: 8 }))
      .toThrow(/duration must be 6 or 10/);
    expect(() => validateXaiImageToVideoInput({ image: { data_url: dataUrl() }, resolution: "1080p" }))
      .toThrow(/resolution must be 480p or 720p/);
    expect(validateXaiImageToVideoInput({ image: { data_url: dataUrl() }, prompt: "pan out", duration: 10 }))
      .toMatchObject({ prompt: "pan out", duration: 10, resolution: "480p" });
  });
});

describe("image-to-video local preconditions", () => {
  it("reports unavailable session output storage", async () => {
    await expectFailure(run({
      sessionManager: {
        getSessionDir: () => { throw new Error("no session"); },
        getSessionId: () => "session",
      },
    }, { fetch: vi.fn() as any }), "output_failure", /session output directory is unavailable/);
  });

  it("reports unreadable workspace image references", async () => {
    await expectFailure(run({
      input: validateXaiImageToVideoInput({ image: { path: "missing/frame.png" } }),
      workspaceRoot: join(process.cwd(), "tests"),
    }, { fetch: vi.fn() as any }), "invalid_input", /.+/);
  });

  it("reports cancellation raised while reading the image reference", async () => {
    const controller = new AbortController();
    controller.abort();
    await expectFailure(run({
      input: validateXaiImageToVideoInput({ image: { path: "fixtures/images.ts" } }),
      workspaceRoot: join(process.cwd(), "tests"),
      signal: controller.signal,
    }, { fetch: vi.fn() as any }), "cancelled", /video generation was cancelled/);
  });

  it("reports unverifiable image compression", async () => {
    await expectFailure(run({}, {
      fetch: vi.fn() as any,
      codec: {
        verify: async () => { throw new Error("codec down"); },
        compress: async () => null,
      },
    }), "invalid_input", /could not be verified or compressed safely/);
  });

  it("reports cancellation raised during image compression", async () => {
    const controller = new AbortController();
    await expectFailure(run({ signal: controller.signal }, {
      fetch: vi.fn() as any,
      codec: {
        verify: async () => { controller.abort(); throw new Error("cancelled"); },
        compress: async () => null,
      },
    }), "cancelled", /cancelled before submission/);
  });
});

describe("image-to-video transport failures", () => {
  it("maps create transport errors to network, timeout, and cancellation codes", async () => {
    await expectFailure(
      run({}, { fetch: vi.fn(async () => { throw new Error("socket reset"); }) as any }),
      "network_failure",
      /Check the network/,
    );

    const stalledFetch = vi.fn((_url: any, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    await expectFailure(
      run({}, { fetch: stalledFetch as any, createTimeoutMs: 20 }),
      "timeout",
      /video request timed out/,
    );

    const controller = new AbortController();
    const cancellingFetch = vi.fn((_url: any, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      setTimeout(() => controller.abort(), 10);
    }));
    await expectFailure(
      run({ signal: controller.signal }, { fetch: cancellingFetch as any }),
      "cancelled",
      /tracking was cancelled/,
    );
  });

  it("reports create HTTP failures with the upstream status", async () => {
    const error = await run({}, { fetch: vi.fn(async () => jsonResponse({ error: "denied" }, 403)) as any })
      .then(() => undefined, (thrown: unknown) => thrown as ImageToVideoOperationError);
    expect(error?.code).toBe("http_failure");
    expect(error?.status).toBe(403);
  });
});

describe("image-to-video response bounds", () => {
  it("rejects non-JSON, empty, oversized, and malformed create bodies", async () => {
    await expectFailure(
      run({}, { fetch: vi.fn(async () => new Response("ok", { headers: { "Content-Type": "text/plain" } })) as any }),
      "invalid_response",
      /invalid response type/,
    );
    await expectFailure(
      run({}, {
        fetch: vi.fn(async () => new Response(null, { status: 204, headers: { "Content-Type": "application/json" } })) as any,
      }),
      "invalid_response",
      /empty response/,
    );
    await expectFailure(
      run({}, { fetch: vi.fn(async () => jsonResponse({ request_id: "job_1" })) as any, maxJsonBytes: 4 }),
      "invalid_response",
      /exceeded the byte limit/,
    );
    await expectFailure(
      run({}, {
        fetch: vi.fn(async () => new Response("[]", { headers: { "Content-Type": "application/json" } })) as any,
      }),
      "invalid_response",
      /invalid JSON/,
    );
    await expectFailure(
      run({}, {
        fetch: vi.fn(async () => new Response("{oops}", { headers: { "Content-Type": "application/vnd.api+json" } })) as any,
      }),
      "invalid_response",
      /invalid JSON/,
    );
  });

  it("bounds the create body read by time and cancellation", async () => {
    await expectFailure(
      run({}, { fetch: vi.fn(async () => stalledResponse()) as any, createTimeoutMs: 30 }),
      "timeout",
      /video response timed out/,
    );

    const controller = new AbortController();
    await expectFailure(
      run({ signal: controller.signal }, {
        fetch: vi.fn(async () => { setTimeout(() => controller.abort(), 10); return stalledResponse(); }) as any,
      }),
      "cancelled",
      /tracking was cancelled/,
    );
  });

  it("rejects create responses without a safe request identifier", async () => {
    await expectFailure(
      run({}, { fetch: vi.fn(async () => jsonResponse({ request_id: "job/1" })) as any }),
      "invalid_response",
      /invalid request identifier/,
    );
  });
});

describe("image-to-video polling", () => {
  function pollingFetch(responses: Array<() => Response | Promise<Response>>) {
    let index = 0;
    return vi.fn(async (url: any, init: RequestInit = {}) => {
      if (String(url).endsWith("/videos/generations")) return jsonResponse({ request_id: "job_1" });
      const next = responses[Math.min(index++, responses.length - 1)];
      return next.call(null) as any;
    });
  }

  it("gives up after repeated transient poll transport failures", async () => {
    const fetchMock = pollingFetch([() => { throw new Error("socket reset"); }]);
    await expectFailure(run({}, { fetch: fetchMock as any }), "network_failure", /Check the network/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("gives up after repeated transient poll status codes", async () => {
    const fetchMock = pollingFetch([() => jsonResponse({}, 503)]);
    const error = await run({}, { fetch: fetchMock as any })
      .then(() => undefined, (thrown: unknown) => thrown as ImageToVideoOperationError);
    expect(error?.code).toBe("http_failure");
    expect(error?.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("fails fast on non-transient poll status codes", async () => {
    const fetchMock = pollingFetch([() => jsonResponse({}, 404)]);
    await expectFailure(run({}, { fetch: fetchMock as any }), "http_failure", /video status failed with HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed and terminal remote statuses", async () => {
    await expectFailure(
      run({}, { fetch: pollingFetch([() => jsonResponse({ status: "Done!" })]) as any }),
      "invalid_response",
      /status response was invalid/,
    );
    await expectFailure(
      run({}, { fetch: pollingFetch([() => jsonResponse({ status: 3 })]) as any }),
      "invalid_response",
      /status response was invalid/,
    );
    await expectFailure(
      run({}, { fetch: pollingFetch([() => jsonResponse({ status: "expired" })]) as any }),
      "remote_failure",
      /video generation expired/,
    );
  });

  it("rejects completed jobs without a usable download reference", async () => {
    await expectFailure(
      run({}, { fetch: pollingFetch([() => jsonResponse({ status: "done", video: { url: 7 } })]) as any }),
      "invalid_response",
      /without a valid download/,
    );
    await expectFailure(
      run({}, { fetch: pollingFetch([() => jsonResponse({ status: "done" })]) as any }),
      "invalid_response",
      /without a valid download/,
    );
  });

  it("maps download failures to output failures", async () => {
    await expectFailure(
      run({}, {
        fetch: pollingFetch([() => jsonResponse({ status: "done", video: { url: "http://cdn.example.test/a.mp4" } })]) as any,
      }),
      "output_failure",
      /download failed safely/,
    );
  });

  it("reports cancellation raised while downloading", async () => {
    const controller = new AbortController();
    await expectFailure(
      run({ signal: controller.signal }, {
        fetch: pollingFetch([() => {
          controller.abort();
          return jsonResponse({ status: "done", video: { url: "https://cdn.example.test/a.mp4" } });
        }]) as any,
      }),
      "cancelled",
      /Local download was cancelled/,
    );
  });

  it("waits with the built-in abortable sleep between polls", async () => {
    const fetchMock = pollingFetch([() => jsonResponse({ status: "failed" })]);
    const started = Date.now();
    await expectFailure(
      run({}, { fetch: fetchMock as any, sleep: undefined, pollIntervalMs: 25 }),
      "remote_failure",
      /video generation failed/,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it("cancels the built-in sleep when the caller aborts mid-wait", async () => {
    const controller = new AbortController();
    await expectFailure(
      run({ signal: controller.signal }, {
        fetch: vi.fn(async () => {
          setTimeout(() => controller.abort(), 20);
          return jsonResponse({ request_id: "job_1" });
        }) as any,
        sleep: undefined,
        pollIntervalMs: 5_000,
      }),
      "cancelled",
      /remote xAI video job was not cancelled/,
    );
  });
});
