import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveXaiCredential } from "../auth";
import type { XaiCredential } from "../routing";
import { encodePcm16MonoWav, isSilentPcm16 } from "./audio";
import { XaiVoiceOperationError } from "./common";
import {
  XAI_DICTATION_MAX_DURATION_MS,
  XAI_DICTATION_SAMPLE_RATE,
  XAI_STT_DEFAULT_LANGUAGE,
  XAI_STT_LANGUAGES,
  type XaiSttLanguage,
} from "./constants";
import {
  startXaiMicrophoneRecording,
  XaiRecorderUnavailableError,
  type XaiMicrophoneRecording,
  type XaiRecordingEnd,
} from "./recorder";
import { isXaiSttLanguage, transcribeXaiAudio } from "./transcription";

export const XAI_VOICE_COMMAND = "xai-voice";
export const XAI_VOICE_SHORTCUTS = ["ctrl+space", "f8"] as const;
const XAI_VOICE_USAGE = `Usage: /${XAI_VOICE_COMMAND} [language|auto] — e.g. /${XAI_VOICE_COMMAND} es`;
const LEVEL_BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const RENDER_INTERVAL_MS = 250;
const LANGUAGE_NAMES: Readonly<Record<XaiSttLanguage, string>> = {
  ar: "Arabic", cs: "Czech", da: "Danish", nl: "Dutch", en: "English", fil: "Filipino",
  fr: "French", de: "German", hi: "Hindi", id: "Indonesian", it: "Italian", ja: "Japanese",
  ko: "Korean", mk: "Macedonian", ms: "Malay", fa: "Persian", pl: "Polish", pt: "Portuguese",
  ro: "Romanian", ru: "Russian", es: "Spanish", sv: "Swedish", th: "Thai", tr: "Turkish",
  vi: "Vietnamese",
};

