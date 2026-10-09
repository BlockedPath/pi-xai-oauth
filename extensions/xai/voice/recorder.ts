import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { pcm16Peak } from "./audio";
import {
  XAI_DICTATION_MAX_PCM_BYTES,
  XAI_DICTATION_SAMPLE_RATE,
  XAI_RECORDER_MAX_DIAGNOSTIC_CHARS,
  XAI_RECORDER_START_GRACE_MS,
  XAI_RECORDER_STOP_TIMEOUT_MS,
} from "./constants";

/** One system recorder invocation that writes raw PCM16LE mono to stdout. */
export interface XaiRecorderCommand {
  program: string;
  args: string[];
}

/** Why a recording ended before the user stopped it. */
export type XaiRecordingEnd = "cap" | "exited";

/** A live microphone capture whose audio stays in memory until stopped. */
export interface XaiMicrophoneRecording {
  /** The recorder program that is capturing. */
  readonly program: string;
  /** Resolves when capture ends without a stop: the byte cap or the recorder exiting. */
  readonly ended: Promise<XaiRecordingEnd>;
  /** Captured PCM bytes so far. */
  bytesCaptured(): number;
  /** Normalized 0–1 peak of the most recent audio chunk, for a level meter. */
  level(): number;
  /** Stop gracefully, drain queued audio, and return the captured PCM16LE mono frames. */
  stop(): Promise<Buffer>;
  /** Kill the recorder and discard every captured byte. */
  cancel(): void;
}

export interface XaiRecorderDependencies {
  spawn?: typeof nodeSpawn;
  platform?: NodeJS.Platform;
  commands?: readonly XaiRecorderCommand[];
  sampleRate?: number;
  maxBytes?: number;
  startGraceMs?: number;
  stopTimeoutMs?: number;
}

/** The microphone recorder could not be started; the message is safe to show. */
export class XaiRecorderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XaiRecorderUnavailableError";
  }
}

function soxCommand(rate: string): XaiRecorderCommand {
  return {
    program: "sox",
    args: ["-q", "-d", "-t", "raw", "-r", rate, "-e", "signed-integer", "-b", "16", "-c", "1", "-L", "-"],
  };
}

/**
 * Ordered recorder candidates for a platform. Linux mirrors Grok Build's
 * system-recorder walk (`pw-record --raw`, `parec`, `arecord`) with SoX last;
 * macOS uses SoX or FFmpeg's AVFoundation default input; others use SoX.
 */
export function xaiRecorderCommands(
  platform: NodeJS.Platform = process.platform,
  sampleRate = XAI_DICTATION_SAMPLE_RATE,
): XaiRecorderCommand[] {
  const rate = String(sampleRate);
  if (platform === "linux") {
    return [
      // Without --raw, pw-record wraps stdout in a container instead of raw PCM.
      { program: "pw-record", args: ["--raw", "--rate", rate, "--channels", "1", "--format", "s16", "-"] },
      { program: "parec", args: ["--raw", "--format=s16le", `--rate=${rate}`, "--channels=1"] },
      { program: "arecord", args: ["-q", "-t", "raw", "-f", "S16_LE", "-c", "1", "-r", rate, "-"] },
      soxCommand(rate),
    ];
  }
  if (platform === "darwin") {
    return [
      soxCommand(rate),
      {
        program: "ffmpeg",
        args: [
          "-hide_banner", "-loglevel", "error", "-nostdin",
          "-f", "avfoundation", "-i", "none:default",
          "-ac", "1", "-ar", rate, "-acodec", "pcm_s16le", "-f", "s16le", "-",
        ],
      },
    ];
  }
  return [soxCommand(rate)];
}

/** Platform-specific install guidance when no recorder program is available. */
export function xaiRecorderInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "linux") {
    return "Install PipeWire (pw-record), PulseAudio utilities (parec), ALSA utilities (arecord), or SoX (sox).";
  }
  if (platform === "darwin") return "Install SoX (brew install sox) or FFmpeg (brew install ffmpeg).";
  return "Install SoX and make sure sox is on PATH.";
}

function diagnostic(text: string): string {
  const firstLine = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").split(/\r?\n/).find((line) => line.trim());
  return firstLine ? `: ${firstLine.trim().slice(0, XAI_RECORDER_MAX_DIAGNOSTIC_CHARS)}` : "";
}

interface Capture {
  chunks: Buffer[];
  total: number;
  lastPeak: number;
  capped: boolean;
}

type StartAttempt =
  | { ok: true; child: ChildProcess }
  | { ok: false; missing: boolean; failure: string };

