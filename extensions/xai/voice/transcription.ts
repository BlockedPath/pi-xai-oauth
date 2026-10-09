import { hasJsonContentType, readBoundedResponseText } from "../bounded-body";
import { readBoundedWorkspaceFile } from "../media/paths";
import { resolveXaiRoute, type XaiCredential } from "../routing";
import { xaiDirectMultipartHeaders } from "../wire";
import { sniffAudioMimeType, XAI_AUDIO_FILE_EXTENSIONS, type XaiAudioMimeType } from "./audio";
import { fetchVoiceRoute, invalidVoiceInput, XaiVoiceOperationError } from "./common";
import {
  XAI_STT_LANGUAGES,
  XAI_STT_MAX_RESPONSE_BYTES,
  XAI_STT_MAX_TRANSCRIPT_CHARS,
  XAI_STT_MAX_UPLOAD_BYTES,
  XAI_STT_REQUEST_TIMEOUT_MS,
  type XaiSttLanguage,
} from "./constants";

const STT_LABEL = "speech to text";
const STT_INPUT_FIELDS = new Set(["path", "language"]);
// Strip C0/C1 controls except tab and newline so a transcript can never carry
// terminal escape sequences into the editor or tool output.
const TRANSCRIPT_CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export interface XaiTranscriptionAudio {
  bytes: Uint8Array;
  mimeType: XaiAudioMimeType;
}

export interface XaiTranscription {
  text: string;
  language?: string;
  duration?: number;
}

export interface TranscriptionDependencies {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface XaiTranscribeAudioInput {
  path: string;
  language?: XaiSttLanguage;
}

export interface XaiAudioFileTranscription extends XaiTranscription {
  path: string;
  mimeType: XaiAudioMimeType;
  byteLength: number;
}

/** Whether a value is one of the official Grok speech-to-text language codes. */
export function isXaiSttLanguage(value: unknown): value is XaiSttLanguage {
  return typeof value === "string" && XAI_STT_LANGUAGES.includes(value as XaiSttLanguage);
}

/** Validate cheap file-transcription input before credential, filesystem, or network I/O. */
export function validateXaiTranscribeAudioInput(value: unknown): XaiTranscribeAudioInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidVoiceInput("Transcription input must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !STT_INPUT_FIELDS.has(key))) {
    return invalidVoiceInput("Transcription input contains unsupported fields.");
  }
  if (typeof record.path !== "string" || !record.path.trim() || record.path.includes("\0")) {
    return invalidVoiceInput("Transcription requires one audio file path inside the workspace.");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(record.path) && !/^[A-Za-z]:[\\/]/.test(record.path)) {
    return invalidVoiceInput("Transcription paths do not accept URL schemes.");
  }
  if (record.language !== undefined && !isXaiSttLanguage(record.language)) {
    return invalidVoiceInput(`Transcription language must be one of ${XAI_STT_LANGUAGES.join(", ")}.`);
  }
  return {
    path: record.path,
    ...(record.language !== undefined ? { language: record.language as XaiSttLanguage } : {}),
  };
}

function parseTranscription(text: string): XaiTranscription {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new XaiVoiceOperationError("xAI speech to text returned invalid JSON.", "invalid_response");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new XaiVoiceOperationError("xAI speech to text returned an invalid response.", "invalid_response");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.text !== "string" || record.text.length > XAI_STT_MAX_TRANSCRIPT_CHARS) {
    throw new XaiVoiceOperationError("xAI speech to text returned an invalid transcript.", "invalid_response");
  }
  const language = typeof record.language === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(record.language)
    ? record.language
    : undefined;
  const duration = typeof record.duration === "number"
    && Number.isFinite(record.duration)
    && record.duration >= 0
    && record.duration <= 24 * 60 * 60
    ? record.duration
    : undefined;
  return {
    text: record.text.replace(TRANSCRIPT_CONTROL_PATTERN, "").trim(),
    ...(language ? { language } : {}),
    ...(duration !== undefined ? { duration } : {}),
  };
}