/** Outcome of one dictation, reported once the recording UI closes. */
export type XaiDictationResult =
  | { kind: "text"; text: string; capped: boolean }
  | { kind: "empty" }
  | { kind: "silent" }
  | { kind: "discarded" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export interface XaiDictationDependencies {
  startRecording?: () => Promise<XaiMicrophoneRecording>;
  resolveCredential?: (ctx: any) => Promise<XaiCredential | null>;
  transcribe?: typeof transcribeXaiAudio;
  now?: () => number;
  locale?: () => string | undefined;
  platform?: NodeJS.Platform;
}

export interface XaiVoiceController {
  /** Discard any active recording or transcription and forget the session language. */
  reset(): void;
}

/** Resolve the client-only `auto` sentinel to a concrete catalog code from the process locale. */
export function resolveXaiDictationLanguage(
  preference: XaiSttLanguage | "auto",
  locale: string | undefined,
): XaiSttLanguage {
  if (preference !== "auto") return preference;
  const normalized = (locale ?? "").toLowerCase().replace("_", "-");
  const primary = normalized.split("-")[0];
  if (primary === "tl") return "fil";
  return isXaiSttLanguage(primary) ? primary : XAI_STT_DEFAULT_LANGUAGE;
}

/** Microphone-permission guidance for a clip that recorded only silence. */
export function xaiMicrophoneHelp(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    return "Allow microphone access for your terminal in System Settings → Privacy & Security → Microphone, then restart the terminal.";
  }
  if (platform === "win32") {
    return "Allow microphone access in Settings → Privacy & security → Microphone, and check the input device in Settings → System → Sound.";
  }
  return "Check the default input device and its volume in your sound settings (for example pavucontrol, or wpctl status on PipeWire).";
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * One dictation: a live recording that is either discarded locally or
 * stopped, checked for silence, and transcribed. Audio leaves the process
 * only through `finish()`, which runs only on an explicit user choice; when
 * capture ends on its own (the duration cap or the recorder exiting) the clip
 * waits in memory for that choice.
 */
export class XaiDictationSession {
  state: "recording" | "stopped" | "transcribing" | "done" = "recording";
  /** Why capture ended before the user stopped it, if it did. */
  endReason?: XaiRecordingEnd;
  private readonly startedAt: number;
  private readonly abort = new AbortController();
  private stopping?: Promise<Buffer>;
  private finishing?: Promise<XaiDictationResult>;
  private markDiscarded!: () => void;
  /** Resolves when the recording is discarded, from any caller. */
  readonly discarded = new Promise<void>((resolve) => {
    this.markDiscarded = resolve;
  });

  constructor(
    readonly recording: XaiMicrophoneRecording,
    readonly language: XaiSttLanguage,
    private readonly upload: (wav: Buffer, signal: AbortSignal) => Promise<string>,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
    void recording.ended.then((end) => {
      if (this.state === "recording") void this.stopCapture(end);
    });
  }

  /** Milliseconds since recording started. */
  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** Stop the recorder and keep the clip in memory without sending anything. */
  private stopCapture(end?: XaiRecordingEnd): Promise<Buffer> {
    if (!this.stopping) {
      if (end) this.endReason = end;
      this.stopping = this.recording.stop().then((pcm) => {
        if (this.state === "recording") this.state = "stopped";
        return pcm;
      });
    }
    return this.stopping;
  }

  /** Stop recording if needed and transcribe the clip; repeated calls share one result. */
  finish(): Promise<XaiDictationResult> {
    this.finishing ??= this.run();
    return this.finishing;
  }

  private async run(): Promise<XaiDictationResult> {
    if (this.state === "done") return { kind: "discarded" };
    const pcm = await this.stopCapture();
    if (this.abort.signal.aborted) {
      this.state = "done";
      return { kind: "discarded" };
    }
    if (pcm.length === 0 || isSilentPcm16(pcm)) {
      this.state = "done";
      return { kind: "silent" };
    }
    this.state = "transcribing";
    try {
      const text = await this.upload(encodePcm16MonoWav(pcm, XAI_DICTATION_SAMPLE_RATE), this.abort.signal);
      return text ? { kind: "text", text, capped: this.endReason === "cap" } : { kind: "empty" };
    } catch (error) {
      if (this.abort.signal.aborted) return { kind: "cancelled" };
      return {
        kind: "error",
        message: error instanceof XaiVoiceOperationError ? error.message : "Grok voice transcription failed.",
      };
    } finally {
      this.state = "done";
    }
  }

  /** Discard a recording that has not been uploaded, or abort an in-flight transcription. */
  cancel(): XaiDictationResult["kind"] {
    if (this.state === "recording" || this.state === "stopped") {
      this.abort.abort();
      this.recording.cancel();
      this.state = "done";
      this.markDiscarded();
      return "discarded";
    }
    if (this.state === "transcribing") {
      this.abort.abort();
      return "cancelled";
    }
    return "cancelled";
  }
}

function isConfirmKey(data: string, keybindings: any): boolean {
  if (data === "\r" || data === "\n" || data === "\x00" || data === "\x1b[19~") return true;
  try {
    return keybindings?.matches?.(data, "tui.select.confirm") === true;
  } catch {
    return false;
  }
}

function isCancelKey(data: string, keybindings: any): boolean {
  if (data === "\x1b" || data === "\x03") return true;
  try {
    return keybindings?.matches?.(data, "tui.select.cancel") === true;
  } catch {
    return false;
  }
}

async function runTuiDictation(ctx: any, session: XaiDictationSession): Promise<XaiDictationResult> {
  return ctx.ui.custom((tui: any, theme: any, keybindings: any, done: (result: XaiDictationResult) => void) => {
    let closed = false;
    const close = (result: XaiDictationResult) => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      done(result);
    };
    const finish = () => {
      void session.finish().then(close, () => close({ kind: "error", message: "Grok voice transcription failed." }));
      tui.requestRender?.();
    };
    const timer = setInterval(() => tui.requestRender?.(), RENDER_INTERVAL_MS);
    // A discard from Esc, dispose, or a session reset always closes the overlay.
    void session.discarded.then(() => close({ kind: "discarded" }));
    const paint = (role: string, text: string) => {
      try {
        return theme?.fg?.(role, text) ?? text;
      } catch {
        return text;
      }
    };
    return {
      render(width: number) {
        const limit = Math.max(1, width - 2);
        const bars = LEVEL_BARS[Math.min(LEVEL_BARS.length - 1, Math.floor(session.recording.level() * LEVEL_BARS.length))];
        const waiting = session.state === "recording" || session.state === "stopped";
        const status = session.state === "recording"
          ? `● Recording ${formatElapsed(session.elapsedMs())} / ${formatElapsed(XAI_DICTATION_MAX_DURATION_MS)} ${bars} · ${LANGUAGE_NAMES[session.language]}`
          : session.state === "stopped"
            ? session.endReason === "cap"
              ? `Recording limit reached (${formatElapsed(XAI_DICTATION_MAX_DURATION_MS)})`
              : "The microphone recorder stopped"
            : "Transcribing with xAI…";
        const hint = waiting
          ? "Enter or Ctrl+Space: transcribe · Esc: discard (nothing is sent)"
          : "Esc: cancel";
        return [
          paint("accent", `Grok voice — ${status}`.slice(0, limit)),
          paint("muted", `  ${hint}`.slice(0, limit)),
        ];
      },
      invalidate() {},
      handleInput(data: string) {
        if ((session.state === "recording" || session.state === "stopped") && isConfirmKey(data, keybindings)) {
          finish();
          return;
        }
        if (isCancelKey(data, keybindings)) {
          session.cancel();
          tui.requestRender?.();
        }
      },
      dispose() {
        clearInterval(timer);
        if (session.state !== "done") session.cancel();
      },
    };
  });
}

