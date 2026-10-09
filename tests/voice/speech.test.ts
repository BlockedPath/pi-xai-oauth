import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildXaiTextToSpeechPayload,
  executeXaiTextToSpeech,
  validateXaiTextToSpeechInput,
} from "../../extensions/xai/voice/speech";
import { XaiVoiceOperationError } from "../../extensions/xai/voice/common";
import { audioResponse, mp3Bytes, wavBytes } from "../fixtures/audio";
import { jsonResponse } from "../fixtures/http";
import { createTempDir } from "../fixtures/temp";

let temp: Awaited<ReturnType<typeof createTempDir>>;
let sessions: string;

beforeEach(async () => {
  temp = await createTempDir("pi-xai-tts-");
  sessions = join(temp.path, "sessions");
  await mkdir(sessions);
});

afterEach(async () => {
  await temp.cleanup();
});

function sessionManager(dir = sessions) {
  return { getSessionDir: () => dir, getSessionId: () => "tts-session" };
}

async function run(
  fetchImpl: (url: any, init?: RequestInit) => Promise<Response>,
  input: unknown = { text: "Hello from Grok" },
  options: { kind?: "oauth-session" | "api-key"; signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number } = {},
) {
  return executeXaiTextToSpeech({
    credential: { kind: options.kind ?? "oauth-session", token: "oauth-token" },
    input: validateXaiTextToSpeechInput(input),
    sessionManager: sessionManager(),
    signal: options.signal,
  }, {
    fetch: fetchImpl as typeof fetch,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  });
}

