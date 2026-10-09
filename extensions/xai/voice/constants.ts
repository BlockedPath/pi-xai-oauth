/**
 * Grok voice request budgets and catalogs.
 *
 * The text-to-speech and batch speech-to-text request shapes follow xAI's
 * public Voice API as implemented by the `@ai-sdk/xai` reference client; the
 * dictation capture budgets and the STT language catalog follow Grok Build's
 * `xai-grok-voice` crate.
 */

/** Built-in xAI voices; the API also accepts custom voice IDs, which this package does not expose. */
export const XAI_TTS_VOICES = ["eve", "ara", "rex", "sal", "leo"] as const;
export type XaiTtsVoice = (typeof XAI_TTS_VOICES)[number];
export const XAI_TTS_DEFAULT_VOICE: XaiTtsVoice = "eve";

/** Container formats saved as playable files; headerless PCM/μ-law/A-law are not offered. */
export const XAI_TTS_FORMATS = ["mp3", "wav"] as const;
export type XaiTtsFormat = (typeof XAI_TTS_FORMATS)[number];
export const XAI_TTS_DEFAULT_FORMAT: XaiTtsFormat = "mp3";
export const XAI_TTS_DEFAULT_LANGUAGE = "auto";
export const XAI_TTS_MIN_SPEED = 0.7;
export const XAI_TTS_MAX_SPEED = 1.5;

/** Package-owned text-to-speech budgets. */
export const XAI_TTS_MAX_TEXT_CHARS = 5_000;
export const XAI_TTS_MAX_TEXT_BYTES = 20 * 1024;
export const XAI_TTS_REQUEST_TIMEOUT_MS = 120_000;
export const XAI_TTS_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Official Grok speech-to-text languages. The API transcribes these regardless
 * of the parameter; setting one enables written-form numbers, currencies, and
 * units. The API does not accept `auto`.
 */
export const XAI_STT_LANGUAGES = [
  "ar", "cs", "da", "nl", "en", "fil", "fr", "de", "hi", "id", "it", "ja", "ko",
  "mk", "ms", "fa", "pl", "pt", "ro", "ru", "es", "sv", "th", "tr", "vi",
] as const;
export type XaiSttLanguage = (typeof XAI_STT_LANGUAGES)[number];
export const XAI_STT_DEFAULT_LANGUAGE: XaiSttLanguage = "en";

/** Package-owned speech-to-text budgets; 20 MiB is Grok Build's transcription upload cap. */
export const XAI_STT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const XAI_STT_REQUEST_TIMEOUT_MS = 240_000;
export const XAI_STT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const XAI_STT_MAX_TRANSCRIPT_CHARS = 200_000;

/** Dictation capture: PCM16 mono at 16 kHz, bounded by duration and the upload cap. */
export const XAI_DICTATION_SAMPLE_RATE = 16_000;
export const XAI_DICTATION_MAX_DURATION_MS = 5 * 60 * 1000;
export const XAI_WAV_HEADER_BYTES = 44;
export const XAI_DICTATION_MAX_PCM_BYTES = Math.min(
  XAI_DICTATION_SAMPLE_RATE * 2 * (XAI_DICTATION_MAX_DURATION_MS / 1000),
  XAI_STT_MAX_UPLOAD_BYTES - XAI_WAV_HEADER_BYTES,
);
/** Peak |sample| at or below which a PCM16 clip counts as silence; a denied mic grant yields zeros. */
export const XAI_DICTATION_SILENCE_PEAK = 64;

/** Recorder subprocess lifecycle bounds. */
export const XAI_RECORDER_START_GRACE_MS = 300;
export const XAI_RECORDER_STOP_TIMEOUT_MS = 2_000;
export const XAI_RECORDER_MAX_DIAGNOSTIC_CHARS = 160;

/** Live dictation over the streaming STT socket, following Grok Build's voice defaults. */
export const XAI_LIVE_STT_ENDPOINTING_MS = 400;
export const XAI_LIVE_STT_CONNECT_TIMEOUT_MS = 15_000;
export const XAI_LIVE_STT_FINISH_TIMEOUT_MS = 15_000;
export const XAI_LIVE_STT_MAX_MESSAGE_BYTES = 64 * 1024;
export const XAI_LIVE_STT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** A clip with no audible input by this point is stopped instead of recording a dead microphone. */
export const XAI_DICTATION_NO_SPEECH_MS = 10_000;

/**
 * Realtime voice conversation (Grok Voice Agent) defaults, following the
 * OAuth-authenticated OpenClaw xAI realtime bridge: PCM16 mono at 24 kHz in
 * both directions, server VAD, and `grok-transcribe` input captions.
 */
export const XAI_TALK_MODEL = "grok-voice-latest";
export const XAI_TALK_SAMPLE_RATE = 24_000;
export const XAI_TALK_INPUT_TRANSCRIPTION_MODEL = "grok-transcribe";
export const XAI_TALK_VAD_THRESHOLD = 0.85;
export const XAI_TALK_VAD_PREFIX_PADDING_MS = 333;
export const XAI_TALK_VAD_SILENCE_DURATION_MS = 500;
export const XAI_TALK_CONNECT_TIMEOUT_MS = 15_000;
export const XAI_TALK_MAX_DURATION_MS = 30 * 60 * 1000;
export const XAI_TALK_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const XAI_TALK_MAX_AUDIO_DELTA_BYTES = 1024 * 1024;
export const XAI_TALK_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Half-duplex keeps the microphone muted until this long after Grok's audio should have finished. */
export const XAI_TALK_ECHO_TAIL_MS = 600;
export const XAI_TALK_MAX_CONTEXT_CHARS = 8_000;
export const XAI_TALK_MAX_LINE_CHARS = 4_000;
export const XAI_TALK_MAX_LINES = 200;
export const XAI_TALK_MAX_TRANSCRIPT_CHARS = 20_000;