async function runSelectDictation(ctx: any, session: XaiDictationSession): Promise<XaiDictationResult> {
  const stop = "Stop and transcribe";
  const discard = "Discard recording";
  const choice = await ctx.ui.select(
    `🎙 Grok voice is recording (${LANGUAGE_NAMES[session.language]}, up to ${formatElapsed(XAI_DICTATION_MAX_DURATION_MS)})`,
    [stop, discard],
  );
  if (choice !== stop) {
    session.cancel();
    return { kind: "discarded" };
  }
  return session.finish();
}

function insertTranscript(ctx: any, text: string): void {
  let current = "";
  try {
    const value = ctx.ui.getEditorText?.();
    if (typeof value === "string") current = value;
  } catch {
    current = "";
  }
  const fragment = current && !/\s$/.test(current) ? ` ${text}` : text;
  if (ctx.mode === "tui" && typeof ctx.ui.pasteToEditor === "function") {
    ctx.ui.pasteToEditor(fragment);
    return;
  }
  ctx.ui.setEditorText(`${current}${fragment}`);
}

function reportResult(ctx: any, result: XaiDictationResult, platform: NodeJS.Platform): void {
  switch (result.kind) {
    case "text":
      insertTranscript(ctx, result.text);
      if (result.capped) {
        ctx.ui.notify(
          `Recording stopped at the ${XAI_DICTATION_MAX_DURATION_MS / 60_000}-minute limit; the captured part was transcribed.`,
          "info",
        );
      }
      return;
    case "empty":
      ctx.ui.notify("No speech was detected. Nothing was inserted.", "warning");
      return;
    case "silent":
      ctx.ui.notify(
        `The microphone recorded only silence, so nothing was sent to xAI. ${xaiMicrophoneHelp(platform)}`,
        "warning",
      );
      return;
    case "discarded":
      ctx.ui.notify("Discarded the recording; nothing was sent to xAI.", "info");
      return;
    case "cancelled":
      ctx.ui.notify("Cancelled Grok voice transcription.", "info");
      return;
    case "error":
      ctx.ui.notify(result.message, "error");
      return;
  }
}

/**
 * Register Grok voice dictation: `/xai-voice [language]` plus Grok Build's
 * Ctrl+Space and F8 shortcuts record the microphone, transcribe through the
 * pinned xAI speech-to-text route, and insert the text into Pi's editor.
 * Nothing is submitted automatically.
 */
