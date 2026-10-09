import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveXaiCredential } from "../auth";
import type { XaiCredential } from "../routing";
import { encodePcm16MonoWav, isSilentPcm16 } from "./audio";
import { XaiVoiceOperationError } from "./common";
import {
  XAI_DICTATION_MAX_DURATION_MS,
  XAI_DICTATION_NO_SPEECH_MS,
  XAI_DICTATION_SAMPLE_RATE,
  XAI_STT_DEFAULT_LANGUAGE,
  XAI_STT_LANGUAGES,
  type XaiSttLanguage,
} from "./constants";
import { connectXaiLiveTranscription, type XaiLiveTranscription } from "./live";
import {
  startXaiMicrophoneRecording,
  XaiRecorderUnavailableError,
  type XaiMicrophoneRecording,
  type XaiRecordingEnd,
} from "./recorder";
import { isXaiSttLanguage, transcribeXaiAudio } from "./transcription";

export const XAI_VOICE_COMMAND = "xai-voice";
export const XAI_VOICE_SHORTCUTS = ["ctrl+space", "f8"] as const;
export const XAI_DICTATION_MODES = ["live", "clip"] as const;
export type XaiDictationMode = (typeof XAI_DICTATION_MODES)[number];
const XAI_VOICE_USAGE = `Usage: /${XAI_VOICE_COMMAND} [language|auto] [live|clip] — e.g. /${XAI_VOICE_COMMAND} es`;
const LEVEL_BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const RENDER_INTERVAL_MS = 250;
/** Ignore the start chord's key auto-repeat so holding it cannot stop the dictation it started. */
const TOGGLE_DEBOUNCE_MS = 500;
const LANGUAGE_NAMES: Readonly<Record<XaiSttLanguage, string>> = {
  ar: "Arabic", cs: "Czech", da: "Danish", nl: "Dutch", en: "English", fil: "Filipino",
  fr: "French", de: "German", hi: "Hindi", id: "Indonesian", it: "Italian", ja: "Japanese",
  ko: "Korean", mk: "Macedonian", ms: "Malay", fa: "Persian", pl: "Polish", pt: "Portuguese",
  ro: "Romanian", ru: "Russian", es: "Spanish", sv: "Swedish", th: "Thai", tr: "Turkish",
  vi: "Vietnamese",
};

/** Outcome of one dictation, reported once the recording UI closes. */
export type XaiDictationResult =
  | { kind: "text"; text: string; capped: boolean; via: "live" | "clip" }
  | { kind: "empty" }
  | { kind: "silent"; streamed: boolean }
  | { kind: "discarded"; streamed: boolean }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export interface XaiDictationDependencies {
  startRecording?: () => Promise<XaiMicrophoneRecording>;
  resolveCredential?: (ctx: any) => Promise<XaiCredential | null>;
  transcribe?: typeof transcribeXaiAudio;
  connectLive?: (options: {
    credential: XaiCredential;
    language: XaiSttLanguage;
    signal: AbortSignal;
  }) => Promise<XaiLiveTranscription>;
  now?: () => number;
  locale?: () => string | undefined;
  platform?: NodeJS.Platform;
  noSpeechMs?: number;
}

export interface XaiVoiceController {
  /** Discard any active recording or transcription and restore the session defaults. */
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

export interface XaiDictationSessionOptions {
  recording: XaiMicrophoneRecording;
  language: XaiSttLanguage;
  mode: XaiDictationMode;
  /** Upload a finished WAV clip and return its transcript. */
  upload: (wav: Buffer, signal: AbortSignal) => Promise<string>;
  /** Open the live stream; omitted or failing streams fall back to `upload`. */
  connectLive?: (signal: AbortSignal) => Promise<XaiLiveTranscription>;
  now?: () => number;
  noSpeechMs?: number;
}

/**
 * One dictation. In live mode the microphone streams to xAI as you speak and
 * the transcript assembles in place; in clip mode audio stays in memory until
 * `finish()`. Either way the whole clip is kept locally (bounded), so a failed
 * live stream falls back to uploading it. Capture that ends on its own waits
 * for an explicit `finish()` or `cancel()`, and `outcome` settles exactly once.
 */
export class XaiDictationSession {
  readonly recording: XaiMicrophoneRecording;
  readonly language: XaiSttLanguage;
  readonly mode: XaiDictationMode;
  /** Why capture ended before the user stopped it, if it did. */
  endReason?: XaiRecordingEnd;
  liveState: "off" | "connecting" | "live" | "failed" = "off";
  settled = false;
  uploading = false;
  readonly outcome: Promise<XaiDictationResult>;
  private readonly upload: XaiDictationSessionOptions["upload"];
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly abort = new AbortController();
  private readonly noSpeechTimer: ReturnType<typeof setTimeout>;
  private resolveOutcome!: (result: XaiDictationResult) => void;
  private stopping?: Promise<Buffer>;
  private finishing = false;
  private live?: XaiLiveTranscription;
  private livePending: Promise<XaiLiveTranscription | undefined> = Promise.resolve(undefined);
  private unsubscribe?: () => void;
  private streamedBytes = 0;

