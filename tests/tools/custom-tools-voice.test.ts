import { validateToolArguments } from "@earendil-works/pi-ai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCustomXaiTools } from "../../extensions/xai/tools/custom-tools";
import { setXaiNetworkToolActive } from "../../extensions/xai/tools/model-scope";
import { XaiVoiceOperationError } from "../../extensions/xai/voice/common";
import { audioResponse, mp3Bytes, wavBytes } from "../fixtures/audio";
import { createExtensionHarness } from "../fixtures/extension-api";
import { jsonResponse } from "../fixtures/http";
import { authContext, TEST_MODEL } from "../fixtures/models";
import { createTempDir } from "../fixtures/temp";

const voiceErrors = vi.hoisted(() => ({
  ttsValidate: undefined as Error | undefined,
  ttsExecute: undefined as Error | undefined,
  sttValidate: undefined as Error | undefined,
  sttExecute: undefined as Error | undefined,
}));

vi.mock("../../extensions/xai/voice/speech", async () => {
  const actual = await vi.importActual<typeof import("../../extensions/xai/voice/speech")>(
    "../../extensions/xai/voice/speech",
  );
  return {
    ...actual,
    validateXaiTextToSpeechInput: (...args: Parameters<typeof actual.validateXaiTextToSpeechInput>) => {
      if (voiceErrors.ttsValidate) throw voiceErrors.ttsValidate;
      return actual.validateXaiTextToSpeechInput(...args);
    },
    executeXaiTextToSpeech: (...args: Parameters<typeof actual.executeXaiTextToSpeech>) => {
      if (voiceErrors.ttsExecute) return Promise.reject(voiceErrors.ttsExecute);
      return actual.executeXaiTextToSpeech(...args);
    },
  };
});

vi.mock("../../extensions/xai/voice/transcription", async () => {
  const actual = await vi.importActual<typeof import("../../extensions/xai/voice/transcription")>(
    "../../extensions/xai/voice/transcription",
  );
  return {
    ...actual,
    validateXaiTranscribeAudioInput: (...args: Parameters<typeof actual.validateXaiTranscribeAudioInput>) => {
      if (voiceErrors.sttValidate) throw voiceErrors.sttValidate;
      return actual.validateXaiTranscribeAudioInput(...args);
    },
    executeXaiTranscribeAudioFile: (...args: Parameters<typeof actual.executeXaiTranscribeAudioFile>) => {
      if (voiceErrors.sttExecute) return Promise.reject(voiceErrors.sttExecute);
      return actual.executeXaiTranscribeAudioFile(...args);
    },
  };
});

let harness: ReturnType<typeof createExtensionHarness>;
let temp: Awaited<ReturnType<typeof createTempDir>>;
let workspace: string;
let sessions: string;
let requests: Array<{ url: string; init: RequestInit }>;
let respond: () => Response;

beforeEach(async () => {
  Object.assign(voiceErrors, { ttsValidate: undefined, ttsExecute: undefined, sttValidate: undefined, sttExecute: undefined });
  temp = await createTempDir("pi-xai-voice-tools-");
  workspace = join(temp.path, "workspace");
  sessions = join(temp.path, "sessions");
  await Promise.all([mkdir(workspace), mkdir(sessions)]);
  harness = createExtensionHarness();
  registerCustomXaiTools(harness.api);
  setXaiNetworkToolActive(harness.api, TEST_MODEL, "xai_text_to_speech", true);
  setXaiNetworkToolActive(harness.api, TEST_MODEL, "xai_transcribe_audio", true);
  requests = [];
  respond = () => audioResponse(mp3Bytes());
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    return respond();
  }));
});

afterEach(async () => {
  await temp.cleanup();
});

function context(overrides: Record<string, unknown> = {}) {
  return {
    ...authContext(TEST_MODEL),
    cwd: workspace,
    sessionManager: { getSessionDir: () => sessions, getSessionId: () => "voice-tools" },
    ...overrides,
  };
}

async function execute(name: string, params: unknown, ctx: any = context(), signal?: AbortSignal) {
  return harness.tools.get(name).execute("call", params, signal, () => {}, ctx);
}