function attemptStart(
  command: XaiRecorderCommand,
  spawnFn: typeof nodeSpawn,
  graceMs: number,
  capture: Capture,
  maxBytes: number,
  onCap: () => void,
): Promise<StartAttempt> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(command.program, command.args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        // Its own session keeps the recorder off the terminal's job control.
        detached: process.platform !== "win32",
      });
    } catch {
      resolve({ ok: false, missing: false, failure: `${command.program} failed to start` });
      return;
    }
    let stderr = "";
    let settled = false;
    const finish = (attempt: StartAttempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(attempt);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (capture.capped) return;
      const room = maxBytes - capture.total;
      const accepted = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (accepted.length > 0) {
        capture.chunks.push(accepted);
        capture.total += accepted.length;
        capture.lastPeak = pcm16Peak(accepted);
      }
      if (capture.total >= maxBytes) {
        capture.capped = true;
        onCap();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4 * XAI_RECORDER_MAX_DIAGNOSTIC_CHARS) stderr += chunk.toString("utf8");
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      const missing = error?.code === "ENOENT";
      finish({
        ok: false,
        missing,
        failure: missing ? `${command.program} is not installed` : `${command.program} failed to start`,
      });
    });
    child.once("exit", (code, signal) => {
      finish({
        ok: false,
        missing: false,
        failure: `${command.program} exited immediately (${code ?? signal})${diagnostic(stderr)}`,
      });
    });
    const timer = setTimeout(() => finish({ ok: true, child }), graceMs);
  });
}

function killQuietly(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The recorder may already have exited; teardown stays best-effort.
  }
}

/**
 * Start the first system recorder that survives the start grace. Audio is
 * held in memory only, capped at `maxBytes`, and never written to disk.
 */
export async function startXaiMicrophoneRecording(
  dependencies: XaiRecorderDependencies = {},
): Promise<XaiMicrophoneRecording> {
  const platform = dependencies.platform ?? process.platform;
  const sampleRate = dependencies.sampleRate ?? XAI_DICTATION_SAMPLE_RATE;
  const maxBytes = dependencies.maxBytes ?? XAI_DICTATION_MAX_PCM_BYTES;
  const spawnFn = dependencies.spawn ?? nodeSpawn;
  const graceMs = dependencies.startGraceMs ?? XAI_RECORDER_START_GRACE_MS;
  const stopTimeoutMs = dependencies.stopTimeoutMs ?? XAI_RECORDER_STOP_TIMEOUT_MS;
  const commands = dependencies.commands ?? xaiRecorderCommands(platform, sampleRate);

  const failures: string[] = [];
  let allMissing = true;
  for (const command of commands) {
    const capture: Capture = { chunks: [], total: 0, lastPeak: 0, capped: false };
    let resolveEnded!: (end: XaiRecordingEnd) => void;
    const ended = new Promise<XaiRecordingEnd>((resolve) => {
      resolveEnded = resolve;
    });
    let child: ChildProcess | undefined;
    const attempt = await attemptStart(command, spawnFn, graceMs, capture, maxBytes, () => {
      if (child) killQuietly(child, "SIGTERM");
      resolveEnded("cap");
    });
    if (!attempt.ok) {
      failures.push(attempt.failure);
      if (!attempt.missing) allMissing = false;
      continue;
    }
    child = attempt.child;
    if (capture.capped) killQuietly(child, "SIGTERM");
    return createRecording(command.program, child, capture, ended, resolveEnded, stopTimeoutMs);
  }
  if (allMissing) {
    throw new XaiRecorderUnavailableError(
      `No microphone recorder was found. ${xaiRecorderInstallHint(platform)}`,
    );
  }
  throw new XaiRecorderUnavailableError(
    `Could not start a microphone recorder: ${failures.join("; ").slice(0, 4 * XAI_RECORDER_MAX_DIAGNOSTIC_CHARS)}`,
  );
}

function createRecording(
  program: string,
  child: ChildProcess,
  capture: Capture,
  ended: Promise<XaiRecordingEnd>,
  resolveEnded: (end: XaiRecordingEnd) => void,
  stopTimeoutMs: number,
): XaiMicrophoneRecording {
  let closed = false;
  let finished = false;
  // A late spawn/kill error must never become an uncaught EventEmitter error.
  child.on("error", () => undefined);
  const closedPromise = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      closed = true;
      resolve();
      return;
    }
    child.once("close", () => {
      closed = true;
      resolve();
    });
  });
  // An unexpected exit ends capture; the user still decides whether to transcribe.
  void closedPromise.then(() => resolveEnded("exited"));
  const killOnExit = () => killQuietly(child, "SIGKILL");
  process.once("exit", killOnExit);
  const release = () => {
    finished = true;
    process.removeListener("exit", killOnExit);
  };

  return {
    program,
    ended,
    bytesCaptured: () => capture.total,
    level: () => Math.min(1, capture.lastPeak / 32768),
    async stop() {
      if (finished) return Buffer.alloc(0);
      if (!closed) {
        killQuietly(child, "SIGTERM");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), stopTimeoutMs);
        });
        const outcome = await Promise.race([closedPromise.then(() => "closed" as const), timedOut]);
        clearTimeout(timer);
        if (outcome === "timeout") killQuietly(child, "SIGKILL");
      }
      release();
      const pcm = Buffer.concat(capture.chunks, capture.total);
      capture.chunks = [];
      return pcm.subarray(0, pcm.length & ~1);
    },
    cancel() {
      if (finished) return;
      release();
      capture.chunks = [];
      capture.total = 0;
      if (!closed) killQuietly(child, "SIGKILL");
    },
  };
}
