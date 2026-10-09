import { hasJsonContentType, readBoundedResponseBytes } from "../bounded-body";
import { audioOutputRoot, savePrivateStreamedOutput } from "../media/output-storage";
import { resolveXaiRoute, type XaiCredential } from "../routing";
import { xaiDirectSpeechHeaders } from "../wire";
import { sniffAudioMimeType } from "./audio";
import { fetchVoiceRoute, invalidVoiceInput, XaiVoiceOperationError } from "./common";
import {
  XAI_TTS_DEFAULT_FORMAT,
  XAI_TTS_DEFAULT_LANGUAGE,
  XAI_TTS_DEFAULT_VOICE,
  XAI_TTS_FORMATS,
  XAI_TTS_MAX_OUTPUT_BYTES,
  XAI_TTS_MAX_SPEED,
  XAI_TTS_MAX_TEXT_BYTES,
  XAI_TTS_MAX_TEXT_CHARS,
  XAI_TTS_MIN_SPEED,
  XAI_TTS_REQUEST_TIMEOUT_MS,
  XAI_TTS_VOICES,
  type XaiTtsFormat,
  type XaiTtsVoice,
} from "./constants";

const TTS_LABEL = "text to speech";
const TTS_INPUT_FIELDS = new Set(["text", "voice", "language", "format", "speed"]);
const TTS_LANGUAGE_PATTERN = /^(?:auto|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2})$/;
const TTS_MIME_TYPES: Readonly<Record<XaiTtsFormat, "audio/mpeg" | "audio/wav">> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export interface XaiTextToSpeechInput {
  text: string;
  voice: XaiTtsVoice;
  language: string;
  format: XaiTtsFormat;
  speed?: number;
}

export interface SavedSpeechOutput {
  path: string;
  mimeType: "audio/mpeg" | "audio/wav";
  byteLength: number;
  voice: XaiTtsVoice;
  language: string;
  format: XaiTtsFormat;
}

interface SessionLocation {
  getSessionDir(): string;
  getSessionId(): string;
}

export interface TextToSpeechDependencies {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Validate cheap text-to-speech input before credential, network, or filesystem I/O. */
export function validateXaiTextToSpeechInput(value: unknown): XaiTextToSpeechInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidVoiceInput("Text-to-speech input must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !TTS_INPUT_FIELDS.has(key))) {
    return invalidVoiceInput("Text-to-speech input contains unsupported fields.");
  }
  if (typeof record.text !== "string" || !record.text.trim()) {
    return invalidVoiceInput("Text-to-speech text must be non-empty.");
  }
  if (
    record.text.length > XAI_TTS_MAX_TEXT_CHARS ||
    Buffer.byteLength(record.text, "utf8") > XAI_TTS_MAX_TEXT_BYTES
  ) {
    return invalidVoiceInput(`Text-to-speech text exceeds the ${XAI_TTS_MAX_TEXT_CHARS}-character limit.`);
  }
  const voice = record.voice ?? XAI_TTS_DEFAULT_VOICE;
  if (!XAI_TTS_VOICES.includes(voice as XaiTtsVoice)) {
    return invalidVoiceInput(`Text-to-speech voice must be one of ${XAI_TTS_VOICES.join(", ")}.`);
  }
  const language = record.language ?? XAI_TTS_DEFAULT_LANGUAGE;
  if (typeof language !== "string" || language.length > 24 || !TTS_LANGUAGE_PATTERN.test(language)) {
    return invalidVoiceInput("Text-to-speech language must be auto or a BCP-47 code such as en or pt-BR.");
  }
  const format = record.format ?? XAI_TTS_DEFAULT_FORMAT;
  if (!XAI_TTS_FORMATS.includes(format as XaiTtsFormat)) {
    return invalidVoiceInput("Text-to-speech format must be mp3 or wav.");
  }
  if (
    record.speed !== undefined &&
    (typeof record.speed !== "number" ||
      !Number.isFinite(record.speed) ||
      record.speed < XAI_TTS_MIN_SPEED ||
      record.speed > XAI_TTS_MAX_SPEED)
  ) {
    return invalidVoiceInput(`Text-to-speech speed must be between ${XAI_TTS_MIN_SPEED} and ${XAI_TTS_MAX_SPEED}.`);
  }
  return {
    text: record.text,
    voice: voice as XaiTtsVoice,
    language,
    format: format as XaiTtsFormat,
    ...(typeof record.speed === "number" ? { speed: record.speed } : {}),
  };
}

