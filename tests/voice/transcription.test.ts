import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeXaiTranscribeAudioFile,
  transcribeXaiAudio,
  validateXaiTranscribeAudioInput,
} from "../../extensions/xai/voice/transcription";
import { mp3Bytes, wavBytes } from "../fixtures/audio";
import { jsonResponse } from "../fixtures/http";
import { createTempDir } from "../fixtures/temp";

const credential = { kind: "oauth-session" as const, token: "oauth-token" };
let temp: Awaited<ReturnType<typeof createTempDir>>;
let workspace: string;

beforeEach(async () => {
  temp = await createTempDir("pi-xai-stt-");
  workspace = join(temp.path, "workspace");
  await mkdir(workspace);
});

afterEach(async () => {
  await temp.cleanup();
});

function recordingFetch(response: () => Response = () => jsonResponse({ text: "hello world" })) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: any, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response();
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("xAI speech to text", () => {
  it("posts multipart audio with language-enabled formatting to the pinned route", async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse({ text: "  Pay $5 at 3pm.\u001b[31m\u0007  ", language: "en", duration: 1.5, words: [] }));
    const result = await transcribeXaiAudio({
      credential,
      audio: { bytes: wavBytes(), mimeType: "audio/wav" },
      language: "en",
    }, { fetch: fetchImpl });
    expect(result).toEqual({ text: "Pay $5 at 3pm.[31m", language: "en", duration: 1.5 });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe("https://api.x.ai/v1/stt");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(Object.fromEntries(new Headers(init.headers).entries())).toEqual({
      accept: "application/json",
      authorization: "Bearer oauth-token",
      "user-agent": expect.stringMatching(/^pi-xai-oauth\//),
    });
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect([...form.keys()]).toEqual(["language", "format", "file"]);
    expect(form.get("language")).toBe("en");
    expect(form.get("format")).toBe("true");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.wav");
    expect(file.type).toBe("audio/wav");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(wavBytes());
  });

  it("omits language and formatting when no language is requested", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ text: "bonjour", language: "not a code!", duration: -1 }));
    const result = await transcribeXaiAudio({
      credential: { kind: "api-key", token: "api-key-token" },
      audio: { bytes: mp3Bytes(), mimeType: "audio/mpeg" },
    }, { fetch: fetchImpl });
    expect(result).toEqual({ text: "bonjour" });
    const form = calls[0]!.init.body as FormData;
    expect([...form.keys()]).toEqual(["file"]);
    expect((form.get("file") as File).name).toBe("audio.mp3");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer api-key-token");
  });

  it.each([
    ["an empty clip", { bytes: Buffer.alloc(0), mimeType: "audio/wav" as const }, undefined],
    ["a mislabeled clip", { bytes: mp3Bytes(), mimeType: "audio/wav" as const }, undefined],
    ["an oversized clip", { bytes: Buffer.concat([wavBytes(), Buffer.alloc(20 * 1024 * 1024)]), mimeType: "audio/wav" as const }, undefined],
    ["an unsupported language", { bytes: wavBytes(), mimeType: "audio/wav" as const }, "auto"],
  ])("rejects %s before any request", async (_name, audio, language) => {
    const { fetchImpl } = recordingFetch();
    await expect(transcribeXaiAudio({ credential, audio, language: language as any }, { fetch: fetchImpl }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-JSON body", () => new Response("hello", { headers: { "Content-Type": "text/plain" } }), /invalid response type/],
    ["invalid JSON", () => new Response("{", { headers: { "Content-Type": "application/json" } }), /invalid JSON/],
    ["a JSON array", () => jsonResponse([]), /invalid response/],
    ["a missing transcript", () => jsonResponse({ language: "en" }), /invalid transcript/],
    ["an oversized transcript", () => jsonResponse({ text: "x".repeat(200_001) }), /invalid transcript/],
  ])("rejects %s", async (_name, response, message) => {
    const { fetchImpl } = recordingFetch(response);
    await expect(transcribeXaiAudio({ credential, audio: { bytes: wavBytes(), mimeType: "audio/wav" } }, { fetch: fetchImpl }))
      .rejects.toMatchObject({ code: "invalid_response", message: expect.stringMatching(message) });
  });

  it("bounds the response body and reports failures by status only", async () => {
    const big = recordingFetch(() => jsonResponse({ text: "x".repeat(100) }));
    await expect(transcribeXaiAudio({ credential, audio: { bytes: wavBytes(), mimeType: "audio/wav" } }, {
      fetch: big.fetchImpl,
      maxResponseBytes: 16,
    })).rejects.toMatchObject({ code: "invalid_response", message: /byte limit/ });

    const denied = recordingFetch(() => jsonResponse({ error: "secret detail" }, 403));
    const error = await transcribeXaiAudio({ credential, audio: { bytes: wavBytes(), mimeType: "audio/wav" } }, {
      fetch: denied.fetchImpl,
    }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "http_failure", status: 403 });
    expect(error.message).toBe("xAI speech to text failed with HTTP 403. This xAI account may not include voice access.");
  });

  it("validates file-transcription input before any I/O", () => {
    expect(validateXaiTranscribeAudioInput({ path: "a.wav" })).toEqual({ path: "a.wav" });
    expect(validateXaiTranscribeAudioInput({ path: "a.wav", language: "ja" })).toEqual({ path: "a.wav", language: "ja" });
    expect(validateXaiTranscribeAudioInput({ path: "C:\\audio\\a.wav" })).toEqual({ path: "C:\\audio\\a.wav" });
    for (const [value, message] of [
      [undefined, /must be an object/],
      [{ path: "a.wav", model: "x" }, /unsupported fields/],
      [{ path: " " }, /one audio file path/],
      [{ path: "a\0.wav" }, /one audio file path/],
      [{ path: "https://example.test/a.mp3" }, /URL schemes/],
      [{ path: "file:///etc/passwd" }, /URL schemes/],
      [{ path: "a.wav", language: "auto" }, /language must be one of/],
    ] as const) {
      expect(() => validateXaiTranscribeAudioInput(value)).toThrow(message);
    }
  });

  it("transcribes a byte-verified workspace file", async () => {
    await writeFile(join(workspace, "memo.mp3"), mp3Bytes());
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ text: "memo text", duration: 2 }));
    const output = await executeXaiTranscribeAudioFile({
      credential,
      input: { path: "memo.mp3", language: "fr" },
      workspaceRoot: workspace,
    }, { fetch: fetchImpl });
    expect(output).toEqual({
      text: "memo text",
      duration: 2,
      path: "memo.mp3",
      mimeType: "audio/mpeg",
      byteLength: mp3Bytes().length,
    });
    expect((calls[0]!.init.body as FormData).get("language")).toBe("fr");
  });

  it("refuses files outside the workspace, non-audio bytes, and oversized files without a request", async () => {
    await writeFile(join(temp.path, "outside.wav"), wavBytes());
    await symlink(join(temp.path, "outside.wav"), join(workspace, "link.wav"));
    await writeFile(join(workspace, "secrets.mp3"), "API_KEY=do-not-upload\n");
    await writeFile(join(workspace, "huge.wav"), Buffer.concat([wavBytes(), Buffer.alloc(20 * 1024 * 1024)]));
    const { fetchImpl } = recordingFetch();
    for (const [path, message] of [
      ["../outside.wav", /outside the workspace/],
      ["link.wav", /outside the workspace/],
      ["missing.wav", /not a readable workspace file/],
      [".", /outside the workspace|regular file/],
      ["secrets.mp3", /must be WAV, MP3/],
      ["huge.wav", /source-byte limit/],
    ] as const) {
      const error = await executeXaiTranscribeAudioFile({
        credential,
        input: { path },
        workspaceRoot: workspace,
      }, { fetch: fetchImpl }).catch((caught) => caught);
      expect(error).toMatchObject({ code: "invalid_input", message: expect.stringMatching(message) });
      expect(error.message).not.toContain(temp.path);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports cancellation while reading the file", async () => {
    await writeFile(join(workspace, "memo.wav"), wavBytes());
    const controller = new AbortController();
    controller.abort();
    await expect(executeXaiTranscribeAudioFile({
      credential,
      input: { path: "memo.wav" },
      workspaceRoot: workspace,
      signal: controller.signal,
    }, { fetch: recordingFetch().fetchImpl })).rejects.toMatchObject({ code: "cancelled" });
  });
});