describe("opt-in Grok voice tools", () => {
  it("publishes strict, sequential schemas without constrained sampling", () => {
    for (const name of ["xai_text_to_speech", "xai_transcribe_audio"]) {
      const tool = harness.tools.get(name);
      expect(tool.executionMode).toBe("sequential");
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool).not.toHaveProperty("constrainedSampling");
    }
    const tts = harness.tools.get("xai_text_to_speech");
    expect(tts.parameters.properties.voice.enum).toEqual(["eve", "ara", "rex", "sal", "leo"]);
    expect(tts.parameters.properties.format.enum).toEqual(["mp3", "wav"]);
    expect(() => validateToolArguments(tts, {
      type: "toolCall",
      id: "call",
      name: "xai_text_to_speech",
      arguments: { text: "hi", voice: "eve" },
    } as any)).not.toThrow();
    expect(harness.tools.get("xai_transcribe_audio").parameters.properties.language.enum).toContain("fil");
  });

  it("synthesizes speech with the active OAuth credential and reports the private file", async () => {
    const controller = new AbortController();
    const result = await execute("xai_text_to_speech", { text: "Ship it [pause] today", voice: "leo" }, context(), controller.signal);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.x.ai/v1/tts");
    expect(new Headers(requests[0]!.init.headers).get("authorization")).toBe("Bearer oauth-token");
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({ text: "Ship it [pause] today", voice_id: "leo" });
    expect(result.content[0].text).toMatch(/^Speech saved to .+\.mp3 \(audio\/mpeg, \d+ bytes, voice leo\)\.$/);
    expect(result.details).toMatchObject({ mimeType: "audio/mpeg", voice: "leo", format: "mp3" });
    expect(await readFile(result.details.path)).toEqual(mp3Bytes());
  });

  it("transcribes a workspace audio file and returns the transcript", async () => {
    await writeFile(join(workspace, "standup.wav"), wavBytes());
    respond = () => jsonResponse({ text: "Standup notes.", language: "en", duration: 3.25 });
    const result = await execute("xai_transcribe_audio", { path: "standup.wav", language: "en" });
    expect(requests[0]!.url).toBe("https://api.x.ai/v1/stt");
    expect(result.content[0].text).toBe("Standup notes.");
    expect(result.details).toEqual({
      path: "standup.wav",
      mimeType: "audio/wav",
      byteLength: wavBytes().length,
      language: "en",
      duration: 3.25,
    });

    respond = () => jsonResponse({ text: "" });
    const silent = await execute("xai_transcribe_audio", { path: "standup.wav" });
    expect(silent.content[0].text).toBe("No speech was detected in the audio file.");
    expect(silent.details).toEqual({ path: "standup.wav", mimeType: "audio/wav", byteLength: wavBytes().length });
  });

  it.each([
    ["xai_text_to_speech", { text: "hi", voice: "darth" }, /voice must be one of/],
    ["xai_transcribe_audio", { path: "https://example.test/a.mp3" }, /URL schemes/],
  ])("reports invalid %s input before credentials or network", async (name, params, message) => {
    let registryTouches = 0;
    const result = await execute(name, params, context({
      modelRegistry: {
        find() {
          registryTouches++;
          return undefined;
        },
      },
    }));
    expect(result.content[0].text).toMatch(message);
    expect(result.details).toEqual({ error: true, code: "invalid_input" });
    expect(registryTouches).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("maps operation failures to safe tool errors with status", async () => {
    respond = () => jsonResponse({ error: "upstream secret" }, 429);
    const tts = await execute("xai_text_to_speech", { text: "hi" });
    expect(tts.content[0].text).toBe("Error: xAI text to speech failed with HTTP 429. xAI rate-limited the request; try again shortly.");
    expect(tts.details).toEqual({ error: true, code: "http_failure", status: 429 });

    await writeFile(join(workspace, "notes.txt"), "not audio");
    const stt = await execute("xai_transcribe_audio", { path: "notes.txt" });
    expect(stt.content[0].text).toMatch(/^Error: Audio file must be WAV, MP3/);
    expect(stt.details).toEqual({ error: true, code: "invalid_input" });
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["xai_text_to_speech", { text: "hi" }, "ttsValidate", "Error: Text-to-speech input is invalid.", "invalid_input"],
    ["xai_text_to_speech", { text: "hi" }, "ttsExecute", "Error: xAI text to speech failed safely.", "output_failure"],
    ["xai_transcribe_audio", { path: "a.wav" }, "sttValidate", "Error: Transcription input is invalid.", "invalid_input"],
    ["xai_transcribe_audio", { path: "a.wav" }, "sttExecute", "Error: xAI speech to text failed safely.", "invalid_response"],
  ] as const)("redacts unexpected %s failures (%s)", async (name, params, key, message, code) => {
    voiceErrors[key] = new Error("SECRET_STACK /tmp/private.wav oauth-token");
    const result = await execute(name, params);
    expect(result.content[0].text).toBe(message);
    expect(result.details).toEqual({ error: true, code });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_STACK|private\.wav|oauth-token/);
  });

  it("preserves typed voice errors from execution", async () => {
    voiceErrors.sttExecute = new XaiVoiceOperationError("xAI speech to text timed out.", "timeout");
    const result = await execute("xai_transcribe_audio", { path: "a.wav" });
    expect(result.content[0].text).toBe("Error: xAI speech to text timed out.");
    expect(result.details).toEqual({ error: true, code: "timeout" });
  });
});