  constructor(options: XaiDictationSessionOptions) {
    this.recording = options.recording;
    this.language = options.language;
    this.mode = options.mode;
    this.upload = options.upload;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.outcome = new Promise((resolve) => {
      this.resolveOutcome = resolve;
    });
    void this.recording.ended.then((end) => {
      if (!this.settled && !this.finishing) void this.stopCapture(end);
    });
    if (this.mode === "live" && options.connectLive) this.startLive(options.connectLive);
    this.noSpeechTimer = setTimeout(() => this.checkNoSpeech(), options.noSpeechMs ?? XAI_DICTATION_NO_SPEECH_MS);
    this.noSpeechTimer.unref?.();
  }

  /** Milliseconds since recording started. */
  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** Whether capture is still running and waiting for the user. */
  get recordingActive(): boolean {
    return !this.settled && !this.finishing && this.stopping === undefined;
  }

  /** Whether the user asked to transcribe and the result is pending. */
  get transcribing(): boolean {
    return !this.settled && this.finishing;
  }

  /** Live words recognized so far. */
  preview(): string {
    return this.live?.preview() ?? "";
  }

  /** Whether any audio has been streamed to xAI. */
  get streamed(): boolean {
    return this.streamedBytes > 0;
  }

  private startLive(connect: NonNullable<XaiDictationSessionOptions["connectLive"]>) {
    this.liveState = "connecting";
    this.livePending = connect(this.abort.signal).then((live) => {
      if (this.settled || this.abort.signal.aborted) {
        live.close();
        return undefined;
      }
      this.live = live;
      this.liveState = "live";
      // Snapshot then subscribe in one turn: recorder data events are
      // asynchronous, so no chunk falls between the backlog and the stream.
      this.forward(this.recording.snapshot());
      this.unsubscribe = this.recording.subscribe((chunk) => this.forward(chunk));
      return live;
    }, () => {
      this.liveState = "failed";
      return undefined;
    });
  }

  private forward(chunk: Buffer) {
    if (!this.live || chunk.length === 0) return;
    if (!this.live.failure()) this.live.send(chunk);
    // Count only audio the stream accepted, so a discard reports honestly.
    if (this.live.failure()) this.liveState = "failed";
    else this.streamedBytes += chunk.length;
  }

  private checkNoSpeech() {
    if (!this.recordingActive || this.preview()) return;
    if (!isSilentPcm16(this.recording.snapshot())) return;
    this.abort.abort();
    this.recording.cancel();
    this.settle({ kind: "silent", streamed: this.streamed });
  }

  private stopCapture(end?: XaiRecordingEnd): Promise<Buffer> {
    if (!this.stopping) {
      if (end) this.endReason = end;
      this.stopping = this.recording.stop();
    }
    return this.stopping;
  }

  private settle(result: XaiDictationResult) {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.noSpeechTimer);
    this.unsubscribe?.();
    this.live?.close();
    this.resolveOutcome(result);
  }

  /** Stop recording if needed and transcribe; repeated calls share the one outcome. */
  finish(): Promise<XaiDictationResult> {
    if (!this.settled && !this.finishing) {
      this.finishing = true;
      void this.run().then(
        (result) => this.settle(result),
        () => this.settle({ kind: "error", message: "Grok voice transcription failed." }),
      );
    }
    return this.outcome;
  }

  /** End the session with a safe error, discarding the recording. */
  fail(message: string) {
    if (this.settled) return;
    this.abort.abort();
    this.recording.cancel();
    this.settle({ kind: "error", message });
  }

