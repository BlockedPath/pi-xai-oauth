import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  XAI_RECORDER_MAX_DIAGNOSTIC_CHARS,
  XAI_RECORDER_START_GRACE_MS,
  XAI_TALK_SAMPLE_RATE,
} from "./constants";
import { XaiRecorderUnavailableError, type XaiRecorderCommand } from "./recorder";

/** Queued playback beyond this is dropped instead of growing without bound. */
const MAX_PENDING_PLAYBACK_BYTES = 16 * 1024 * 1024;

/** A system audio player fed raw PCM16LE mono on stdin. */
export interface XaiAudioPlayer {
  /** The player program that is running. */
  readonly program: string;
  /** Queue audio; a stopped player restarts on the next write. */
  write(pcm: Buffer): void;
  /** Drop everything queued or playing right now (used when interrupting). */
  stop(): void;
  /** Stop playback and release the player. */
  close(): void;
}

export interface XaiPlayerDependencies {
  spawn?: typeof nodeSpawn;
  platform?: NodeJS.Platform;
  commands?: readonly XaiRecorderCommand[];
  sampleRate?: number;
  startGraceMs?: number;
}

function soxPlayback(rate: string): XaiRecorderCommand {
  return {
    program: "sox",
    args: ["-q", "-t", "raw", "-r", rate, "-e", "signed-integer", "-b", "16", "-c", "1", "-L", "-", "-d"],
  };
}

/**
 * Ordered audio player candidates for a platform, mirroring the recorder
 * walk: PipeWire, PulseAudio, ALSA, then SoX on Linux; SoX then ffplay on
 * macOS; SoX elsewhere. Each reads raw PCM16LE mono from stdin.
 */
export function xaiPlayerCommands(
  platform: NodeJS.Platform = process.platform,
  sampleRate = XAI_TALK_SAMPLE_RATE,
): XaiRecorderCommand[] {
  const rate = String(sampleRate);
  if (platform === "linux") {
    return [
      { program: "pw-play", args: ["--raw", "--rate", rate, "--channels", "1", "--format", "s16", "-"] },
      { program: "pacat", args: ["--playback", "--format=s16le", `--rate=${rate}`, "--channels=1"] },
      { program: "aplay", args: ["-q", "-t", "raw", "-f", "S16_LE", "-c", "1", "-r", rate, "-"] },
      soxPlayback(rate),
    ];
  }
  if (platform === "darwin") {
    return [
      soxPlayback(rate),
      {
        program: "ffplay",
        args: [
          "-nodisp", "-autoexit", "-hide_banner", "-loglevel", "error",
          "-f", "s16le", "-sample_rate", rate, "-ch_layout", "mono", "-i", "-",
        ],
      },
    ];
  }
  return [soxPlayback(rate)];
}

/** Platform-specific install guidance when no audio player is available. */
export function xaiPlayerInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "linux") {
    return "Install PipeWire (pw-play), PulseAudio utilities (pacat), ALSA utilities (aplay), or SoX (sox).";
  }
  if (platform === "darwin") return "Install SoX (brew install sox) or FFmpeg (brew install ffmpeg).";
  return "Install SoX and make sure sox is on PATH.";
}

function spawnPlayer(command: XaiRecorderCommand, spawnFn: typeof nodeSpawn): ChildProcess {
  const child = spawnFn(command.program, command.args, {
    stdio: ["pipe", "ignore", "pipe"],
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  // A killed player closes its stdin; late pipe errors must never crash Pi.
  child.on("error", () => undefined);
  child.stdin?.on("error", () => undefined);
  // Drain diagnostics (for example ALSA underrun warnings) so the pipe never stalls playback.
  child.stderr?.resume();
  return child;
}

function killQuietly(child: ChildProcess | undefined): void {
  try {
    child?.kill("SIGKILL");
  } catch {
    // The player may already have exited.
  }
}

type PlayerAttempt =
  | { ok: true; child: ChildProcess }
  | { ok: false; missing: boolean; failure: string };

function attemptPlayer(command: XaiRecorderCommand, spawnFn: typeof nodeSpawn, graceMs: number): Promise<PlayerAttempt> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnPlayer(command, spawnFn);
    } catch {
      resolve({ ok: false, missing: false, failure: `${command.program} failed to start` });
      return;
    }
    let stderr = "";
    let settled = false;
    const finish = (attempt: PlayerAttempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(attempt);
    };
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
      const line = stderr.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").split(/\r?\n/).find((value) => value.trim());
      finish({
        ok: false,
        missing: false,
        failure: `${command.program} exited immediately (${code ?? signal})${line ? `: ${line.trim().slice(0, XAI_RECORDER_MAX_DIAGNOSTIC_CHARS)}` : ""}`,
      });
    });
    const timer = setTimeout(() => finish({ ok: true, child }), graceMs);
  });
}

/**
 * Start the first system audio player that survives the start grace. Later
 * restarts (after `stop()`) reuse that program without another walk.
 */
export async function startXaiAudioPlayer(dependencies: XaiPlayerDependencies = {}): Promise<XaiAudioPlayer> {
  const platform = dependencies.platform ?? process.platform;
  const spawnFn = dependencies.spawn ?? nodeSpawn;
  const graceMs = dependencies.startGraceMs ?? XAI_RECORDER_START_GRACE_MS;
  const commands = dependencies.commands
    ?? xaiPlayerCommands(platform, dependencies.sampleRate ?? XAI_TALK_SAMPLE_RATE);
  const failures: string[] = [];
  let allMissing = true;
  for (const command of commands) {
    const attempt = await attemptPlayer(command, spawnFn, graceMs);
    if (!attempt.ok) {
      failures.push(attempt.failure);
      if (!attempt.missing) allMissing = false;
      continue;
    }
    return createPlayer(command, attempt.child, spawnFn);
  }
  if (allMissing) {
    throw new XaiRecorderUnavailableError(`No audio player was found. ${xaiPlayerInstallHint(platform)}`);
  }
  throw new XaiRecorderUnavailableError(
    `Could not start an audio player: ${failures.join("; ").slice(0, 4 * XAI_RECORDER_MAX_DIAGNOSTIC_CHARS)}`,
  );
}

function createPlayer(
  command: XaiRecorderCommand,
  first: ChildProcess,
  spawnFn: typeof nodeSpawn,
): XaiAudioPlayer {
  let child: ChildProcess | undefined = first;
  let closed = false;
  const forget = (exited: ChildProcess) => {
    if (child === exited) child = undefined;
  };
  first.once("close", () => forget(first));
  const killOnExit = () => killQuietly(child);
  process.once("exit", killOnExit);

  return {
    program: command.program,
    write(pcm) {
      if (closed || pcm.length === 0) return;
      if (!child) {
        try {
          const next = spawnPlayer(command, spawnFn);
          next.once("close", () => forget(next));
          child = next;
        } catch {
          return;
        }
      }
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableLength > MAX_PENDING_PLAYBACK_BYTES) return;
      try {
        stdin.write(pcm);
      } catch {
        // A player that died mid-write restarts on the next chunk.
      }
    },
    stop() {
      const current = child;
      child = undefined;
      killQuietly(current);
    },
    close() {
      if (closed) return;
      closed = true;
      process.removeListener("exit", killOnExit);
      const current = child;
      child = undefined;
      killQuietly(current);
    },
  };
}
