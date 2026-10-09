import { describe, expect, it, vi } from "vitest";
import {
  buildXaiRealtimeSessionUpdate,
  connectXaiRealtime,
  xaiRealtimeUrl,
  type XaiRealtimeHandlers,
} from "../../extensions/xai/voice/realtime";
import { speechPcm } from "../fixtures/audio";
import { FakeSocket, startFakeWsServer } from "../fixtures/sockets";

const credential = { kind: "oauth-session" as const, token: "oauth-token" };

function handlers() {
  const events: Array<[string, ...unknown[]]> = [];
  const value: XaiRealtimeHandlers = {
    onAudio: (pcm, itemId) => events.push(["audio", pcm, itemId]),
    onAssistantText: (text, final) => events.push(["grok", text, final]),
    onUserText: (text, final, key) => events.push(["you", text, final, key]),
    onSpeechStarted: () => events.push(["speech"]),
    onResponseDone: () => events.push(["done"]),
    onWarning: (message) => events.push(["warning", message]),
    onClose: (reason) => events.push(["close", reason]),
  };
  return { events, value };
}

function open(options: { signal?: AbortSignal; connectTimeoutMs?: number; maxBufferedBytes?: number } = {}) {
  let socket!: FakeSocket;
  const h = handlers();
  const pending = connectXaiRealtime(
    { credential, voice: "ara", instructions: "Be brief.", signal: options.signal },
    h.value,
    {
      createSocket: (url, init) => {
        socket = new FakeSocket(url, init);
        return socket as any;
      },
      connectTimeoutMs: options.connectTimeoutMs ?? 1_000,
      maxBufferedBytes: options.maxBufferedBytes,
    },
  );
  return { pending, socket: () => socket, events: h.events };
}

async function ready(options: Parameters<typeof open>[0] = {}) {
  const opened = open(options);
  opened.socket().emit("open");
  opened.socket().message({ type: "session.updated" });
  return { conversation: await opened.pending, socket: opened.socket(), events: opened.events };
}