  private async run(): Promise<XaiDictationResult> {
    const discarded = (): XaiDictationResult => ({ kind: "discarded", streamed: this.streamed });
    const pcm = await this.stopCapture();
    if (this.abort.signal.aborted) return discarded();
    const live = await this.livePending;
    if (this.abort.signal.aborted) return discarded();
    const silent = pcm.length === 0 || isSilentPcm16(pcm);
    const capped = this.endReason === "cap";
    this.uploading = true;
    if (live && !live.failure()) {
      try {
        const text = await live.finish(this.abort.signal);
        if (this.abort.signal.aborted) return { kind: "cancelled" };
        if (text) return { kind: "text", text, capped, via: "live" };
        return silent ? { kind: "silent", streamed: this.streamed } : { kind: "empty" };
      } catch {
        if (this.abort.signal.aborted) return { kind: "cancelled" };
        // The live stream failed; upload the complete clip below.
      }
    }
    if (silent) return { kind: "silent", streamed: this.streamed };
    try {
      const text = await this.upload(encodePcm16MonoWav(pcm, XAI_DICTATION_SAMPLE_RATE), this.abort.signal);
      if (this.abort.signal.aborted) return { kind: "cancelled" };
      return text ? { kind: "text", text, capped, via: "clip" } : { kind: "empty" };
    } catch (error) {
      if (this.abort.signal.aborted) return { kind: "cancelled" };
      return {
        kind: "error",
        message: error instanceof XaiVoiceOperationError ? error.message : "Grok voice transcription failed.",
      };
    }
  }

  /** Discard a recording that has not been sent for transcription, or abort a pending transcription. */
  cancel(): void {
    if (this.settled) return;
    this.abort.abort();
    this.recording.cancel();
    this.live?.close();
    if (!this.uploading) this.settle({ kind: "discarded", streamed: this.streamed });
  }
}

