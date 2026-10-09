import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startXaiAudioPlayer,
  xaiPlayerCommands,
  xaiPlayerInstallHint,
} from "../../extensions/xai/voice/player";
import { XaiRecorderUnavailableError } from "../../extensions/xai/voice/recorder";
import { createTempDir } from "../fixtures/temp";

class FakePlayer extends EventEmitter {
  stdin = new PassThrough();
  stderr = new PassThrough();
  written: Buffer[] = [];
  kills: string[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.written.push(chunk));
  }

  kill(signal = "SIGTERM") {
    this.kills.push(signal);
    setImmediate(() => this.emit("close", null, signal));
    return true;
  }
}

function fakeSpawn(behaviors: Record<string, ((child: FakePlayer) => void) | "throw">) {
  const spawned: Array<{ program: string; args: string[]; options: any; child: FakePlayer }> = [];
  const spawn = vi.fn((program: string, args: string[], options: any) => {
    const behavior = behaviors[program];
    if (behavior === "throw") throw new Error("spawn EACCES");
    const child = new FakePlayer();
    spawned.push({ program, args, options, child });
    setImmediate(() => (behavior as any)?.(child));
    return child as any;
  });
  return { spawn: spawn as any, spawned };
}

const commands = [
  { program: "first", args: ["-a"] },
  { program: "second", args: ["-b"] },
];

let temp: Awaited<ReturnType<typeof createTempDir>>;
beforeEach(async () => {
  temp = await createTempDir("pi-xai-player-");
});
afterEach(async () => {
  await temp.cleanup();
});

describe("Grok voice audio player", () => {
  it("plays raw 24 kHz PCM through the same per-platform walk as the recorder", () => {
    expect(xaiPlayerCommands("linux")).toEqual([
      { program: "pw-play", args: ["--raw", "--rate", "24000", "--channels", "1", "--format", "s16", "-"] },
      { program: "pacat", args: ["--playback", "--format=s16le", "--rate=24000", "--channels=1"] },
      { program: "aplay", args: ["-q", "-t", "raw", "-f", "S16_LE", "-c", "1", "-r", "24000", "-"] },
      { program: "sox", args: ["-q", "-t", "raw", "-r", "24000", "-e", "signed-integer", "-b", "16", "-c", "1", "-L", "-", "-d"] },
    ]);
    expect(xaiPlayerCommands("darwin").map(({ program }) => program)).toEqual(["sox", "ffplay"]);
    expect(xaiPlayerCommands("darwin", 16_000)[1]!.args).toEqual(expect.arrayContaining(["-f", "s16le", "-sample_rate", "16000", "-ch_layout", "mono", "-i", "-"]));
    expect(xaiPlayerCommands("win32").map(({ program }) => program)).toEqual(["sox"]);
    expect(xaiPlayerInstallHint("linux")).toMatch(/pw-play.*pacat.*aplay.*sox/);
    expect(xaiPlayerInstallHint("darwin")).toMatch(/brew install sox/);
    expect(xaiPlayerInstallHint("freebsd")).toMatch(/SoX/);
  });

  it("falls through failed players, writes PCM, restarts after stop, and closes", async () => {
    const { spawn, spawned } = fakeSpawn({
      first: (child) => {
        child.stderr.write("no default sink\n");
        child.emit("exit", 1, null);
      },
      second: () => undefined,
    });
    const player = await startXaiAudioPlayer({ spawn, commands, startGraceMs: 10 });
    expect(player.program).toBe("second");
    expect(spawned[0]!.options).toMatchObject({ stdio: ["pipe", "ignore", "pipe"], shell: false, windowsHide: true });
    player.write(Buffer.from([1, 2]));
    player.write(Buffer.alloc(0));
    await new Promise((resolve) => setImmediate(resolve));
    expect(Buffer.concat(spawned[1]!.child.written)).toEqual(Buffer.from([1, 2]));

    player.stop();
    expect(spawned[1]!.child.kills).toEqual(["SIGKILL"]);
    player.write(Buffer.from([3, 4]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawned).toHaveLength(3);
    expect(spawned[2]!.program).toBe("second");
    expect(Buffer.concat(spawned[2]!.child.written)).toEqual(Buffer.from([3, 4]));

    player.close();
    player.close();
    expect(spawned[2]!.child.kills).toEqual(["SIGKILL"]);
    player.write(Buffer.from([5, 6]));
    expect(spawned).toHaveLength(3);
  });

  it("restarts a player that exited on its own", async () => {
    const { spawn, spawned } = fakeSpawn({ first: () => undefined });
    const player = await startXaiAudioPlayer({ spawn, commands: [commands[0]!], startGraceMs: 5 });
    spawned[0]!.child.emit("close", 0, null);
    player.write(Buffer.from([7, 8]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawned).toHaveLength(2);
    player.close();
  });

  it("explains missing players and joins start failures", async () => {
    const enoent = (child: FakePlayer) => child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const missing = await startXaiAudioPlayer({ spawn: fakeSpawn({ first: enoent, second: enoent }).spawn, commands, platform: "darwin", startGraceMs: 5 })
      .catch((caught) => caught);
    expect(missing).toBeInstanceOf(XaiRecorderUnavailableError);
    expect(missing.message).toBe("No audio player was found. Install SoX (brew install sox) or FFmpeg (brew install ffmpeg).");

    const failing = await startXaiAudioPlayer({
      spawn: fakeSpawn({ first: "throw", second: (child) => child.emit("error", new Error("EACCES")) }).spawn,
      commands,
      startGraceMs: 5,
    }).catch((caught) => caught);
    expect(failing.message).toBe("Could not start an audio player: first failed to start; second failed to start");
  });

  it("feeds a real player subprocess through stdin", async () => {
    const output = join(temp.path, "played.raw");
    const script = `const fs=require('fs');const out=fs.createWriteStream(${JSON.stringify(output)});process.stdin.pipe(out);`;
    const player = await startXaiAudioPlayer({
      commands: [
        { program: "pi-xai-definitely-missing-player", args: [] },
        { program: process.execPath, args: ["-e", script] },
      ],
      startGraceMs: 150,
    });
    player.write(Buffer.from([1, 2, 3, 4]));
    await vi.waitFor(async () => expect(await readFile(output)).toEqual(Buffer.from([1, 2, 3, 4])));
    player.close();
  });
});