describe("xAI text to speech", () => {
  it("validates defaults and builds the exact pinned payload", () => {
    const input = validateXaiTextToSpeechInput({ text: "Hi [pause] there" });
    expect(input).toEqual({ text: "Hi [pause] there", voice: "eve", language: "auto", format: "mp3" });
    expect(buildXaiTextToSpeechPayload(input)).toEqual({
      text: "Hi [pause] there",
      voice_id: "eve",
      language: "auto",
      output_format: { codec: "mp3" },
    });
    expect(buildXaiTextToSpeechPayload(validateXaiTextToSpeechInput({
      text: "Hola",
      voice: "rex",
      language: "pt-BR",
      format: "wav",
      speed: 1.25,
    }))).toEqual({
      text: "Hola",
      voice_id: "rex",
      language: "pt-BR",
      output_format: { codec: "wav" },
      speed: 1.25,
    });
  });

  it.each([
    [null, /must be an object/],
    [[], /must be an object/],
    [{ text: "hi", model: "x" }, /unsupported fields/],
    [{ text: "   " }, /non-empty/],
    [{ text: 5 }, /non-empty/],
    [{ text: "x".repeat(5_001) }, /5000-character limit/],
    [{ text: "😀".repeat(5_001) }, /5000-character limit/],
    [{ text: "hi", voice: "custom-voice" }, /voice must be one of eve, ara, rex, sal, leo/],
    [{ text: "hi", language: "english" }, /BCP-47/],
    [{ text: "hi", language: "en-US-x-private-extra" }, /BCP-47/],
    [{ text: "hi", format: "pcm" }, /mp3 or wav/],
    [{ text: "hi", speed: 0.5 }, /between 0.7 and 1.5/],
    [{ text: "hi", speed: Number.NaN }, /between 0.7 and 1.5/],
    [{ text: "hi", speed: "1" }, /between 0.7 and 1.5/],
  ])("rejects invalid input %#", (value, message) => {
    expect(() => validateXaiTextToSpeechInput(value)).toThrow(message);
    try {
      validateXaiTextToSpeechInput(value);
    } catch (error) {
      expect(error).toBeInstanceOf(XaiVoiceOperationError);
      expect((error as XaiVoiceOperationError).code).toBe("invalid_input");
    }
  });

  it.each(["oauth-session", "api-key"] as const)(
    "posts the %s bearer to the pinned route and saves private verified audio",
    async (kind) => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const output = await run(async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return audioResponse(mp3Bytes());
      }, { text: "Hello", voice: "ara" }, { kind });
      expect(calls).toHaveLength(1);
      const [{ url, init }] = calls;
      expect(url).toBe("https://api.x.ai/v1/tts");
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init.headers);
      expect(Object.fromEntries(headers.entries())).toEqual({
        accept: "*/*",
        authorization: "Bearer oauth-token",
        "content-type": "application/json",
        "user-agent": expect.stringMatching(/^pi-xai-oauth\//),
      });
      expect(JSON.parse(String(init.body))).toEqual({
        text: "Hello",
        voice_id: "ara",
        language: "auto",
        output_format: { codec: "mp3" },
      });
      expect(output).toMatchObject({ mimeType: "audio/mpeg", byteLength: mp3Bytes().length, voice: "ara", format: "mp3" });
      expect(output.path.startsWith(join(sessions, "pi-xai-oauth"))).toBe(true);
      expect(output.path).toMatch(/[\\/]audio[\\/]xai-speech-\d+-[0-9a-f-]+\.mp3$/);
      expect(await readFile(output.path)).toEqual(mp3Bytes());
      if (process.platform !== "win32") {
        expect((await stat(output.path)).mode & 0o777).toBe(0o600);
      }
    },
  );

  it("saves WAV output with its own extension and MIME type", async () => {
    const output = await run(async () => audioResponse(wavBytes(), "audio/wav"), { text: "Hi", format: "wav" });
    expect(output).toMatchObject({ mimeType: "audio/wav", format: "wav", byteLength: wavBytes().length });
    expect(output.path.endsWith(".wav")).toBe(true);
  });

  it.each([
    ["a JSON body", () => jsonResponse({ audio: "secret-body" }), /unexpected response/],
    ["bytes that are not the requested codec", () => audioResponse(wavBytes()), /did not return valid MP3/],
    ["an empty body", () => new Response(null, { status: 200 }), /did not return valid MP3/],
  ])("rejects %s without saving", async (_name, response, message) => {
    await expect(run(async () => response())).rejects.toMatchObject({
      code: "invalid_response",
      message: expect.stringMatching(message),
    });
    await expect(stat(join(sessions, "pi-xai-oauth"))).rejects.toThrow();
  });

  it("bounds the audio body by declared and streamed length", async () => {
    await expect(run(async () => new Response(new Uint8Array(mp3Bytes()), {
      headers: { "Content-Type": "audio/mpeg", "Content-Length": "999" },
    }), undefined, { maxOutputBytes: 16 })).rejects.toMatchObject({ code: "invalid_response", message: /byte limit/ });
    await expect(run(async () => audioResponse(mp3Bytes()), undefined, { maxOutputBytes: 16 }))
      .rejects.toMatchObject({ code: "invalid_response", message: /byte limit/ });
  });

  it.each([
    [401, /HTTP 401\. Sign in again/],
    [403, /HTTP 403\. This xAI account may not include voice access/],
    [413, /HTTP 413\. The audio or text is too large/],
    [429, /HTTP 429\. xAI rate-limited/],
    [500, /^xAI text to speech failed with HTTP 500\.$/],
  ])("reports HTTP %i by status only", async (status, message) => {
    const error = await run(async () => jsonResponse({ error: "secret upstream detail oauth-token" }, status))
      .catch((caught) => caught);
    expect(error).toMatchObject({ code: "http_failure", status, message: expect.stringMatching(message) });
    expect(error.message).not.toMatch(/secret|oauth-token/);
  });

  it("classifies network failures, timeouts, and cancellation", async () => {
    await expect(run(async () => {
      throw new Error("socket hang up oauth-token");
    })).rejects.toMatchObject({ code: "network_failure", message: expect.not.stringMatching(/oauth-token/) });

    const hanging = (_url: any, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    await expect(run(hanging, undefined, { timeoutMs: 5 })).rejects.toMatchObject({ code: "timeout" });

    const controller = new AbortController();
    const pending = run(hanging, undefined, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("refuses to run without a safe session directory", async () => {
    const fetchMock = vi.fn();
    await expect(executeXaiTextToSpeech({
      credential: { kind: "oauth-session", token: "oauth-token" },
      input: validateXaiTextToSpeechInput({ text: "hi" }),
      sessionManager: sessionManager("relative/dir"),
    }, { fetch: fetchMock as any })).rejects.toMatchObject({ code: "output_failure" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a storage failure without leaking the path", async () => {
    const error = await executeXaiTextToSpeech({
      credential: { kind: "oauth-session", token: "oauth-token" },
      input: validateXaiTextToSpeechInput({ text: "hi" }),
      sessionManager: sessionManager(join(temp.path, "missing-session-root")),
    }, { fetch: (async () => audioResponse(mp3Bytes())) as any }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "output_failure", message: "Generated speech could not be saved safely." });
  });
});