/** Ctrl+Space and F8 in legacy, Kitty CSI-u, and modifyOtherKeys encodings; repeats are ignored. */
export function isXaiVoiceToggleKey(data: string): boolean {
  if (data === "\x00" || data === "\x1b[19~") return true;
  const kitty = /^\x1b\[32;(\d+)(?::(\d+))?u$/.exec(data);
  if (kitty) {
    const modifier = Number(kitty[1]) - 1;
    // Ctrl only, ignoring Caps Lock (64) and Num Lock (128); press events only.
    return (modifier & ~(64 | 128)) === 4 && (kitty[2] ?? "1") === "1";
  }
  const f8 = /^\x1b\[19;(\d+)(?::(\d+))?~$/.exec(data);
  if (f8) return ((Number(f8[1]) - 1) & ~(64 | 128)) === 0 && (f8[2] ?? "1") === "1";
  const other = /^\x1b\[27;(\d+);32~$/.exec(data);
  return other !== null && ((Number(other[1]) - 1) & ~(64 | 128)) === 4;
}

function isConfirmKey(data: string, keybindings: any): boolean {
  if (data === "\r" || data === "\n") return true;
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

function sessionStatus(session: XaiDictationSession): string {
  if (session.transcribing) return session.uploading ? "Transcribing with xAI…" : "Stopping…";
  if (!session.recordingActive) {
    return session.endReason === "cap"
      ? `Recording limit reached (${formatElapsed(XAI_DICTATION_MAX_DURATION_MS)})`
      : "The microphone recorder stopped";
  }
  const bars = LEVEL_BARS[Math.min(LEVEL_BARS.length - 1, Math.floor(session.recording.level() * LEVEL_BARS.length))];
  const live = session.mode !== "live"
    ? ""
    : session.liveState === "connecting"
      ? " · connecting…"
      : session.liveState === "failed"
        ? " · live unavailable; Enter uploads the clip"
        : "";
  return `● ${formatElapsed(session.elapsedMs())} / ${formatElapsed(XAI_DICTATION_MAX_DURATION_MS)} ${bars} · ${LANGUAGE_NAMES[session.language]}${live}`;
}

/** Render the dictation overlay as plain lines no wider than `width - 2` columns. */
export function renderXaiDictation(session: XaiDictationSession, width: number): string[] {
  const limit = Math.max(1, width - 2);
  const fit = (text: string) => text.slice(0, limit);
  const title = `Grok voice${session.mode === "live" ? " (live)" : ""} — ${sessionStatus(session)}`;
  const lines = [fit(title)];
  if (session.mode === "live") {
    const preview = session.preview();
    const room = Math.max(2, limit - 2);
    lines.push(fit(preview
      ? `  ${preview.length > room ? `…${preview.slice(-(room - 1))}` : preview}`
      : session.liveState === "live" ? "  Listening…" : ""));
  }
  const waiting = !session.settled && !session.transcribing;
  lines.push(fit(waiting
    ? `  Enter or Ctrl+Space: ${session.mode === "live" ? "insert" : "transcribe"} · Esc: discard${session.mode === "clip" ? " (nothing is sent)" : ""}`
    : "  Esc: cancel"));
  return lines;
}

function openTuiDictation(ctx: any, session: XaiDictationSession) {
  return ctx.ui.custom((tui: any, theme: any, keybindings: any, done: (result: XaiDictationResult) => void) => {
    const timer = setInterval(() => tui?.requestRender?.(), RENDER_INTERVAL_MS);
    timer.unref?.();
    void session.outcome.then((result) => {
      clearInterval(timer);
      done(result);
    });
    const paint = (role: string, text: string) => {
      try {
        return theme?.fg?.(role, text) ?? text;
      } catch {
        return text;
      }
    };
    return {
      render(width: number) {
        const lines = renderXaiDictation(session, width);
        return lines.map((line, index) =>
          paint(index === 0 ? "accent" : index === lines.length - 1 ? "muted" : "text", line));
      },
      invalidate() {},
      handleInput(data: string) {
        const toggle = isXaiVoiceToggleKey(data);
        if (toggle && session.elapsedMs() < TOGGLE_DEBOUNCE_MS) return;
        if (!session.transcribing && (toggle || isConfirmKey(data, keybindings))) {
          void session.finish();
        } else if (isCancelKey(data, keybindings)) {
          session.cancel();
        }
        tui?.requestRender?.();
      },
      dispose() {
        clearInterval(timer);
        session.cancel();
      },
    };
  });
}

async function runSelectDictation(ctx: any, session: XaiDictationSession): Promise<void> {
  const stop = session.mode === "live" ? "Stop and insert" : "Stop and transcribe";
  const discard = "Discard recording";
  // Dismiss the host dialog as soon as the session ends some other way.
  const dialog = new AbortController();
  void session.outcome.then(() => dialog.abort());
  const limit = formatElapsed(XAI_DICTATION_MAX_DURATION_MS);
  const title = session.mode === "live"
    ? `Grok voice is listening live (${LANGUAGE_NAMES[session.language]}, up to ${limit})`
    : `Grok voice is recording (${LANGUAGE_NAMES[session.language]}, up to ${limit})`;
  const choice = await ctx.ui.select(title, [stop, discard], { signal: dialog.signal });
  if (choice === stop) void session.finish();
  else session.cancel();
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
  // Pi's RPC host cannot read the client's draft, so this sets the editor text.
  ctx.ui.setEditorText(`${current}${fragment}`);
}

function reportResult(
  ctx: any,
  result: XaiDictationResult,
  mode: XaiDictationMode,
  platform: NodeJS.Platform,
): void {
  switch (result.kind) {
    case "text":
      insertTranscript(ctx, result.text);
      if (result.capped) {
        ctx.ui.notify(
          `Recording stopped at the ${XAI_DICTATION_MAX_DURATION_MS / 60_000}-minute limit; the captured part was transcribed.`,
          "info",
        );
      }
      if (mode === "live" && result.via === "clip") {
        ctx.ui.notify("Live transcription was unavailable, so the recording was uploaded instead.", "info");
      }
      return;
    case "empty":
      ctx.ui.notify("No speech was detected. Nothing was inserted.", "warning");
      return;
    case "silent":
      ctx.ui.notify(
        `The microphone recorded only silence${result.streamed ? "" : ", so nothing was sent to xAI"}. ${xaiMicrophoneHelp(platform)}`,
        "warning",
      );
      return;
    case "discarded":
      ctx.ui.notify(
        result.streamed
          ? "Discarded the dictation; nothing was inserted. Audio already streamed live to xAI is not recalled."
          : "Discarded the recording; nothing was sent to xAI.",
        "info",
      );
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
 * Register Grok voice dictation: `/xai-voice [language] [live|clip]` plus
 * Grok Build's Ctrl+Space and F8 shortcuts. Live mode (the default) streams
 * the microphone to the pinned xAI speech-to-text socket with the OAuth or
 * API-key bearer and shows words as they are recognized; clip mode uploads
 * once on Enter. The text is inserted into Pi's editor, never submitted.
 */
export function registerXaiVoice(
  pi: ExtensionAPI,
  dependencies: XaiDictationDependencies = {},
): XaiVoiceController {
  const startRecording = dependencies.startRecording ?? (() => startXaiMicrophoneRecording());
  const resolveCredential = dependencies.resolveCredential ?? resolveXaiCredential;
  const transcribe = dependencies.transcribe ?? transcribeXaiAudio;
  const connectLive = dependencies.connectLive ?? ((options) => connectXaiLiveTranscription(options));
  const now = dependencies.now ?? Date.now;
  const locale = dependencies.locale ?? (() => Intl.DateTimeFormat().resolvedOptions().locale);
  const platform = dependencies.platform ?? process.platform;
  let preference: XaiSttLanguage | "auto" = XAI_STT_DEFAULT_LANGUAGE;
  let mode: XaiDictationMode = "live";
  let active: XaiDictationSession | undefined;
  let starting = false;
  let generation = 0;

  const dictate = async (ctx: any) => {
    if (!ctx?.hasUI || typeof ctx?.ui?.notify !== "function") {
      ctx?.ui?.notify?.(`/${XAI_VOICE_COMMAND} needs Pi's interactive TUI or an RPC client.`, "error");
      return;
    }
    if (active) {
      // Pressing the chord again stops and transcribes, as in Grok Build.
      if (!active.transcribing && active.elapsedMs() >= TOGGLE_DEBOUNCE_MS) void active.finish();
      return;
    }
    // Claim the slot before any await so repeated triggers cannot open a second recorder.
    if (starting) return;
    starting = true;
    const startGeneration = generation;
    const language = resolveXaiDictationLanguage(preference, locale());
    const sessionMode = mode;
    let session: XaiDictationSession;
    try {
      // Fail before opening the microphone when no xAI credential can transcribe.
      const credential = await resolveCredential(ctx);
      if (!credential) {
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
      if (startGeneration !== generation) {
        recording.cancel();
        return;
      }
      session = new XaiDictationSession({
        recording,
        language,
        mode: sessionMode,
        now,
        noSpeechMs: dependencies.noSpeechMs,
        connectLive: (signal) => connectLive({ credential, language, signal }),
        upload: async (wav, signal) => {
          // Resolve again at upload time so a long recording uses a fresh token.
          const fresh = await resolveCredential(ctx);
          if (!fresh) {
            throw new XaiVoiceOperationError("xAI credentials are no longer available; sign in again.", "http_failure");
          }
          const transcription = await transcribe({
            credential: fresh,
            audio: { bytes: wav, mimeType: "audio/wav" },
            language,
            signal,
          });
          return transcription.text;
        },
      });
      active = session;
    } finally {
      starting = false;
    }

    const failSafely = () => session.fail("Grok voice stopped unexpectedly; nothing was inserted.");
    let overlayClosed: Promise<unknown> = Promise.resolve();
    if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
      overlayClosed = Promise.resolve().then(() => openTuiDictation(ctx, session)).catch(failSafely);
    } else {
      void Promise.resolve().then(() => runSelectDictation(ctx, session)).catch(failSafely);
    }
    const result = await session.outcome;
    if (active === session) active = undefined;
    // Pi restores the pre-dictation draft when the overlay closes, so insert only after it has closed.
    await overlayClosed;
    // A reset (session switch) must not insert text into the next session's editor.
    if (startGeneration !== generation) return;
    reportResult(ctx, result, sessionMode, platform);
  };

  pi.registerCommand(XAI_VOICE_COMMAND, {
    description: "Dictate into the prompt with Grok voice (live speech-to-text); optional language and live|clip",
    getArgumentCompletions: (prefix: string) => {
      const current = (prefix.trimStart().split(/\s+/).at(-1) ?? "").toLowerCase();
      const items = (["auto", ...XAI_STT_LANGUAGES, ...XAI_DICTATION_MODES] as const)
        .filter((code) => code.startsWith(current))
        .map((code) => ({
          value: code,
          label: code,
          description: code === "auto"
            ? "Use the system language"
            : code === "live"
              ? "Stream audio and show words as you speak (default)"
              : code === "clip"
                ? "Keep audio local until Enter, then upload once"
                : LANGUAGE_NAMES[code],
        }));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: any) => {
      const words = args.trim().split(/\s+/).filter(Boolean).map((word) => word.toLowerCase());
      let nextLanguage: XaiSttLanguage | "auto" | undefined;
      let nextMode: XaiDictationMode | undefined;
      for (const word of words) {
        if ((word === "live" || word === "clip") && nextMode === undefined) {
          nextMode = word;
        } else if ((word === "auto" || isXaiSttLanguage(word)) && nextLanguage === undefined) {
          nextLanguage = word;
        } else {
          ctx.ui.notify(`${XAI_VOICE_USAGE}. Languages: auto, ${XAI_STT_LANGUAGES.join(", ")}.`, "error");
          return;
        }
      }
      if (nextLanguage) preference = nextLanguage;
      if (nextMode) mode = nextMode;
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
      generation += 1;
      active?.cancel();
      active = undefined;
      preference = XAI_STT_DEFAULT_LANGUAGE;
      mode = "live";
    },
  };
}
