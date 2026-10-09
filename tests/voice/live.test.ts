import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectXaiLiveTranscription,
  mergeXaiLiveTranscript,
  xaiLiveTranscriptionUrl,
  type XaiLiveSocketFactory,
} from "../../extensions/xai/voice/live";
import { speechPcm } from "../fixtures/audio";

const credential = { kind: "oauth-session" as const, token: "oauth-token" };

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "blob";
  sent: Array<string | Uint8Array> = [];
  closes: Array<number | undefined> = [];
  throwOnSend = false;
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  constructor(readonly url: string, readonly options: { headers: Record<string, string> }) {}

  addEventListener(type: string, listener: (event: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  emit(type: string, event: any = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  message(value: unknown) {
    this.emit("message", { data: typeof value === "string" ? value : JSON.stringify(value) });
  }

  send(data: string | Uint8Array) {
    if (this.throwOnSend) throw new Error("socket closed with secret oauth-token");
    this.sent.push(data);
  }

  close(code?: number) {
    this.closes.push(code);
  }

  audio(): Buffer {
    return Buffer.concat(this.sent.filter((item): item is Uint8Array => typeof item !== "string"));
  }

  texts(): string[] {
    return this.sent.filter((item): item is string => typeof item === "string");
  }
}

function open(options: {
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  finishTimeoutMs?: number;
  maxBufferedBytes?: number;
} = {}) {
  let socket!: FakeSocket;
  const factory: XaiLiveSocketFactory = (url, init) => {
    socket = new FakeSocket(url, init);
    return socket as any;
  };
  const pending = connectXaiLiveTranscription(
    { credential, language: "en", signal: options.signal },
    {
      createSocket: factory,
      connectTimeoutMs: options.connectTimeoutMs ?? 1_000,
      finishTimeoutMs: options.finishTimeoutMs ?? 1_000,
      maxBufferedBytes: options.maxBufferedBytes,
    },
  );
  return { pending, socket: () => socket };
}

async function ready(options: Parameters<typeof open>[0] = {}) {
  const { pending, socket } = open(options);
  socket().message({ type: "transcript.created" });
  return { live: await pending, socket: socket() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("xAI live speech to text", () => {
  it("connects to the pinned socket with Grok Build's query and the OAuth bearer", async () => {
    expect(xaiLiveTranscriptionUrl(credential, "ja")).toBe(
      "wss://api.x.ai/v1/stt?sample_rate=16000&encoding=pcm&interim_results=true&language=ja&endpointing=400",
    );
    expect(xaiLiveTranscriptionUrl({ kind: "api-key", token: "key" }, "en", 24_000)).toMatch(
      /^wss:\/\/api\.x\.ai\/v1\/stt\?sample_rate=24000&/,
    );
    const { socket } = await ready();
    expect(socket.url).toBe(
      "wss://api.x.ai/v1/stt?sample_rate=16000&encoding=pcm&interim_results=true&language=en&endpointing=400",
    );
    expect(socket.options.headers).toEqual({
      Authorization: "Bearer oauth-token",
      "User-Agent": expect.stringMatching(/^pi-xai-oauth\//),
      "x-grok-client-identifier": "pi-xai-oauth",
    });
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it.each([
    ["an error event", (socket: FakeSocket) => socket.emit("error"), "network_failure", [1000]],
    ["a close before ready", (socket: FakeSocket) => socket.emit("close"), "network_failure", []],
    ["a server error message", (socket: FakeSocket) => socket.message({ type: "error", message: "secret detail" }), "http_failure", [1000]],
  ])("rejects %s before transcript.created", async (_name, trigger, code, closes) => {
    const { pending, socket } = open();
    trigger(socket());
    const error = await pending.catch((caught) => caught);
    expect(error).toMatchObject({ code });
    expect(error.message).not.toMatch(/secret/);
    // An already-closed socket is not closed again.
    expect(socket().closes).toEqual(closes);
  });

  it("times out, honors cancellation, and requires a WebSocket client", async () => {
    await expect(open({ connectTimeoutMs: 5 }).pending).rejects.toMatchObject({ code: "timeout" });

    const controller = new AbortController();
    const cancelled = open({ signal: controller.signal });
    controller.abort();
    await expect(cancelled.pending).rejects.toMatchObject({ code: "cancelled" });

    const aborted = new AbortController();
    aborted.abort();
    await expect(connectXaiLiveTranscription({ credential, language: "en", signal: aborted.signal }, {
      createSocket: () => {
        throw new Error("unused");
      },
    })).rejects.toMatchObject({ code: "cancelled" });

    await expect(connectXaiLiveTranscription({ credential, language: "en" }, {
      createSocket: () => {
        throw new Error("bad url");
      },
    })).rejects.toMatchObject({ code: "network_failure", message: "xAI live transcription could not connect." });

    vi.stubGlobal("WebSocket", undefined);
    await expect(connectXaiLiveTranscription({ credential, language: "en" }))
      .rejects.toMatchObject({ message: "This runtime has no WebSocket client for live transcription." });
  });

  it("streams frame-aligned PCM and assembles interim, locked, and final text", async () => {
    const { live, socket } = await ready();
    live.send(Buffer.from([1, 2, 3]));
    live.send(Buffer.from([4]));
    live.send(Buffer.alloc(0));
    live.send(Buffer.from([5]));
    expect(socket.audio()).toEqual(Buffer.from([1, 2, 3, 4]));

    socket.message({ type: "transcript.partial", text: "hel", is_final: false, speech_final: false });
    expect(live.preview()).toBe("hel");
    socket.message({ type: "transcript.partial", text: "hello there", is_final: true, speech_final: false });
    socket.message({ type: "transcript.partial", text: "gen\u001b[2Jeral", is_final: false });
    expect(live.preview()).toBe("hello there gen [2Jeral");
    socket.message({ type: "transcript.partial", text: "Hello there, General Kenobi.", is_final: true, speech_final: true });
    socket.message({ type: "transcript.partial", text: "   " });
    socket.message({ type: "unknown.event" });
    socket.emit("message", { data: new ArrayBuffer(4) });
    expect(live.preview()).toBe("Hello there, General Kenobi.");
    socket.message({ type: "transcript.partial", text: "next", is_final: false });
    expect(live.preview()).toBe("Hello there, General Kenobi. next");
    expect(live.failure()).toBeUndefined();
  });

  it("sends audio.done and merges the final transcript", async () => {
    const { live, socket } = await ready();
    socket.message({ type: "transcript.partial", text: "First thought.", is_final: true, speech_final: true });
    const finishing = live.finish();
    expect(socket.texts()).toEqual(['{"type":"audio.done"}']);
    live.send(speechPcm(2));
    expect(socket.audio()).toHaveLength(0);
    socket.message({ type: "transcript.done", text: "Second thought.", duration: 2 });
    await expect(finishing).resolves.toBe("First thought. Second thought.");
    expect(socket.closes).toContain(1000);
  });

  it("returns committed text when the server closes after audio.done", async () => {
    const { live, socket } = await ready();
    socket.message({ type: "transcript.partial", text: "only this", is_final: true, speech_final: false });
    const finishing = live.finish();
    socket.emit("close");
    await expect(finishing).resolves.toBe("only this");
  });

  it("uses an earlier done without waiting, and times out to an error when nothing arrived", async () => {
    const early = await ready();
    early.socket.message({ type: "transcript.done", text: "already done" });
    await expect(early.live.finish()).resolves.toBe("already done");
    expect(early.socket.texts()).toEqual([]);

    const silent = await ready({ finishTimeoutMs: 5 });
    await expect(silent.live.finish()).rejects.toMatchObject({ code: "timeout" });

    const empty = await ready();
    const finishing = empty.live.finish();
    empty.socket.message({ type: "transcript.done", text: "" });
    await expect(finishing).resolves.toBe("");
  });

  it.each([
    ["a server error", (socket: FakeSocket) => socket.message({ type: "error", message: "secret" }), "xAI live transcription reported an error."],
    ["an unexpected close", (socket: FakeSocket) => socket.emit("close"), "The xAI live transcription connection closed."],
    ["a socket error", (socket: FakeSocket) => socket.emit("error"), "The xAI live transcription connection failed."],
    ["invalid JSON", (socket: FakeSocket) => socket.message("{"), "xAI live transcription sent an invalid message."],
    ["an oversized message", (socket: FakeSocket) => socket.message("x".repeat(64 * 1024 + 1)), "xAI live transcription sent an oversized message."],
  ])("fails the stream on %s so the caller can upload the clip", async (_name, trigger, message) => {
    const { live, socket } = await ready();
    socket.message({ type: "transcript.partial", text: "partial words", is_final: true, speech_final: true });
    trigger(socket);
    expect(live.failure()).toBe(message);
    live.send(speechPcm(2));
    expect(socket.audio()).toHaveLength(0);
    await expect(live.finish()).rejects.toMatchObject({ code: "network_failure", message });
  });

  it("fails on a server error during finish instead of returning partial text", async () => {
    const { live, socket } = await ready();
    socket.message({ type: "transcript.partial", text: "partial", is_final: true, speech_final: true });
    const finishing = live.finish();
    socket.message({ type: "error", message: "late failure" });
    await expect(finishing).rejects.toMatchObject({ code: "network_failure" });
  });

  it("fails when sends throw or the socket stalls", async () => {
    const throwing = await ready();
    throwing.socket.throwOnSend = true;
    throwing.live.send(speechPcm(2));
    expect(throwing.live.failure()).toBe("The xAI live transcription connection failed.");

    const stalled = await ready({ maxBufferedBytes: 10 });
    stalled.socket.bufferedAmount = 11;
    stalled.live.send(speechPcm(2));
    expect(stalled.live.failure()).toBe("The xAI live transcription connection stalled.");
    expect(stalled.socket.audio()).toHaveLength(0);

    const finishThrows = await ready();
    finishThrows.socket.throwOnSend = true;
    await expect(finishThrows.live.finish()).rejects.toMatchObject({ code: "network_failure" });
  });

  it("cancels a pending finish", async () => {
    const { live } = await ready();
    const controller = new AbortController();
    const finishing = live.finish(controller.signal);
    controller.abort();
    await expect(finishing).rejects.toMatchObject({ code: "cancelled" });
  });

  it("merges done text without duplicating or dropping utterances", () => {
    expect(mergeXaiLiveTranscript([], "", "")).toBe("");
    expect(mergeXaiLiveTranscript(["One."], "two", "")).toBe("One. two");
    expect(mergeXaiLiveTranscript([], "pending", "Done text.")).toBe("Done text.");
    expect(mergeXaiLiveTranscript(["One.", "Two."], "", "One. Two. Three.")).toBe("One. Two. Three.");
    expect(mergeXaiLiveTranscript(["One.", "Two."], "", "two")).toBe("One. Two.");
    expect(mergeXaiLiveTranscript(["One."], "", "Two.")).toBe("One. Two.");
  });

  it("streams through Node's built-in WebSocket with the bearer on the handshake", async () => {
    const received: { headers?: IncomingMessage["headers"]; audioBytes: number; texts: string[] } = {
      audioBytes: 0,
      texts: [],
    };
    const sockets: Socket[] = [];
    const server = createServer();
    server.on("upgrade", (request, socket: Socket) => {
      sockets.push(socket);
      received.headers = request.headers;
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const sendText = (text: string) => {
        const payload = Buffer.from(text);
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      };
      sendText(JSON.stringify({ type: "transcript.created" }));
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const opcode = buffer[0]! & 0x0f;
          let length = buffer[1]! & 0x7f;
          let offset = 2;
          if (length === 126) {
            length = buffer.readUInt16BE(2);
            offset = 4;
          } else if (length === 127) {
            length = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }
          if (buffer.length < offset + 4 + length) return;
          const mask = buffer.subarray(offset, offset + 4);
          const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
          for (let index = 0; index < payload.length; index += 1) payload[index]! ^= mask[index % 4]!;
          buffer = buffer.subarray(offset + 4 + length);
          if (opcode === 0x2) received.audioBytes += payload.length;
          if (opcode === 0x1) {
            received.texts.push(payload.toString("utf8"));
            sendText(JSON.stringify({ type: "transcript.partial", text: "Hello world.", is_final: true, speech_final: true }));
            sendText(JSON.stringify({ type: "transcript.done", text: "Hello world." }));
          }
          if (opcode === 0x8) socket.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const live = await connectXaiLiveTranscription({ credential, language: "en" }, {
        createSocket: (url, options) => {
          expect(url.startsWith("wss://api.x.ai/v1/stt?")).toBe(true);
          return new (globalThis as any).WebSocket(`ws://127.0.0.1:${port}${new URL(url).pathname}${new URL(url).search}`, options);
        },
        connectTimeoutMs: 5_000,
        finishTimeoutMs: 5_000,
      });
      live.send(speechPcm(800));
      await expect(live.finish()).resolves.toBe("Hello world.");
      expect(received.headers?.authorization).toBe("Bearer oauth-token");
      expect(received.headers?.["x-grok-client-identifier"]).toBe("pi-xai-oauth");
      expect(received.audioBytes).toBe(1_600);
      expect(received.texts).toEqual(['{"type":"audio.done"}']);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