export function registerXaiVoice(
  pi: ExtensionAPI,
  dependencies: XaiDictationDependencies = {},
): XaiVoiceController {
  const startRecording = dependencies.startRecording ?? (() => startXaiMicrophoneRecording());
  const resolveCredential = dependencies.resolveCredential ?? resolveXaiCredential;
  const transcribe = dependencies.transcribe ?? transcribeXaiAudio;
  const now = dependencies.now ?? Date.now;
  const locale = dependencies.locale ?? (() => Intl.DateTimeFormat().resolvedOptions().locale);
  const platform = dependencies.platform ?? process.platform;
  let preference: XaiSttLanguage | "auto" = XAI_STT_DEFAULT_LANGUAGE;
  let active: XaiDictationSession | undefined;

  const dictate = async (ctx: any) => {
    if (!ctx?.hasUI || typeof ctx?.ui?.notify !== "function") {
      ctx?.ui?.notify?.(`/${XAI_VOICE_COMMAND} needs Pi's interactive TUI or an RPC client.`, "error");
      return;
    }
    if (active) {
      ctx.ui.notify("Grok voice is already recording.", "warning");
      return;
    }
    const language = resolveXaiDictationLanguage(preference, locale());
    // Fail before opening the microphone when no xAI credential can upload the clip.
    if (!(await resolveCredential(ctx))) {
      ctx.ui.notify(
        "Grok voice needs xAI credentials. Run /login and choose xAI (OAuth) or xAI, then try again.",
        "error",
      );
      return;
    }
    let recording: XaiMicrophoneRecording;
    try {
      recording = await startRecording();
    } catch (error) {
      ctx.ui.notify(
        error instanceof XaiRecorderUnavailableError ? error.message : "Could not start the microphone recorder.",
        "error",
      );
      return;
    }
    const session = new XaiDictationSession(recording, language, async (wav, signal) => {
      // Resolve again at upload time so a long recording uses a fresh token.
      const credential = await resolveCredential(ctx);
      if (!credential) {
        throw new XaiVoiceOperationError("xAI credentials are no longer available; sign in again.", "http_failure");
      }
      const transcription = await transcribe({
        credential,
        audio: { bytes: wav, mimeType: "audio/wav" },
        language,
        signal,
      });
      return transcription.text;
    }, now);
    active = session;
    let result: XaiDictationResult;
    try {
      result = ctx.mode === "tui" && typeof ctx.ui.custom === "function"
        ? (await runTuiDictation(ctx, session)) ?? { kind: "discarded" }
        : await runSelectDictation(ctx, session);
    } catch {
      session.cancel();
      result = { kind: "error", message: "Grok voice stopped unexpectedly; nothing was inserted." };
    } finally {
      if (active === session) active = undefined;
    }
    if (session.state !== "done") session.cancel();
    reportResult(ctx, result, platform);
  };

  pi.registerCommand(XAI_VOICE_COMMAND, {
    description: "Dictate into the prompt with Grok voice (speech-to-text); optional language code",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      const items = (["auto", ...XAI_STT_LANGUAGES] as const)
        .filter((code) => code.startsWith(normalized))
        .map((code) => ({
          value: code,
          label: code,
          description: code === "auto" ? "Use the system language" : LANGUAGE_NAMES[code],
        }));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: any) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      if (words.length > 1) {
        ctx.ui.notify(XAI_VOICE_USAGE, "error");
        return;
      }
      const requested = words[0]?.toLowerCase();
      if (requested !== undefined) {
        if (requested !== "auto" && !isXaiSttLanguage(requested)) {
          ctx.ui.notify(`${XAI_VOICE_USAGE}. Languages: auto, ${XAI_STT_LANGUAGES.join(", ")}.`, "error");
          return;
        }
        preference = requested;
      }
      await dictate(ctx);
    },
  } as any);

  if (typeof (pi as any).registerShortcut === "function") {
    for (const shortcut of XAI_VOICE_SHORTCUTS) {
      (pi as any).registerShortcut(shortcut, {
        description: "Dictate into the prompt with Grok voice",
        handler: (ctx: any) => dictate(ctx),
      });
    }
  }

  return {
    reset() {
      active?.cancel();
      active = undefined;
      preference = XAI_STT_DEFAULT_LANGUAGE;
    },
  };
}