/**
 * Transcribe one bounded, byte-verified audio clip through the pinned xAI
 * speech-to-text route. Setting a language also requests written-form
 * numbers, currencies, and units.
 */
export async function transcribeXaiAudio(options: {
  credential: XaiCredential;
  audio: XaiTranscriptionAudio;
  language?: XaiSttLanguage;
  signal?: AbortSignal;
}, dependencies: TranscriptionDependencies = {}): Promise<XaiTranscription> {
  const { audio } = options;
  if (audio.bytes.length === 0 || audio.bytes.length > XAI_STT_MAX_UPLOAD_BYTES) {
    throw new XaiVoiceOperationError("Audio for transcription must be between 1 byte and 20 MiB.", "invalid_input");
  }
  if (sniffAudioMimeType(audio.bytes) !== audio.mimeType) {
    throw new XaiVoiceOperationError("Audio for transcription is not a recognized audio file.", "invalid_input");
  }
  if (options.language !== undefined && !isXaiSttLanguage(options.language)) {
    throw new XaiVoiceOperationError("Transcription language is not supported.", "invalid_input");
  }
  const form = new FormData();
  if (options.language) {
    form.append("language", options.language);
    form.append("format", "true");
  }
  form.append(
    "file",
    // Copy into an ArrayBuffer-backed view; Blob parts cannot be shared memory.
    new Blob([new Uint8Array(audio.bytes)], { type: audio.mimeType }),
    `audio.${XAI_AUDIO_FILE_EXTENSIONS[audio.mimeType]}`,
  );
  const route = resolveXaiRoute(options.credential.kind, "speech-to-text");
  const maxResponseBytes = dependencies.maxResponseBytes ?? XAI_STT_MAX_RESPONSE_BYTES;
  return fetchVoiceRoute({
    url: route.url,
    init: {
      method: "POST",
      headers: xaiDirectMultipartHeaders(options.credential.token),
      body: form,
    },
    label: STT_LABEL,
    timeoutMs: dependencies.timeoutMs ?? XAI_STT_REQUEST_TIMEOUT_MS,
    signal: options.signal,
    fetch: dependencies.fetch ?? fetch,
    consume: async (response, signal) => {
      if (!hasJsonContentType(response)) {
        throw new XaiVoiceOperationError("xAI speech to text returned an invalid response type.", "invalid_response");
      }
      const text = await readBoundedResponseText(response, {
        maxBytes: maxResponseBytes,
        signal,
        overflowError: () =>
          new XaiVoiceOperationError("xAI speech to text response exceeded the byte limit.", "invalid_response"),
      });
      return parseTranscription(text);
    },
  });
}

/** Read one bounded workspace audio file, verify its container, and transcribe it. */
export async function executeXaiTranscribeAudioFile(options: {
  credential: XaiCredential;
  input: XaiTranscribeAudioInput;
  workspaceRoot: string;
  signal?: AbortSignal;
}, dependencies: TranscriptionDependencies = {}): Promise<XaiAudioFileTranscription> {
  const input = validateXaiTranscribeAudioInput(options.input);
  let bytes: Buffer;
  try {
    bytes = await readBoundedWorkspaceFile(input.path, options.workspaceRoot, {
      maxBytes: XAI_STT_MAX_UPLOAD_BYTES,
      label: "Audio file",
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw new XaiVoiceOperationError("Reading the audio file was cancelled.", "cancelled");
    }
    throw new XaiVoiceOperationError(
      error instanceof Error ? error.message : "Audio file is not a readable workspace file.",
      "invalid_input",
    );
  }
  const mimeType = sniffAudioMimeType(bytes);
  if (!mimeType) {
    throw new XaiVoiceOperationError(
      "Audio file must be WAV, MP3, FLAC, OGG/Opus, M4A/MP4, WebM, or AAC.",
      "invalid_input",
    );
  }
  const transcription = await transcribeXaiAudio({
    credential: options.credential,
    audio: { bytes, mimeType },
    language: input.language,
    signal: options.signal,
  }, dependencies);
  return { ...transcription, path: input.path, mimeType, byteLength: bytes.length };
}
