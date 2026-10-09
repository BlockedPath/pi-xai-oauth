import { describe, expect, it, vi } from "vitest";
import { XaiVoiceOperationError } from "../../extensions/xai/voice/common";
import { XaiRecorderUnavailableError, type XaiRecordingEnd } from "../../extensions/xai/voice/recorder";
import type { XaiRealtimeHandlers } from "../../extensions/xai/voice/realtime";
import {
  registerXaiTalk,
  renderXaiTalk,
  XaiTalkSession,
  xaiTalkInstructions,
  xaiTalkSessionContext,
} from "../../extensions/xai/voice/talk";
import { speechPcm } from "../fixtures/audio";
import { createExtensionHarness } from "../fixtures/extension-api";

const credential = { kind: "oauth-session" as const, token: "oauth-token" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeConversation() {
  let active = false;
  return {
    appended: [] as Buffer[],
    get responseActive() {
      return active;
    },
    setActive(value: boolean) {
      active = value;
    },
    appendAudio: vi.fn(function (this: any, pcm: Buffer) {
      this.appended.push(pcm);
    }),
    cancelResponse: vi.fn(() => {
      active = false;
    }),
    truncate: vi.fn(),
    close: vi.fn(),
  };
}

function fakeRecording() {
  const ended = deferred<XaiRecordingEnd>();
  const listeners = new Set<(chunk: Buffer) => void>();
  return {
    program: "fake-recorder",
    ended: ended.promise,
    end: ended.resolve,
    emit: (chunk: Buffer) => listeners.forEach((listener) => listener(chunk)),
    bytesCaptured: () => 0,
    level: () => 0.4,
    snapshot: () => Buffer.alloc(0),
    subscribe: vi.fn((listener: (chunk: Buffer) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    stop: vi.fn(async () => Buffer.alloc(0)),
    cancel: vi.fn(),
  };
}

function fakePlayer() {
  return { program: "fake-player", written: [] as Buffer[], write: vi.fn(function (this: any, pcm: Buffer) {
    this.written.push(pcm);
  }), stop: vi.fn(), close: vi.fn() };
}

function makeSession(options: { duplex?: boolean; connect?: () => Promise<any>; startPlayer?: () => Promise<any>; startRecording?: () => Promise<any> } = {}) {
  let clock = 10_000;
  let handlers!: XaiRealtimeHandlers;
  const conversation = fakeConversation();
  const recording = fakeRecording();
  const player = fakePlayer();
  const session = new XaiTalkSession({
    voice: "rex",
    duplex: options.duplex ?? false,
    withContext: false,
    now: () => clock,
    connect: async (value) => {
      handlers = value;
      return options.connect ? options.connect() : conversation;
    },
    startPlayer: options.startPlayer ?? (async () => player),
    startRecording: options.startRecording ?? (async () => recording),
  });
  return {
    session,
    conversation,
    recording,
    player,
    handlers: () => handlers,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("Grok voice chat session", () => {
  it("connects first, then opens the player and microphone, and streams the microphone", async () => {
    const order: string[] = [];
    const conversation = fakeConversation();
    const recording = fakeRecording();
    const session = new XaiTalkSession({
      voice: "eve",
      duplex: false,
      withContext: false,
      connect: async () => {
        order.push("connect");
        return conversation;
      },
      startPlayer: async () => {
        order.push("player");
        return fakePlayer();
      },
      startRecording: async () => {
        order.push("microphone");
        return recording;
      },
    });
    expect(renderXaiTalk(session, 200)[0]).toBe("Grok voice chat (eve) — Connecting…");
    await session.start();
    expect(order).toEqual(["connect", "player", "microphone"]);
    expect(session.state).toBe("live");
    recording.emit(speechPcm(10));
    expect(conversation.appended).toEqual([speechPcm(10)]);
    session.end(false);
  });

  it("plays Grok's audio and mutes the microphone while Grok could still be heard (half-duplex)", async () => {
    const env = makeSession();
    await env.session.start();
    env.handlers().onAudio(Buffer.alloc(48_000), "item_1");
    expect(env.player.written).toHaveLength(1);
    expect(env.session.speaking).toBe(true);
    env.recording.emit(speechPcm(10));
    env.advance(1_000);
    env.recording.emit(speechPcm(10));
    env.advance(599);
    env.recording.emit(speechPcm(10));
    expect(env.conversation.appended).toHaveLength(0);
    env.advance(1);
    env.recording.emit(speechPcm(10));
    expect(env.conversation.appended).toHaveLength(1);
    expect(env.session.speaking).toBe(false);
    env.session.end(false);
  });

  it("does not let speech interrupt Grok in half-duplex mode", async () => {
    const env = makeSession();
    await env.session.start();
    env.conversation.setActive(true);
    env.handlers().onAudio(Buffer.alloc(4_800), "item_1");
    env.handlers().onSpeechStarted();
    expect(env.player.stop).not.toHaveBeenCalled();
    expect(env.conversation.cancelResponse).not.toHaveBeenCalled();
    env.session.end(false);
  });

  it("interrupts Grok on barge-in in duplex mode and trims history to what was heard", async () => {
    const env = makeSession({ duplex: true });
    await env.session.start();
    env.conversation.setActive(true);
    env.handlers().onAudio(Buffer.alloc(48_000), "item_1");
    env.handlers().onAudio(Buffer.alloc(48_000), "item_1");
    env.handlers().onAssistantText("A long answer", false);
    env.recording.emit(speechPcm(4));
    expect(env.conversation.appended).toHaveLength(1);
    env.advance(250);
    env.handlers().onSpeechStarted();
    expect(env.player.stop).toHaveBeenCalledTimes(1);
    expect(env.conversation.cancelResponse).toHaveBeenCalledTimes(1);
    expect(env.conversation.truncate).toHaveBeenCalledWith("item_1", 250);
    expect(env.session.speaking).toBe(false);
    expect(env.session.lines).toEqual([
      { role: "grok", text: "A long answer", final: true },
      { role: "you", text: "", final: false },
    ]);
    env.session.end(false);
  });

  it("lets Space interrupt only while Grok is speaking or generating", async () => {
    const env = makeSession();
    await env.session.start();
    env.session.interrupt();
    expect(env.player.stop).not.toHaveBeenCalled();
    // 9,600 bytes is 200 ms of 24 kHz PCM16; interrupt halfway through.
    env.handlers().onAudio(Buffer.alloc(9_600), "item_2");
    env.advance(100);
    env.session.interrupt();
    expect(env.conversation.truncate).toHaveBeenCalledWith("item_2", 100);
    env.conversation.setActive(true);
    env.session.interrupt();
    expect(env.conversation.cancelResponse).toHaveBeenCalledTimes(2);
    expect(env.conversation.truncate).toHaveBeenCalledTimes(1);
    env.session.end(false);
  });

  it("assembles captions in order and formats a bounded transcript", async () => {
    const env = makeSession();
    await env.session.start();
    const h = env.handlers();
    h.onSpeechStarted();
    h.onSpeechStarted();
    h.onUserText("what does", false);
    h.onAssistantText("It ", false);
    h.onUserText("What does the parser do?", true);
    h.onAssistantText("parses", false);
    h.onAssistantText("It parses tokens.", true);
    h.onResponseDone();
    h.onUserText("Thanks", true);
    h.onAssistantText("Anytime.", false);
    h.onResponseDone();
    expect(env.session.lines).toEqual([
      { role: "you", text: "What does the parser do?", final: true },
      { role: "grok", text: "It parses tokens.", final: true },
      { role: "you", text: "Thanks", final: true },
      { role: "grok", text: "Anytime.", final: true },
    ]);
    expect(env.session.transcript()).toBe(
      "Voice chat with Grok:\nYou: What does the parser do?\nGrok: It parses tokens.\nYou: Thanks\nGrok: Anytime.",
    );
    env.advance(65_000);
    h.onWarning("xAI reported a Grok voice chat error.");
    expect(renderXaiTalk(env.session, 200)).toEqual([
      "Grok voice chat (rex) — ● 1:05 ▄ · Listening · xAI reported a Grok voice chat error.",
      "  Grok: It parses tokens.",
      "  You: Thanks",
      "  Grok: Anytime.",
      "  Space: interrupt · Enter: end and insert transcript · Esc: end",
    ]);
    expect(renderXaiTalk(env.session, 20)[1]).toBe("  Grok: …s tokens.");
    for (let index = 0; index < 250; index += 1) h.onUserText(`line ${index}`, true);
    expect(env.session.lines).toHaveLength(200);
    h.onAssistantText("x".repeat(5_000), true);
    expect(env.session.lines.at(-1)!.text).toHaveLength(4_000);
    expect(env.session.transcript().length).toBeLessThanOrEqual(20_000 + "Voice chat with Grok:\n".length);
    env.session.end(false);
  });

  it("keeps one caption per utterance when xAI resends cumulative transcript snapshots", async () => {
    const env = makeSession();
    await env.session.start();
    const h = env.handlers();
    h.onSpeechStarted();
    h.onUserText("How", true, "speech-1");
    h.onAssistantText("Earth is", false);
    h.onUserText("How big is Earth?", true, "speech-1");
    h.onAssistantText("Earth is about 12,742 km across.", true);
    h.onResponseDone();
    h.onUserText("How big is Earth?", true, "speech-1");
    h.onSpeechStarted();
    h.onUserText("Ag", false, "item_b");
    h.onUserText("ain", false, "item_b");
    h.onUserText("Again", true, "item_b");
    h.onAssistantText("Sure.", true);
    h.onResponseDone();
    h.onSpeechStarted();
    h.onUserText("Again", true, "item_c");
    h.onUserText("How big is Earth, really?", true, "speech-1");
    expect(env.session.lines).toEqual([
      { role: "you", text: "How big is Earth, really?", final: true, key: "speech-1" },
      { role: "grok", text: "Earth is about 12,742 km across.", final: true },
      { role: "you", text: "Again", final: true, key: "item_b" },
      { role: "grok", text: "Sure.", final: true },
      { role: "you", text: "Again", final: true, key: "item_c" },
    ]);
    expect(env.session.transcript()).toBe(
      "Voice chat with Grok:\nYou: How big is Earth, really?\nGrok: Earth is about 12,742 km across.\n"
        + "You: Again\nGrok: Sure.\nYou: Again",
    );
    // Captions without an earlier placeholder start their own line.
    h.onUserText("Late", true, "item_d");
    expect(env.session.lines.at(-1)).toEqual({ role: "you", text: "Late", final: true, key: "item_d" });
    env.session.end(false);
  });

  it("ends once with duration, transcript, and reason, releasing every resource", async () => {
    const env = makeSession();
    await env.session.start();
    env.advance(3_000);
    env.handlers().onUserText("bye", true);
    env.session.end(true, "reason");
    env.session.end(false);
    env.session.fail("ignored");
    await expect(env.session.outcome).resolves.toEqual({
      kind: "ended",
      durationMs: 3_000,
      transcript: "Voice chat with Grok:\nYou: bye",
      insert: true,
      reason: "reason",
    });
    expect(env.recording.cancel).toHaveBeenCalledTimes(1);
    expect(env.player.close).toHaveBeenCalledTimes(1);
    expect(env.conversation.close).toHaveBeenCalledTimes(1);
    env.recording.emit(speechPcm(2));
    env.handlers().onAudio(speechPcm(2), "late");
    expect(env.conversation.appended).toHaveLength(0);
    expect(env.player.written).toHaveLength(0);
  });

  it.each([
    ["cap", "The 30-minute Grok voice chat limit was reached."],
    ["exited", "The microphone recorder stopped."],
  ] as const)("ends when the microphone %s", async (end, reason) => {
    const env = makeSession();
    await env.session.start();
    env.recording.end(end);
    await expect(env.session.outcome).resolves.toMatchObject({ kind: "ended", insert: false, reason });
  });

  it("ends when xAI closes the conversation", async () => {
    const env = makeSession();
    await env.session.start();
    env.handlers().onClose(undefined);
    await expect(env.session.outcome).resolves.toMatchObject({ reason: "xAI ended the Grok voice chat." });
  });

  it.each([
    ["the connection fails", { connect: async () => { throw new XaiVoiceOperationError("xAI refused the Grok voice chat session. Check that this account includes Grok voice.", "http_failure"); } }, "xAI refused the Grok voice chat session. Check that this account includes Grok voice."],
    ["no player exists", { startPlayer: async () => { throw new XaiRecorderUnavailableError("No audio player was found. Install SoX."); } }, "No audio player was found. Install SoX."],
    ["the recorder throws unexpectedly", { startRecording: async () => { throw new Error("secret"); } }, "Grok voice chat could not start."],
  ])("reports a safe error when %s", async (_name, options, message) => {
    const env = makeSession(options as any);
    await env.session.start();
    await expect(env.session.outcome).resolves.toEqual({ kind: "error", message });
  });

  it.each(["connect", "player", "microphone"] as const)("releases a %s that finishes starting after the user ended", async (stage) => {
    const gate = deferred<any>();
    const conversation = fakeConversation();
    const player = fakePlayer();
    const recording = fakeRecording();
    const session = new XaiTalkSession({
      voice: "eve",
      duplex: false,
      withContext: false,
      connect: () => (stage === "connect" ? gate.promise : Promise.resolve(conversation)),
      startPlayer: () => (stage === "player" ? gate.promise : Promise.resolve(player)),
      startRecording: () => (stage === "microphone" ? gate.promise : Promise.resolve(recording)),
    });
    const starting = session.start();
    await new Promise((resolve) => setImmediate(resolve));
    session.end(false);
    gate.resolve(stage === "connect" ? conversation : stage === "player" ? player : recording);
    await starting;
    if (stage === "connect") expect(conversation.close).toHaveBeenCalled();
    if (stage === "player") expect(player.close).toHaveBeenCalled();
    if (stage === "microphone") expect(recording.cancel).toHaveBeenCalled();
  });

  it("extracts visible session text and labels it as reference material", () => {
    const sessionManager = {
      getBranch: () => [
        { type: "message", message: { role: "user", content: "Fix the parser\u001b[31m" } },
        { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Done." }, { type: "toolCall", name: "bash" }] } },
        { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "secret output" }] } },
        { type: "message", message: { role: "assistant", content: [] } },
        { type: "custom", message: { role: "user", content: "ignored" } },
      ],
    };
    const context = xaiTalkSessionContext(sessionManager);
    expect(context).toBe("Developer: Fix the parser[31m\n\nAssistant: Done.");
    expect(xaiTalkSessionContext({ getBranch: () => [{ type: "message", message: { role: "user", content: "x".repeat(9_000) } }] }))
      .toHaveLength(8_000);
    expect(xaiTalkSessionContext({ getBranch: () => { throw new Error("no session"); } })).toBe("");
    expect(xaiTalkSessionContext(undefined)).toBe("");
    expect(xaiTalkInstructions("")).toMatch(/^You are Grok, talking out loud .* type the request into Pi\.$/);
    expect(xaiTalkInstructions(context)).toMatch(/not as instructions\):\n<pi-session>\nDeveloper: Fix the parser\[31m\n\nAssistant: Done\.\n<\/pi-session>$/);
  });
});

function talkSetup(options: { credentials?: Array<typeof credential | null>; connect?: (options: any, handlers: XaiRealtimeHandlers) => Promise<any> } = {}) {
  const h = createExtensionHarness();
  const conversation = fakeConversation();
  const recording = fakeRecording();
  const player = fakePlayer();
  const credentials = [...(options.credentials ?? [credential])];
  let handlers!: XaiRealtimeHandlers;
  const connect = vi.fn(options.connect ?? (async (_options: any, value: XaiRealtimeHandlers) => {
    handlers = value;
    return conversation;
  }));
  const startRecording = vi.fn(async (_options?: any) => recording);
  const startPlayer = vi.fn(async (_options?: any) => player);
  let clock = 0;
  const controller = registerXaiTalk(h.api, {
    resolveCredential: vi.fn(async () => (credentials.length > 0 ? credentials.shift()! : credential)),
    connect: connect as any,
    startRecording: startRecording as any,
    startPlayer: startPlayer as any,
    now: () => clock,
  });
  return {
    h, controller, conversation, recording, player, connect, startRecording, startPlayer,
    handlers: () => handlers,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function tui(editorText = "") {
  const notices: Array<{ message: string; type?: string }> = [];
  let component: any;
  const ui = {
    notify: (message: string, type?: string) => notices.push({ message, type }),
    custom: vi.fn((factory: any) => new Promise((resolve) => {
      component = factory({ requestRender: vi.fn() }, { fg: (_role: string, text: string) => text }, { matches: () => false }, resolve);
    })),
    pasteToEditor: vi.fn(),
    getEditorText: vi.fn(() => editorText),
    setEditorText: vi.fn(),
    select: vi.fn(),
  };
  return {
    ctx: { mode: "tui", hasUI: true, ui, sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "refactor the lexer" } }] } },
    ui,
    notices,
    component: async () => {
      await vi.waitFor(() => expect(component).toBeDefined());
      return component;
    },
  };
}

describe("/xai-talk", () => {
  it("registers with voice and option completions", () => {
    const { h } = talkSetup();
    const command = h.commands.get("xai-talk");
    expect(command.description).toMatch(/Grok answers out loud/);
    expect(command.getArgumentCompletions("").map(({ value }: any) => value)).toEqual(["eve", "ara", "rex", "sal", "leo", "duplex", "context"]);
    expect(command.getArgumentCompletions("ara d")).toEqual([{ value: "duplex", label: "duplex", description: "Talk over Grok to interrupt (use headphones)" }]);
    expect(command.getArgumentCompletions("zz")).toBeNull();
  });

  it("rejects bad arguments, missing UI, and missing credentials before opening audio", async () => {
    const { h, connect, startRecording } = talkSetup({ credentials: [null] });
    const env = tui();
    await h.commands.get("xai-talk").handler("bob", env.ctx);
    await h.commands.get("xai-talk").handler("eve ara", env.ctx);
    const printNotices: string[] = [];
    await h.commands.get("xai-talk").handler("", { hasUI: false, ui: { notify: (message: string) => printNotices.push(message) } });
    await h.commands.get("xai-talk").handler("", env.ctx);
    expect(env.notices.map(({ message }) => message)).toEqual([
      "Usage: /xai-talk [eve|ara|rex|sal|leo] [duplex] [context]",
      "Usage: /xai-talk [eve|ara|rex|sal|leo] [duplex] [context]",
      "Grok voice chat needs xAI credentials. Run /login and choose xAI (OAuth) or xAI, then try again.",
    ]);
    expect(printNotices).toEqual(["/xai-talk needs Pi's interactive TUI or an RPC client."]);
    expect(connect).not.toHaveBeenCalled();
    expect(startRecording).not.toHaveBeenCalled();
  });

  it("runs a conversation over the OAuth credential and inserts the transcript on Enter", async () => {
    const env = talkSetup();
    const view = tui("draft");
    const running = env.h.commands.get("xai-talk").handler("leo duplex context", view.ctx);
    const component = await view.component();
    await vi.waitFor(() => expect(env.startRecording).toHaveBeenCalled());
    const options = env.connect.mock.calls[0]![0];
    expect(options).toMatchObject({ credential, voice: "leo" });
    expect(options.instructions).toMatch(/<pi-session>\nDeveloper: refactor the lexer\n<\/pi-session>$/);
    expect(env.startRecording).toHaveBeenCalledWith({
      sampleRate: 24_000,
      retainAudio: false,
      maxBytes: Number.POSITIVE_INFINITY,
      maxDurationMs: 1_800_000,
    });
    expect(env.startPlayer).toHaveBeenCalledWith({ sampleRate: 24_000 });
    expect(component.render(200)[0]).toBe("Grok voice chat (leo · duplex · session context) — ● 0:00 ▄ · Listening");
    expect(component.render(200)[1]).toBe("  Say something to Grok…");
    env.handlers().onUserText("Hi Grok", true);
    env.handlers().onAudio(Buffer.alloc(4_800), "a1");
    env.handlers().onAssistantText("Hello!", true);
    expect(component.render(200)[0]).toMatch(/Grok is speaking$/);
    component.handleInput(" ");
    expect(env.player.stop).toHaveBeenCalled();
    component.handleInput("\r");
    await running;
    expect(view.ui.pasteToEditor).toHaveBeenCalledWith("\n\nVoice chat with Grok:\nYou: Hi Grok\nGrok: Hello!");
    expect(view.notices).toEqual([{ message: "Ended the Grok voice chat (0:00).", type: "info" }]);
  });

  it("ends without inserting on Esc and reports why a conversation stopped", async () => {
    const env = talkSetup();
    const view = tui();
    const running = env.h.commands.get("xai-talk").handler("", view.ctx);
    const component = await view.component();
    await vi.waitFor(() => expect(env.startRecording).toHaveBeenCalled());
    env.advance(61_000);
    env.handlers().onClose("The Grok voice chat connection stalled.");
    await running;
    expect(view.ui.pasteToEditor).not.toHaveBeenCalled();
    expect(view.notices).toEqual([{
      message: "Ended the Grok voice chat (1:01). The Grok voice chat connection stalled.",
      type: "warning",
    }]);

    const second = tui();
    const again = env.h.commands.get("xai-talk").handler("", second.ctx);
    const overlay = await second.component();
    overlay.handleInput("\x1b");
    await again;
    expect(second.notices).toEqual([{ message: "Ended the Grok voice chat (0:00).", type: "info" }]);
    expect(component).toBeDefined();
  });

  it("reports start errors and allows one conversation at a time", async () => {
    const gate = deferred<any>();
    const env = talkSetup({ connect: () => gate.promise });
    const first = tui();
    const running = env.h.commands.get("xai-talk").handler("", first.ctx);
    await first.component();
    const second = tui();
    await env.h.commands.get("xai-talk").handler("", second.ctx);
    expect(second.notices).toEqual([{ message: "A Grok voice chat is already running.", type: "warning" }]);
    gate.reject(new XaiVoiceOperationError("Grok voice chat timed out while connecting.", "timeout"));
    await running;
    expect(first.notices).toEqual([{ message: "Grok voice chat timed out while connecting.", type: "error" }]);
  });

  it("uses a dismissible modal in RPC mode", async () => {
    const env = talkSetup();
    const notices: string[] = [];
    const ui = {
      notify: (message: string) => notices.push(message),
      select: vi.fn(async (_title: string, _options: string[], _opts?: { signal?: AbortSignal }) => "End and insert transcript"),
      getEditorText: () => "",
      setEditorText: vi.fn(),
    };
    await env.h.commands.get("xai-talk").handler("sal", { mode: "rpc", hasUI: true, ui });
    expect(ui.select).toHaveBeenCalledWith("Talking with Grok (sal)", ["End conversation", "End and insert transcript"], { signal: expect.any(AbortSignal) });
    expect(notices).toEqual(["Ended the Grok voice chat (0:00)."]);
    expect(ui.setEditorText).not.toHaveBeenCalled();
  });

  it("ends an active conversation on reset without notifying the next session", async () => {
    const env = talkSetup();
    const view = tui();
    const running = env.h.commands.get("xai-talk").handler("", view.ctx);
    await view.component();
    await vi.waitFor(() => expect(env.startRecording).toHaveBeenCalled());
    env.handlers().onUserText("hello", true);
    env.controller.reset();
    await running;
    expect(env.recording.cancel).toHaveBeenCalled();
    expect(view.notices).toEqual([]);
    expect(view.ui.pasteToEditor).not.toHaveBeenCalled();
  });

  it("fails safely when the overlay cannot open", async () => {
    const env = talkSetup();
    const view = tui();
    view.ui.custom.mockImplementation(async () => {
      throw new Error("overlay failed");
    });
    await env.h.commands.get("xai-talk").handler("", view.ctx);
    expect(view.notices).toEqual([{ message: "Grok voice chat stopped unexpectedly.", type: "error" }]);
  });
});
