import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  startXaiMicrophoneRecording,
  xaiRecorderCommands,
  xaiRecorderInstallHint,
  XaiRecorderUnavailableError,
} from "../../extensions/xai/voice/recorder";
import { speechPcm } from "../fixtures/audio";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: string[] = [];
  onKill?: (signal: string) => void;

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.kills.push(signal);
    this.onKill?.(signal);
    return true;
  }

  /** Exit and close after flushed stdout, like a real child. */
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.stdout.end();
    setImmediate(() => this.emit("close", code, signal));
  }
}

type Behavior = (child: FakeChild) => void;

function fakeSpawn(behaviors: Record<string, Behavior | "throw">) {
  const children = new Map<string, FakeChild>();
  const calls: Array<{ program: string; args: string[]; options: any }> = [];
  const spawn = vi.fn((program: string, args: string[], options: any) => {
    calls.push({ program, args, options });
    const behavior = behaviors[program];
    if (behavior === "throw") throw new Error("spawn EACCES");
    const child = new FakeChild();
    children.set(program, child);
    setImmediate(() => behavior?.(child));
    return child as any;
  });
  return { spawn: spawn as any, calls, children };
}

const enoent: Behavior = (child) => {
  child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
};
const commands = [
  { program: "first", args: ["--one"] },
  { program: "second", args: ["--two"] },
  { program: "third", args: ["--three"] },
];