describe("xAI realtime voice chat", () => {
  it("connects to the pinned realtime route with the OAuth bearer and configures the session", async () => {
    expect(xaiRealtimeUrl(credential)).toBe("wss://api.x.ai/v1/realtime?model=grok-voice-latest");
    expect(xaiRealtimeUrl({ kind: "api-key", token: "key" }, "grok-voice-think-fast-1.0"))
      .toBe("wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-1.0");
    const { socket } = await ready();
    expect(socket.url).toBe("wss://api.x.ai/v1/realtime?model=grok-voice-latest");
    expect(socket.options.headers).toEqual({
      Authorization: "Bearer oauth-token",
      "User-Agent": expect.stringMatching(/^pi-xai-oauth\//),
      "x-grok-client-identifier": "pi-xai-oauth",
    });
    expect(socket.json()).toEqual([buildXaiRealtimeSessionUpdate("ara", "Be brief.")]);
    expect(buildXaiRealtimeSessionUpdate("eve", "x")).toEqual({
      type: "session.update",
      session: {
        instructions: "x",
        voice: "eve",
        output_modalities: ["audio"],
        turn_detection: { type: "server_vad", threshold: 0.85, prefix_padding_ms: 333, silence_duration_ms: 500 },
        audio: {
          input: { format: { type: "audio/pcm", rate: 24_000 }, transcription: { model: "grok-transcribe" } },
          output: { format: { type: "audio/pcm", rate: 24_000 } },
        },
      },
    });
  });

  it.each([
    ["an error event before ready", (socket: FakeSocket) => socket.message({ type: "error", error: { message: "secret detail" } }), /xAI refused the Grok voice chat session/],
    ["a socket error", (socket: FakeSocket) => socket.emit("error"), /could not connect/],
    ["a close", (socket: FakeSocket) => socket.emit("close"), /could not connect/],
  ])("rejects %s without reflecting xAI text", async (_name, trigger, message) => {
    const { pending, socket, events } = open();
    socket().emit("open");
    socket().message({ type: "session.created" });
    trigger(socket());
    const error = await pending.catch((caught) => caught);
    expect(error.message).toMatch(message);
    expect(error.message).not.toMatch(/secret/);
    expect(events).toEqual([]);
  });

  it("times out, cancels, and requires a WebSocket client", async () => {
    await expect(open({ connectTimeoutMs: 5 }).pending).rejects.toMatchObject({ code: "timeout" });
    const controller = new AbortController();
    const cancelled = open({ signal: controller.signal });
    controller.abort();
    await expect(cancelled.pending).rejects.toMatchObject({ code: "cancelled" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(connectXaiRealtime({ credential, voice: "eve", instructions: "", signal: aborted.signal }, handlers().value, {
      createSocket: () => {
        throw new Error("unused");
      },
    })).rejects.toMatchObject({ code: "cancelled" });
    await expect(connectXaiRealtime({ credential, voice: "eve", instructions: "" }, handlers().value, {
      createSocket: () => {
        throw new Error("bad url");
      },
    })).rejects.toMatchObject({ message: "Grok voice chat could not connect." });
    vi.stubGlobal("WebSocket", undefined);
    await expect(connectXaiRealtime({ credential, voice: "eve", instructions: "" }, handlers().value))
      .rejects.toMatchObject({ message: "This runtime has no WebSocket client for Grok voice chat." });
  });

  it("dispatches audio, captions, speech, and response lifecycle events", async () => {
    const { conversation, socket, events } = await ready();
    const pcm = speechPcm(4);
    socket.message({ type: "response.created" });
    expect(conversation.responseActive).toBe(true);
    socket.message({ type: "response.output_audio.delta", item_id: "item_1", delta: pcm.toString("base64") });
    socket.message({ type: "response.output_audio_transcript.delta", delta: "Hel" });
    socket.message({ type: "response.output_audio_transcript.delta", delta: "lo\u001b[2J" });
    socket.message({ type: "response.output_audio_transcript.done", transcript: "Hello." });
    socket.message({ type: "conversation.item.input_audio_transcription.delta", delta: "hi" });
    socket.message({ type: "conversation.item.input_audio_transcription.completed", transcript: "Hi there." });
    socket.message({ type: "input_audio_buffer.speech_started" });
    socket.message({ type: "response.output_text.delta", delta: "" });
    socket.message({ type: "something.else" });
    socket.emit("message", { data: new ArrayBuffer(2) });
    socket.message({ type: "response.done" });
    expect(conversation.responseActive).toBe(false);
    expect(events).toEqual([
      ["audio", pcm, "item_1"],
      ["grok", "Hel", false],
      ["grok", "lo[2J", false],
      ["grok", "Hello.", true],
      ["you", "hi", false, "speech-0"],
      ["you", "Hi there.", true, "speech-0"],
      ["speech"],
      ["done"],
    ]);
  });

  it("keys cumulative input snapshots by item, falling back to the speech turn", async () => {
    const { socket, events } = await ready();
    socket.message({ type: "input_audio_buffer.speech_started" });
    socket.message({ type: "conversation.item.input_audio_transcription.completed", transcript: "How" });
    socket.message({ type: "conversation.item.input_audio_transcription.completed", transcript: "How big is Earth?" });
    socket.message({ type: "input_audio_buffer.speech_started" });
    socket.message({ type: "conversation.item.input_audio_transcription.delta", item_id: "item_b", delta: "Ag" });
    socket.message({ type: "conversation.item.input_audio_transcription.updated", item_id: "item_b", transcript: "Again" });
    socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_b", transcript: "Again" });
    socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "x".repeat(300), transcript: "Long" });
    expect(events).toEqual([
      ["speech"],
      ["you", "How", true, "speech-1"],
      ["you", "How big is Earth?", true, "speech-1"],
      ["speech"],
      ["you", "Ag", false, "item_b"],
      ["you", "Again", true, "item_b"],
      ["you", "Again", true, "item_b"],
      ["you", "Long", true, "x".repeat(128)],
    ]);
  });

  it("delivers each reply's final caption once and drops output from finished or cancelled responses", async () => {
    const { conversation, socket, events } = await ready();
    const pcm = speechPcm(2);
    socket.message({ type: "response.created" });
    socket.message({ type: "response.output_audio_transcript.delta", delta: "Hi" });
    socket.message({ type: "response.output_audio_transcript.done", transcript: "Hi." });
    socket.message({ type: "response.output_text.done", text: "Hi." });
    socket.message({ type: "response.done" });
    socket.message({ type: "response.output_audio.delta", item_id: "late", delta: pcm.toString("base64") });
    socket.message({ type: "response.output_audio_transcript.done", transcript: "late" });
    socket.message({ type: "response.done" });
    socket.message({ type: "input_audio_buffer.speech_started" });
    socket.message({ type: "response.created" });
    expect(conversation.responseActive).toBe(true);
    socket.message({ type: "response.output_audio.delta", item_id: "b", delta: pcm.toString("base64") });
    socket.message({ type: "response.output_audio_transcript.done", transcript: "Sure." });
    conversation.cancelResponse();
    socket.message({ type: "response.output_audio.delta", item_id: "b", delta: pcm.toString("base64") });
    socket.message({ type: "response.done" });
    expect(events).toEqual([
      ["grok", "Hi", false],
      ["grok", "Hi.", true],
      ["done"],
      ["speech"],
      ["audio", pcm, "b"],
      ["grok", "Sure.", true],
    ]);

    // Without response.created announcements nothing is fenced.
    const unannounced = await ready();
    unannounced.socket.message({ type: "response.output_audio.delta", item_id: "c", delta: pcm.toString("base64") });
    unannounced.socket.message({ type: "response.done" });
    unannounced.socket.message({ type: "response.output_audio.delta", item_id: "d", delta: pcm.toString("base64") });
    unannounced.socket.message({ type: "response.output_audio_transcript.done", transcript: "First." });
    unannounced.socket.message({ type: "response.output_audio_transcript.done", transcript: "First." });
    unannounced.socket.message({ type: "response.done" });
    unannounced.socket.message({ type: "response.output_audio_transcript.done", transcript: "Second." });
    expect(unannounced.events).toEqual([
      ["audio", pcm, "c"],
      ["done"],
      ["audio", pcm, "d"],
      ["grok", "First.", true],
      ["done"],
      ["grok", "Second.", true],
    ]);
  });

  it("ignores racing cancel errors but warns about others without reflecting detail", async () => {
    const { socket, events } = await ready();
    socket.message({ type: "error", error: { message: "Cancellation failed: no active response found" } });
    socket.message({ type: "error", error: { message: "secret upstream detail" } });
    expect(events).toEqual([["warning", "xAI reported a Grok voice chat error."]]);
  });

  it.each([
    ["invalid audio", (socket: FakeSocket) => socket.message({ type: "response.output_audio.delta", delta: "not*base64" }), "Grok voice chat received invalid audio."],
    ["oversized audio", (socket: FakeSocket) => socket.message({ type: "response.output_audio.delta", delta: Buffer.alloc(1024 * 1024 + 3).toString("base64") }), "Grok voice chat received invalid audio."],
    ["invalid JSON", (socket: FakeSocket) => socket.message("{"), "Grok voice chat received an invalid message."],
    ["an oversized message", (socket: FakeSocket) => socket.message("x".repeat(2 * 1024 * 1024 + 1)), "Grok voice chat received an oversized message."],
    ["a socket error", (socket: FakeSocket) => socket.emit("error"), "The Grok voice chat connection failed."],
    ["a server close", (socket: FakeSocket) => socket.emit("close"), undefined],
  ])("ends the conversation on %s", async (_name, trigger, reason) => {
    const { socket, events } = await ready();
    trigger(socket);
    socket.emit("close");
    expect(events).toEqual([["close", reason]]);
  });

  it("streams frame-aligned base64 audio, cancels, truncates, and closes quietly", async () => {
    const { conversation, socket, events } = await ready();
    socket.sent = [];
    conversation.appendAudio(Buffer.from([1, 2, 3]));
    conversation.appendAudio(Buffer.from([4]));
    conversation.appendAudio(Buffer.alloc(0));
    conversation.cancelResponse();
    socket.message({ type: "response.created" });
    conversation.cancelResponse();
    conversation.cancelResponse();
    conversation.truncate("item_1", 1234.9);
    expect(socket.json()).toEqual([
      { type: "input_audio_buffer.append", audio: Buffer.from([1, 2]).toString("base64") },
      { type: "input_audio_buffer.append", audio: Buffer.from([3, 4]).toString("base64") },
      { type: "response.cancel" },
      { type: "conversation.item.truncate", item_id: "item_1", content_index: 0, audio_end_ms: 1234 },
    ]);
    conversation.close();
    socket.emit("close");
    conversation.appendAudio(speechPcm(2));
    expect(socket.closes).toEqual([1000]);
    expect(events).toEqual([]);
  });

  it("ends a stalled or failing connection", async () => {
    const stalled = await ready({ maxBufferedBytes: 10 });
    stalled.socket.bufferedAmount = 11;
    stalled.conversation.appendAudio(speechPcm(2));
    expect(stalled.events).toEqual([["close", "The Grok voice chat connection stalled."]]);

    const throwing = await ready();
    throwing.socket.throwOnSend = true;
    throwing.conversation.appendAudio(speechPcm(2));
    expect(throwing.events).toEqual([["close", "The Grok voice chat connection failed."]]);
  });

  it("talks to a WebSocket server through Node's built-in client with the bearer on the handshake", async () => {
    const received: { authorization?: string; types: string[]; audioBytes: number } = { types: [], audioBytes: 0 };
    const reply = speechPcm(240);
    const server = await startFakeWsServer((connection, onFrame) => {
      received.authorization = connection.request.headers.authorization;
      onFrame((opcode, payload) => {
        if (opcode !== 0x1) return;
        const event = JSON.parse(payload.toString("utf8"));
        received.types.push(event.type);
        if (event.type === "session.update") connection.sendText(JSON.stringify({ type: "session.updated" }));
        if (event.type === "input_audio_buffer.append") {
          received.audioBytes += Buffer.from(event.audio, "base64").length;
          connection.sendText(JSON.stringify({ type: "response.created" }));
          connection.sendText(JSON.stringify({ type: "response.output_audio.delta", item_id: "a1", delta: reply.toString("base64") }));
          connection.sendText(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "Hi!" }));
          connection.sendText(JSON.stringify({ type: "response.done" }));
        }
      });
    });
    const h = handlers();
    try {
      const conversation = await connectXaiRealtime({ credential, voice: "eve", instructions: "hi" }, h.value, {
        createSocket: (url, options) => {
          const target = new URL(url);
          return new (globalThis as any).WebSocket(`ws://127.0.0.1:${server.port}${target.pathname}${target.search}`, options);
        },
        connectTimeoutMs: 5_000,
      });
      conversation.appendAudio(speechPcm(100));
      await vi.waitFor(() => expect(h.events.map(([type]) => type)).toContain("done"));
      expect(received.authorization).toBe("Bearer oauth-token");
      expect(received.types).toEqual(["session.update", "input_audio_buffer.append"]);
      expect(received.audioBytes).toBe(200);
      expect(h.events).toEqual([["audio", reply, "a1"], ["grok", "Hi!", true], ["done"]]);
      conversation.close();
    } finally {
      await server.close();
    }
  });
});