/** Build the exact pinned text-to-speech request body. */
export function buildXaiTextToSpeechPayload(input: XaiTextToSpeechInput): Record<string, unknown> {
  return {
    text: input.text,
    voice_id: input.voice,
    language: input.language,
    output_format: { codec: input.format },
    ...(input.speed !== undefined ? { speed: input.speed } : {}),
  };
}

/** Synthesize speech through the pinned xAI route and save one private, byte-verified audio file. */
export async function executeXaiTextToSpeech(options: {
  credential: XaiCredential;
  input: XaiTextToSpeechInput;
  sessionManager: SessionLocation;
  signal?: AbortSignal;
}, dependencies: TextToSpeechDependencies = {}): Promise<SavedSpeechOutput> {
  const input = validateXaiTextToSpeechInput(options.input);
  let sessionRoot: string;
  let outputRoot: string;
  try {
    sessionRoot = options.sessionManager.getSessionDir();
    outputRoot = audioOutputRoot(options.sessionManager);
  } catch {
    throw new XaiVoiceOperationError("A safe Pi session output directory is unavailable.", "output_failure");
  }
  const expectedMimeType = TTS_MIME_TYPES[input.format];
  const maxOutputBytes = dependencies.maxOutputBytes ?? XAI_TTS_MAX_OUTPUT_BYTES;
  const route = resolveXaiRoute(options.credential.kind, "text-to-speech");
  const audio = await fetchVoiceRoute({
    url: route.url,
    init: {
      method: "POST",
      headers: xaiDirectSpeechHeaders(options.credential.token),
      body: JSON.stringify(buildXaiTextToSpeechPayload(input)),
    },
    label: TTS_LABEL,
    timeoutMs: dependencies.timeoutMs ?? XAI_TTS_REQUEST_TIMEOUT_MS,
    signal: options.signal,
    fetch: dependencies.fetch ?? fetch,
    consume: async (response, signal) => {
      if (hasJsonContentType(response)) {
        throw new XaiVoiceOperationError("xAI text to speech returned an unexpected response.", "invalid_response");
      }
      const bytes = await readBoundedResponseBytes(response, {
        maxBytes: maxOutputBytes,
        signal,
        overflowError: () =>
          new XaiVoiceOperationError("xAI text to speech output exceeded the byte limit.", "invalid_response"),
      });
      if (sniffAudioMimeType(bytes) !== expectedMimeType) {
        throw new XaiVoiceOperationError(
          `xAI text to speech did not return valid ${input.format.toUpperCase()} audio.`,
          "invalid_response",
        );
      }
      return bytes;
    },
  });
  try {
    const saved = await savePrivateStreamedOutput({
      outputRoot,
      sessionRoot,
      extension: input.format,
      stemPrefix: "xai-speech",
      signal: options.signal,
      invalidPathMessage: "Speech output path is invalid.",
      write: (writer) => writer.write(audio),
    });
    return {
      path: saved.path,
      mimeType: expectedMimeType,
      byteLength: audio.length,
      voice: input.voice,
      language: input.language,
      format: input.format,
    };
  } catch {
    if (options.signal?.aborted) {
      throw new XaiVoiceOperationError("Saving the generated speech was cancelled.", "cancelled");
    }
    throw new XaiVoiceOperationError("Generated speech could not be saved safely.", "output_failure");
  }
}