describe("Grok voice microphone recorder", () => {
  it("mirrors Grok Build's Linux recorder walk and adds portable SoX/FFmpeg fallbacks", () => {
    expect(xaiRecorderCommands("linux", 16_000)).toEqual([
      { program: "pw-record", args: ["--raw", "--rate", "16000", "--channels", "1", "--format", "s16", "-"] },
      { program: "parec", args: ["--raw", "--format=s16le", "--rate=16000", "--channels=1"] },
      { program: "arecord", args: ["-q", "-t", "raw", "-f", "S16_LE", "-c", "1", "-r", "16000", "-"] },
      {
        program: "sox",
        args: ["-q", "-d", "-t", "raw", "-r", "16000", "-e", "signed-integer", "-b", "16", "-c", "1", "-L", "-"],
      },
    ]);
    expect(xaiRecorderCommands("darwin").map(({ program }) => program)).toEqual(["sox", "ffmpeg"]);
    expect(xaiRecorderCommands("darwin")[1]!.args).toEqual(expect.arrayContaining([
      "-f", "avfoundation", "-i", "none:default", "-ac", "1", "-ar", "16000", "s16le",
    ]));
    expect(xaiRecorderCommands("win32").map(({ program }) => program)).toEqual(["sox"]);
    expect(xaiRecorderInstallHint("linux")).toMatch(/pw-record.*parec.*arecord.*sox/);
    expect(xaiRecorderInstallHint("darwin")).toMatch(/brew install sox/);
    expect(xaiRecorderInstallHint("win32")).toMatch(/SoX/);
  });

  it("falls through missing and immediately exiting recorders to the first one that survives the grace", async () => {
    const { spawn, calls, children } = fakeSpawn({
      first: enoent,
      second: (child) => {
        child.stderr.write("unrecognized option '--raw'\u001b[0m\nmore detail\n");
        setTimeout(() => child.exit(1), 2);
      },
      third: (child) => child.stdout.write(Buffer.from([0x10, 0x00])),
    });
    const recording = await startXaiMicrophoneRecording({ spawn, commands, startGraceMs: 30 });
    expect(recording.program).toBe("third");
    expect(calls.map(({ program, args }) => [program, args])).toEqual([
      ["first", ["--one"]],
      ["second", ["--two"]],
      ["third", ["--three"]],
    ]);
    expect(calls[0]!.options).toMatchObject({ stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    expect(recording.bytesCaptured()).toBe(2);
    recording.cancel();
    expect(children.get("third")!.kills).toEqual(["SIGKILL"]);
  });

  it("explains how to install a recorder when none exists", async () => {
    const { spawn } = fakeSpawn({ first: enoent, second: enoent, third: enoent });
    const error = await startXaiMicrophoneRecording({ spawn, commands, platform: "darwin", startGraceMs: 5 })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(XaiRecorderUnavailableError);
    expect(error.message).toBe("No microphone recorder was found. Install SoX (brew install sox) or FFmpeg (brew install ffmpeg).");
  });

  it("joins sanitized start failures when recorders exist but cannot capture", async () => {
    const { spawn } = fakeSpawn({
      first: "throw",
      second: (child) => {
        child.stderr.write("\n  no default source\u0007 available\n");
        child.exit(1);
      },
      third: enoent,
    });
    const error = await startXaiMicrophoneRecording({ spawn, commands, startGraceMs: 30 }).catch((caught) => caught);
    expect(error).toBeInstanceOf(XaiRecorderUnavailableError);
    expect(error.message).toBe(
      "Could not start a microphone recorder: first failed to start; second exited immediately (1): no default source available; third is not installed",
    );
  });

  it("stops gracefully and keeps audio flushed after the stop signal", async () => {
    const { spawn, children } = fakeSpawn({
      first: (child) => child.stdout.write(speechPcm(4)),
    });
    const recording = await startXaiMicrophoneRecording({ spawn, commands, startGraceMs: 10 });
    const child = children.get("first")!;
    child.stdout.write(Buffer.from([0x00, 0x40, 0x01]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(recording.level()).toBeCloseTo(0.5, 2);
    child.onKill = (signal) => {
      if (signal !== "SIGTERM") return;
      child.stdout.write(Buffer.from([0x02]));
      child.exit(null, "SIGTERM");
    };
    const pcm = await recording.stop();
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(pcm).toEqual(Buffer.concat([speechPcm(4), Buffer.from([0x00, 0x40, 0x01, 0x02])]));
    expect(await recording.ended).toBe("exited");
    expect(await recording.stop()).toEqual(Buffer.alloc(0));
  });

  it("force-kills a recorder that ignores the stop signal", async () => {
    const { spawn, children } = fakeSpawn({ first: (child) => child.stdout.write(speechPcm(2)) });
    const recording = await startXaiMicrophoneRecording({ spawn, commands, startGraceMs: 10, stopTimeoutMs: 10 });
    const pcm = await recording.stop();
    expect(children.get("first")!.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(pcm).toEqual(speechPcm(2));
  });

  it("caps capture at the byte limit and reports the cap", async () => {
    const { spawn, children } = fakeSpawn({ first: () => undefined });
    const recording = await startXaiMicrophoneRecording({ spawn, commands, startGraceMs: 10, maxBytes: 6 });
    const child = children.get("first")!;
    child.stdout.write(Buffer.from([1, 0, 2, 0]));
    child.stdout.write(Buffer.from([3, 0, 4, 0]));
    child.stdout.write(Buffer.from([5, 0]));
    expect(await recording.ended).toBe("cap");
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(recording.bytesCaptured()).toBe(6);
    child.exit(null, "SIGTERM");
    expect(await recording.stop()).toEqual(Buffer.from([1, 0, 2, 0, 3, 0]));
  });

  it("caps a recorder that fills the buffer during the start grace", async () => {
    const { spawn, children } = fakeSpawn({ first: (child) => child.stdout.write(Buffer.alloc(8, 1)) });
    const recording = await startXaiMicrophoneRecording({ spawn, commands, startGraceMs: 10, maxBytes: 4 });
    expect(await recording.ended).toBe("cap");
    expect(children.get("first")!.kills).toContain("SIGTERM");
  });

  it("reports a recorder that exits on its own and discards on cancel", async () => {
    const { spawn, children } = fakeSpawn({ first: (child) => child.stdout.write(speechPcm(2)) });
    const recording = await startXaiMicrophoneRecording({ spawn, commands, startGraceMs: 10 });
    children.get("first")!.exit(0);
    expect(await recording.ended).toBe("exited");
    recording.cancel();
    expect(children.get("first")!.kills).toEqual([]);
    expect(recording.bytesCaptured()).toBe(0);
    expect(await recording.stop()).toEqual(Buffer.alloc(0));
  });

  it("shares the backlog and later chunks with subscribers without breaking capture", async () => {
    const { spawn, children } = fakeSpawn({ first: (child) => child.stdout.write(Buffer.from([1, 0])) });
    const recording = await startXaiMicrophoneRecording({ spawn, commands, startGraceMs: 10 });
    expect(recording.snapshot()).toEqual(Buffer.from([1, 0]));
    const received: Buffer[] = [];
    const unsubscribe = recording.subscribe((chunk) => received.push(chunk));
    recording.subscribe(() => {
      throw new Error("consumer failed");
    });
    const child = children.get("first")!;
    child.stdout.write(Buffer.from([2, 0]));
    await new Promise((resolve) => setImmediate(resolve));
    unsubscribe();
    child.stdout.write(Buffer.from([3, 0]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual([Buffer.from([2, 0])]);
    expect(recording.snapshot()).toEqual(Buffer.from([1, 0, 2, 0, 3, 0]));
    child.onKill = () => child.exit(null, "SIGTERM");
    expect(await recording.stop()).toEqual(Buffer.from([1, 0, 2, 0, 3, 0]));
    expect(recording.snapshot()).toEqual(Buffer.from([1, 0, 2, 0, 3, 0]));
    const late = vi.fn();
    recording.subscribe(late)();
    expect(late).not.toHaveBeenCalled();
  });

  it("enforces the wall-clock limit even when the recorder delivers no audio", async () => {
    const { spawn, children } = fakeSpawn({ first: () => undefined });
    const recording = await startXaiMicrophoneRecording({ spawn, commands, startGraceMs: 5, maxDurationMs: 20 });
    expect(await recording.ended).toBe("cap");
    expect(children.get("first")!.kills).toEqual(["SIGTERM"]);
  });

  it("captures raw PCM from a real recorder subprocess", async () => {
    const script = [
      "const chunk = Buffer.alloc(320);",
      "for (let i = 0; i < 160; i++) chunk.writeInt16LE(i % 2 ? 9000 : -9000, i * 2);",
      "const timer = setInterval(() => process.stdout.write(chunk), 5);",
      "process.on('SIGTERM', () => { clearInterval(timer); process.stdout.write(chunk, () => process.exit(0)); });",
    ].join("\n");
    const recording = await startXaiMicrophoneRecording({
      commands: [
        { program: "pi-xai-definitely-missing-recorder", args: [] },
        { program: process.execPath, args: ["-e", script] },
      ],
      startGraceMs: 150,
    });
    expect(recording.program).toBe(process.execPath);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pcm = await recording.stop();
    expect(pcm.length).toBeGreaterThanOrEqual(320);
    expect(pcm.length % 2).toBe(0);
    expect(Math.abs(pcm.readInt16LE(0))).toBe(9000);
  });
});
