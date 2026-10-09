import { describe, expect, it, vi } from "vitest";
import { sniffAudioMimeType } from "../../extensions/xai/voice/audio";
import { XaiVoiceOperationError } from "../../extensions/xai/voice/common";
import {
  isXaiVoiceToggleKey,
  registerXaiVoice,
  renderXaiDictation,
  resolveXaiDictationLanguage,
  XaiDictationSession,
  xaiMicrophoneHelp,
} from "../../extensions/xai/voice/dictation";
import { XaiRecorderUnavailableError, type XaiRecordingEnd } from "../../extensions/xai/voice/recorder";
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

function fakeRecording(pcm: Buffer = speechPcm()) {
  const ended = deferred<XaiRecordingEnd>();
  const listeners = new Set<(chunk: Buffer) => void>();
  return {
    program: "fake-recorder",
    ended: ended.promise,
    end: ended.resolve,
    emit: (chunk: Buffer) => listeners.forEach((listener) => listener(chunk)),
    bytesCaptured: () => pcm.length,
    level: vi.fn(() => 0.6),
    snapshot: vi.fn(() => pcm),
    subscribe: vi.fn((listener: (chunk: Buffer) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    stop: vi.fn(async () => pcm),
    cancel: vi.fn(),
  };
}

function fakeLive(finalText: string | Error = "hello world") {
  const sent: Buffer[] = [];
  let failure: string | undefined;
  let text = "";
  return {
    sent,
    setPreview: (value: string) => {
      text = value;
    },
    setFailure: (value: string) => {
      failure = value;
    },
    send: vi.fn((chunk: Buffer) => {
      sent.push(chunk);
    }),
    preview: () => text,
    failure: () => failure,
    finish: vi.fn(async (_signal?: AbortSignal) => {
      if (finalText instanceof Error) throw finalText;
      return finalText;
    }),
    close: vi.fn(),
  };
}

function setup(options: {
  recording?: ReturnType<typeof fakeRecording>;
  startRecording?: () => Promise<any>;
  credentials?: Array<typeof credential | null>;
  transcribe?: (options: any) => Promise<{ text: string }>;
  live?: ReturnType<typeof fakeLive> | Error | (() => Promise<any>);
  locale?: string;
  platform?: NodeJS.Platform;
  noSpeechMs?: number;
} = {}) {
  const h = createExtensionHarness();
  const recording = options.recording ?? fakeRecording();
  const startRecording = vi.fn(options.startRecording ?? (async () => recording));
  const credentials = [...(options.credentials ?? [credential, credential])];
  const resolveCredential = vi.fn(async () => (credentials.length > 0 ? credentials.shift()! : credential));
  const transcribe = vi.fn(options.transcribe ?? (async () => ({ text: "uploaded words" })));
  const live = options.live ?? fakeLive();
  const connectLive = vi.fn(async (_options: any) => {
    if (live instanceof Error) throw live;
    if (typeof live === "function") return live();
    return live;
  });
  let clock = 1_000;
  const controller = registerXaiVoice(h.api, {
    startRecording,
    resolveCredential,
    transcribe: transcribe as any,
    connectLive: connectLive as any,
    now: () => clock,
    locale: () => options.locale,
    platform: options.platform ?? "linux",
    noSpeechMs: options.noSpeechMs ?? 60_000,
  });
  return {
    h,
    controller,
    recording,
    startRecording,
    resolveCredential,
    transcribe,
    connectLive,
    live,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function tuiContext(editorText = "draft") {
  const notices: Array<{ message: string; type?: string }> = [];
  let component: any;
  const ui = {
    notify: (message: string, type?: string) => notices.push({ message, type }),
    custom: vi.fn((factory: any) => new Promise((resolve) => {
      component = factory(
        { requestRender: vi.fn() },
        { fg: (_role: string, text: string) => text },
        { matches: (data: string, id: string) => (id === "tui.select.confirm" && data === "enter") || (id === "tui.select.cancel" && data === "escape") },
        resolve,
      );
    })),
    pasteToEditor: vi.fn(),
    getEditorText: vi.fn(() => editorText),
    setEditorText: vi.fn(),
    select: vi.fn(),
  };
  return {
    ctx: { mode: "tui", hasUI: true, ui, model: undefined, modelRegistry: {} },
    ui,
    notices,
    component: async () => {
      await vi.waitFor(() => expect(component).toBeDefined());
      return component;
    },
  };
}

function rpcContext(choice: string | undefined | Promise<string | undefined>) {
  const notices: Array<{ message: string; type?: string }> = [];
  const ui = {
    notify: (message: string, type?: string) => notices.push({ message, type }),
    select: vi.fn(async (_title: string, _options: string[], _opts?: { signal?: AbortSignal }) => choice),
    pasteToEditor: vi.fn(),
    getEditorText: vi.fn(() => ""),
    setEditorText: vi.fn(),
  };
  return { ctx: { mode: "rpc", hasUI: true, ui }, ui, notices };
}

async function startTui(env: ReturnType<typeof setup>, args = "", editorText = "draft") {
  const tui = tuiContext(editorText);
  const running = env.h.commands.get("xai-voice").handler(args, tui.ctx);
  const view = await tui.component();
  return { ...tui, running, view };
}

describe("Grok voice dictation", () => {
  it("registers /xai-voice with language and mode completions and Grok Build's shortcuts", () => {
    const { h } = setup();
    const command = h.commands.get("xai-voice");
    expect(command.description).toMatch(/live speech-to-text/);
    expect(command.getArgumentCompletions("").map(({ value }: any) => value).slice(0, 3)).toEqual(["auto", "ar", "cs"]);
    expect(command.getArgumentCompletions("E")).toEqual([
      { value: "en", label: "en", description: "English" },
      { value: "es", label: "es", description: "Spanish" },
    ]);
    expect(command.getArgumentCompletions("es l")).toEqual([
      { value: "live", label: "live", description: "Stream audio and show words as you speak (default)" },
    ]);
    expect(command.getArgumentCompletions("cl")[0]).toMatchObject({ value: "clip" });
    expect(command.getArgumentCompletions("zz")).toBeNull();
    expect([...h.shortcuts.keys()]).toEqual(["ctrl+space", "f8"]);
  });

  it("rejects invalid arguments and non-interactive modes before touching credentials or the microphone", async () => {
    const { h, startRecording, resolveCredential } = setup();
    const { ctx, notices } = tuiContext();
    for (const args of ["klingon", "en es", "live clip", "en live extra"]) {
      await h.commands.get("xai-voice").handler(args, ctx);
    }
    const printNotices: string[] = [];
    await h.commands.get("xai-voice").handler("", {
      mode: "print",
      hasUI: false,
      ui: { notify: (message: string) => printNotices.push(message) },
    });
    expect(notices).toHaveLength(4);
    for (const notice of notices) {
      expect(notice.message).toMatch(/^Usage: \/xai-voice \[language\|auto\] \[live\|clip\].*Languages: auto, ar, cs/);
    }
    expect(printNotices).toEqual(["/xai-voice needs Pi's interactive TUI or an RPC client."]);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(startRecording).not.toHaveBeenCalled();
  });

  it("requires xAI credentials before opening the microphone", async () => {
    const { h, startRecording } = setup({ credentials: [null] });
    const { ctx, notices } = tuiContext();
    await h.commands.get("xai-voice").handler("", ctx);
    expect(startRecording).not.toHaveBeenCalled();
    expect(notices).toEqual([{ message: expect.stringMatching(/needs xAI credentials.*\/login/), type: "error" }]);
  });

  it.each([
    [new XaiRecorderUnavailableError("No microphone recorder was found. Install SoX."), "No microphone recorder was found. Install SoX."],
    [new Error("spawn exploded with secret"), "Could not start the microphone recorder."],
  ])("reports recorder start failures", async (error, message) => {
    const { h, connectLive } = setup({ startRecording: async () => { throw error; } });
    const { ctx, notices } = tuiContext();
    await h.commands.get("xai-voice").handler("", ctx);
    expect(notices).toEqual([{ message, type: "error" }]);
    expect(connectLive).not.toHaveBeenCalled();
  });

  it("streams live over the OAuth bearer, shows words as they arrive, and inserts the transcript", async () => {
    const env = setup();
    const live = env.live as ReturnType<typeof fakeLive>;
    const { ui, notices, running, view } = await startTui(env);
    await vi.waitFor(() => expect(env.connectLive).toHaveBeenCalledTimes(1));
    const options = env.connectLive.mock.calls[0]![0] as any;
    expect(options).toMatchObject({ credential, language: "en" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    await vi.waitFor(() => expect(live.sent).toEqual([speechPcm()]));
    env.recording.emit(Buffer.from([1, 2]));
    expect(live.sent.at(-1)).toEqual(Buffer.from([1, 2]));
    env.advance(3_200);
    expect(view.render(200)).toEqual([
      "Grok voice (live) — ● 0:03 / 5:00 ▅ · English",
      "  Listening…",
      "  Enter or Ctrl+Space: insert · Esc: discard",
    ]);
    live.setPreview("Refactor the parser so that it handles nested quotes");
    expect(view.render(40)).toEqual([
      "Grok voice (live) — ● 0:03 / 5:00 ▅ · ",
      "  …er so that it handles nested quotes",
      "  Enter or Ctrl+Space: insert · Esc: d",
    ]);
    view.handleInput("enter");
    await running;
    expect(live.finish).toHaveBeenCalledTimes(1);
    expect(env.transcribe).not.toHaveBeenCalled();
    expect(env.resolveCredential).toHaveBeenCalledTimes(1);
    expect(live.close).toHaveBeenCalled();
    expect(ui.pasteToEditor).toHaveBeenCalledWith(" hello world");
    expect(notices).toEqual([]);
  });

  it("falls back to uploading the clip when the live connection fails", async () => {
    const env = setup({ live: new XaiVoiceOperationError("could not connect", "network_failure") });
    const { ui, notices, running, view } = await startTui(env, "", "");
    await vi.waitFor(() => expect(view.render(200)[0]).toMatch(/live unavailable; Enter uploads the clip$/));
    view.handleInput("enter");
    await running;
    expect(env.transcribe).toHaveBeenCalledTimes(1);
    const call = env.transcribe.mock.calls[0]![0];
    expect(call.audio.mimeType).toBe("audio/wav");
    expect(sniffAudioMimeType(call.audio.bytes)).toBe("audio/wav");
    expect(call.audio.bytes.subarray(44)).toEqual(speechPcm());
    expect(ui.pasteToEditor).toHaveBeenCalledWith("uploaded words");
    expect(notices).toEqual([{ message: "Live transcription was unavailable, so the recording was uploaded instead.", type: "info" }]);
  });

  it("falls back to uploading when the live stream fails before or during finish", async () => {
    const failedEarly = fakeLive();
    const early = setup({ live: failedEarly });
    const first = await startTui(early);
    await vi.waitFor(() => expect(failedEarly.sent.length).toBeGreaterThan(0));
    failedEarly.setFailure("The xAI live transcription connection closed.");
    early.recording.emit(Buffer.from([1, 2]));
    first.view.handleInput("enter");
    await first.running;
    expect(failedEarly.finish).not.toHaveBeenCalled();
    expect(early.transcribe).toHaveBeenCalledTimes(1);

    const late = setup({ live: fakeLive(new XaiVoiceOperationError("stream failed", "network_failure")) });
    const second = await startTui(late);
    await vi.waitFor(() => expect(late.connectLive).toHaveBeenCalled());
    second.view.handleInput("enter");
    await second.running;
    expect(late.transcribe).toHaveBeenCalledTimes(1);
    expect(second.ui.pasteToEditor).toHaveBeenCalledWith(" uploaded words");
  });

  it("reports silence after a live stream without claiming nothing was sent", async () => {
    const env = setup({ recording: fakeRecording(Buffer.alloc(3_200)), live: fakeLive("") });
    const { notices, running, view } = await startTui(env);
    await vi.waitFor(() => expect((env.live as any).sent.length).toBe(1));
    view.handleInput("enter");
    await running;
    expect(notices).toEqual([{ message: expect.stringMatching(/^The microphone recorded only silence\. Check the default input/), type: "warning" }]);
  });

  it("reports an empty live transcript of audible audio as no speech", async () => {
    const env = setup({ live: fakeLive("") });
    const { notices, running, view } = await startTui(env);
    await vi.waitFor(() => expect(env.connectLive).toHaveBeenCalled());
    view.handleInput("enter");
    await running;
    expect(env.transcribe).not.toHaveBeenCalled();
    expect(notices).toEqual([{ message: "No speech was detected. Nothing was inserted.", type: "warning" }]);
  });

  it("discards a live dictation honestly once audio has streamed", async () => {
    const env = setup();
    const { ui, notices, running, view } = await startTui(env);
    await vi.waitFor(() => expect((env.live as any).sent.length).toBe(1));
    view.handleInput("escape");
    await running;
    expect(env.recording.cancel).toHaveBeenCalled();
    expect((env.live as any).close).toHaveBeenCalled();
    expect(ui.pasteToEditor).not.toHaveBeenCalled();
    expect(notices).toEqual([{
      message: "Discarded the dictation; nothing was inserted. Audio already streamed live to xAI is not recalled.",
      type: "info",
    }]);
  });

  it("does not count audio a failed live stream refused", async () => {
    const refused = fakeLive();
    refused.setFailure("The xAI live transcription connection stalled.");
    const env = setup({ live: refused });
    const { notices, running, view } = await startTui(env);
    await vi.waitFor(() => expect(view.render(200)[0]).toMatch(/live unavailable/));
    expect(refused.send).not.toHaveBeenCalled();
    view.handleInput("escape");
    await running;
    expect(notices).toEqual([{ message: "Discarded the recording; nothing was sent to xAI.", type: "info" }]);
  });

  it("closes a live stream that connects after the dictation was discarded", async () => {
    const connected = deferred<ReturnType<typeof fakeLive>>();
    const late = fakeLive();
    const env = setup({ live: () => connected.promise });
    const { notices, running, view } = await startTui(env);
    view.handleInput("escape");
    await running;
    connected.resolve(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalled());
    expect(late.sent).toEqual([]);
    expect(notices).toEqual([{ message: "Discarded the recording; nothing was sent to xAI.", type: "info" }]);
  });

  it("keeps clip mode local until Enter and then uploads once", async () => {
    const env = setup();
    const { ui, notices, running, view } = await startTui(env, "clip");
    expect(env.connectLive).not.toHaveBeenCalled();
    expect(view.render(200)).toEqual([
      "Grok voice — ● 0:00 / 5:00 ▅ · English",
      "  Enter or Ctrl+Space: transcribe · Esc: discard (nothing is sent)",
    ]);
    view.handleInput("enter");
    await vi.waitFor(() => expect(env.transcribe).toHaveBeenCalledTimes(1));
    await running;
    expect(env.resolveCredential).toHaveBeenCalledTimes(2);
    expect(ui.pasteToEditor).toHaveBeenCalledWith(" uploaded words");
    expect(notices).toEqual([]);
  });

  it("shows transcribing state and aborts an in-flight upload on Esc", async () => {
    const env = setup({
      transcribe: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    const { ui, notices, running, view } = await startTui(env, "clip");
    view.handleInput("enter");
    await vi.waitFor(() => expect(env.transcribe).toHaveBeenCalled());
    expect(view.render(200)).toEqual(["Grok voice — Transcribing with xAI…", "  Esc: cancel"]);
    view.handleInput("enter");
    view.handleInput("\x03");
    await running;
    expect(env.transcribe.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(ui.pasteToEditor).not.toHaveBeenCalled();
    expect(notices).toEqual([{ message: "Cancelled Grok voice transcription.", type: "info" }]);
  });

  it("does not insert an upload that completes after the user cancelled", async () => {
    const upload = deferred<{ text: string }>();
    const env = setup({ transcribe: () => upload.promise });
    const { ui, notices, running, view } = await startTui(env, "clip");
    view.handleInput("enter");
    await vi.waitFor(() => expect(env.transcribe).toHaveBeenCalled());
    view.handleInput("escape");
    upload.resolve({ text: "too late" });
    await running;
    expect(ui.pasteToEditor).not.toHaveBeenCalled();
    expect(notices).toEqual([{ message: "Cancelled Grok voice transcription.", type: "info" }]);
  });

  it("recognizes Ctrl+Space and F8 across terminal encodings and ignores the start chord's auto-repeat", async () => {
    for (const key of ["\x00", "\x1b[19~", "\x1b[32;5u", "\x1b[32;5:1u", "\x1b[32;69u", "\x1b[27;5;32~", "\x1b[19;1:1~"]) {
      expect(isXaiVoiceToggleKey(key)).toBe(true);
    }
    for (const key of [" ", "\x1b[32;5:2u", "\x1b[32;5:3u", "\x1b[32;3u", "\x1b[19;5~", "\x1b[27;3;32~", "x"]) {
      expect(isXaiVoiceToggleKey(key)).toBe(false);
    }
    const env = setup();
    const { running, view } = await startTui(env, "clip");
    view.handleInput("\x00");
    expect(env.recording.stop).not.toHaveBeenCalled();
    env.advance(600);
    view.handleInput("\x1b[32;5u");
    await running;
    expect(env.recording.stop).toHaveBeenCalledTimes(1);
  });

  it("never uploads a silent clip and explains the microphone permission", async () => {
    const env = setup({ recording: fakeRecording(Buffer.alloc(3_200)), platform: "darwin" });
    const { notices, running, view } = await startTui(env, "clip");
    view.handleInput("enter");
    await running;
    expect(env.transcribe).not.toHaveBeenCalled();
    expect(notices).toEqual([{
      message: expect.stringMatching(/only silence, so nothing was sent to xAI\. Allow microphone access .*Privacy & Security/),
      type: "warning",
    }]);
  });

  it("stops a microphone that records only silence after the no-speech window", async () => {
    const env = setup({ recording: fakeRecording(Buffer.alloc(3_200)), noSpeechMs: 20, live: () => new Promise(() => undefined) });
    const { notices, running } = await startTui(env);
    await running;
    expect(env.recording.cancel).toHaveBeenCalled();
    expect(env.recording.stop).not.toHaveBeenCalled();
    expect(notices).toEqual([{ message: expect.stringMatching(/only silence, so nothing was sent to xAI/), type: "warning" }]);
  });

  it("keeps recording past the no-speech window when there is audio", async () => {
    const env = setup({ noSpeechMs: 10, live: new Error("offline") });
    const { running, view } = await startTui(env, "clip");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(env.recording.cancel).not.toHaveBeenCalled();
    view.handleInput("enter");
    await running;
    expect(env.transcribe).toHaveBeenCalledTimes(1);
  });

  it.each([
    [async () => ({ text: "" }), { message: "No speech was detected. Nothing was inserted.", type: "warning" }],
    [
      async () => {
        throw new XaiVoiceOperationError("xAI speech to text failed with HTTP 403. This xAI account may not include voice access.", "http_failure", 403);
      },
      { message: "xAI speech to text failed with HTTP 403. This xAI account may not include voice access.", type: "error" },
    ],
    [
      async () => {
        throw new Error("raw transport detail oauth-token");
      },
      { message: "Grok voice transcription failed.", type: "error" },
    ],
  ])("reports empty and failed uploads %#", async (transcribeImpl, notice) => {
    const env = setup({ transcribe: transcribeImpl as any });
    const { ui, notices, running, view } = await startTui(env, "clip");
    view.handleInput("enter");
    await running;
    expect(ui.pasteToEditor).not.toHaveBeenCalled();
    expect(notices).toEqual([notice]);
  });

  it("fails safely when credentials disappear before upload", async () => {
    const env = setup({ credentials: [credential, null] });
    const { notices, running, view } = await startTui(env, "clip");
    view.handleInput("enter");
    await running;
    expect(env.transcribe).not.toHaveBeenCalled();
    expect(notices).toEqual([{ message: "xAI credentials are no longer available; sign in again.", type: "error" }]);
  });

  it("stops capture at the duration cap and still waits for an explicit insert", async () => {
    const env = setup();
    const { ui, notices, running, view } = await startTui(env, "", "draft\n");
    await vi.waitFor(() => expect(env.connectLive).toHaveBeenCalled());
    env.recording.end("cap");
    await vi.waitFor(() => expect(view.render(200)[0]).toBe("Grok voice (live) — Recording limit reached (5:00)"));
    expect(env.recording.stop).toHaveBeenCalledTimes(1);
    expect((env.live as any).finish).not.toHaveBeenCalled();
    view.handleInput("enter");
    await running;
    expect(env.recording.stop).toHaveBeenCalledTimes(1);
    expect(ui.pasteToEditor).toHaveBeenCalledWith("hello world");
    expect(notices).toEqual([{
      message: "Recording stopped at the 5-minute limit; the captured part was transcribed.",
      type: "info",
    }]);
  });

  it("discards a clip after the recorder exits on its own without uploading", async () => {
    const env = setup();
    const { ui, notices, running, view } = await startTui(env, "clip");
    env.recording.end("exited");
    await vi.waitFor(() => expect(view.render(200)[0]).toBe("Grok voice — The microphone recorder stopped"));
    view.handleInput("escape");
    await running;
    expect(env.transcribe).not.toHaveBeenCalled();
    expect(ui.pasteToEditor).not.toHaveBeenCalled();
    expect(notices).toEqual([{ message: "Discarded the recording; nothing was sent to xAI.", type: "info" }]);
  });

  it("uses a dismissible modal in RPC mode and sets the client editor text", async () => {
    const env = setup();
    const stop = rpcContext("Stop and insert");
    await env.h.commands.get("xai-voice").handler("", stop.ctx);
    expect(stop.ui.select).toHaveBeenCalledWith(
      "Grok voice is listening live (English, up to 5:00)",
      ["Stop and insert", "Discard recording"],
      { signal: expect.any(AbortSignal) },
    );
    expect(stop.ui.select.mock.calls[0]![2]!.signal!.aborted).toBe(true);
    expect(stop.ui.pasteToEditor).not.toHaveBeenCalled();
    expect(stop.ui.setEditorText).toHaveBeenCalledWith("hello world");

    const clip = rpcContext("Stop and transcribe");
    await env.h.commands.get("xai-voice").handler("clip", clip.ctx);
    expect(clip.ui.select.mock.calls[0]![0]).toBe("Grok voice is recording (English, up to 5:00)");
    expect(clip.ui.setEditorText).toHaveBeenCalledWith("uploaded words");

    const discard = rpcContext(undefined);
    await env.h.commands.get("xai-voice").handler("", discard.ctx);
    expect(discard.notices).toEqual([{ message: "Discarded the recording; nothing was sent to xAI.", type: "info" }]);
  });

  it("dismisses the RPC dialog and inserts nothing when the session resets", async () => {
    const env = setup();
    const choice = deferred<string | undefined>();
    const { ctx, ui, notices } = rpcContext(choice.promise);
    const running = env.h.commands.get("xai-voice").handler("", ctx);
    await vi.waitFor(() => expect(ui.select).toHaveBeenCalled());
    const signal = ui.select.mock.calls[0]![2]!.signal!;
    env.controller.reset();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    choice.resolve(undefined);
    await running;
    expect(env.recording.cancel).toHaveBeenCalled();
    expect(ui.setEditorText).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("remembers the requested language and mode until reset", async () => {
    const env = setup();
    await env.h.commands.get("xai-voice").handler("CLIP ES", rpcContext("Stop and transcribe").ctx);
    await env.h.shortcuts.get("f8").handler(rpcContext("Stop and transcribe").ctx);
    env.controller.reset();
    await env.h.shortcuts.get("ctrl+space").handler(rpcContext("Stop and insert").ctx);
    expect(env.transcribe.mock.calls.map(([options]) => options.language)).toEqual(["es", "es"]);
    expect(env.connectLive.mock.calls.map(([options]: any) => options.language)).toEqual(["en"]);
  });

  it("resolves auto from the system locale", async () => {
    const env = setup({ locale: "pt_BR" });
    await env.h.commands.get("xai-voice").handler("auto clip", rpcContext("Stop and transcribe").ctx);
    expect(env.transcribe.mock.calls[0]![0].language).toBe("pt");
    expect(resolveXaiDictationLanguage("auto", "tl-PH")).toBe("fil");
    expect(resolveXaiDictationLanguage("auto", "zh-CN")).toBe("en");
    expect(resolveXaiDictationLanguage("auto", undefined)).toBe("en");
    expect(resolveXaiDictationLanguage("ja", "de-DE")).toBe("ja");
  });

  it("opens one recorder for repeated triggers during startup", async () => {
    const recorder = deferred<ReturnType<typeof fakeRecording>>();
    const recording = fakeRecording();
    const env = setup({ startRecording: () => recorder.promise });
    const first = tuiContext();
    const running = env.h.shortcuts.get("ctrl+space").handler(first.ctx);
    await vi.waitFor(() => expect(env.startRecording).toHaveBeenCalledTimes(1));
    await env.h.shortcuts.get("ctrl+space").handler(tuiContext().ctx);
    await env.h.shortcuts.get("f8").handler(tuiContext().ctx);
    expect(env.startRecording).toHaveBeenCalledTimes(1);
    recorder.resolve(recording);
    const view = await first.component();
    view.handleInput("escape");
    await running;
    expect(first.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("toggles an active dictation from the shortcut, as Grok Build does", async () => {
    const env = setup();
    const { ui, running } = await startTui(env);
    await env.h.shortcuts.get("ctrl+space").handler(tuiContext().ctx);
    expect((env.live as any).finish).not.toHaveBeenCalled();
    env.advance(600);
    await env.h.shortcuts.get("ctrl+space").handler(tuiContext().ctx);
    await running;
    expect((env.live as any).finish).toHaveBeenCalledTimes(1);
    expect(ui.pasteToEditor).toHaveBeenCalledWith(" hello world");
  });

  it("cancels a recorder that finishes starting after a reset", async () => {
    const recorder = deferred<ReturnType<typeof fakeRecording>>();
    const recording = fakeRecording();
    const env = setup({ startRecording: () => recorder.promise });
    const { ctx, ui } = tuiContext();
    const running = env.h.commands.get("xai-voice").handler("", ctx);
    await vi.waitFor(() => expect(env.startRecording).toHaveBeenCalled());
    env.controller.reset();
    recorder.resolve(recording);
    await running;
    expect(recording.cancel).toHaveBeenCalled();
    expect(ui.custom).not.toHaveBeenCalled();
    expect(env.connectLive).not.toHaveBeenCalled();
  });

  it("cancels an active dictation on reset and never inserts into the next session", async () => {
    const finishing = deferred<string>();
    const live = fakeLive();
    live.finish.mockImplementation(() => finishing.promise);
    const env = setup({ live });
    const { ui, notices, running, view } = await startTui(env);
    await vi.waitFor(() => expect(env.connectLive).toHaveBeenCalled());
    view.handleInput("enter");
    await vi.waitFor(() => expect(live.finish).toHaveBeenCalled());
    env.controller.reset();
    finishing.resolve("late text");
    await running;
    expect(ui.pasteToEditor).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("fails safely when the overlay cannot open, and cancels on dispose", async () => {
    const failing = setup();
    const { ctx, ui, notices } = tuiContext();
    ui.custom.mockImplementation(async () => {
      throw new Error("overlay failed");
    });
    await failing.h.commands.get("xai-voice").handler("", ctx);
    expect(failing.recording.cancel).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([{ message: "Grok voice stopped unexpectedly; nothing was inserted.", type: "error" }]);

    const disposed = setup();
    const { running, view } = await startTui(disposed, "clip");
    view.dispose();
    await running;
    expect(disposed.recording.cancel).toHaveBeenCalledTimes(1);
  });

  it("settles once: finish is shared and cancel while stopping discards", async () => {
    const stopping = deferred<Buffer>();
    const recording = { ...fakeRecording(), stop: vi.fn(() => stopping.promise) };
    const upload = vi.fn(async () => "text");
    const session = new XaiDictationSession({ recording, language: "en", mode: "clip", upload, now: () => 0 });
    const first = session.finish();
    expect(session.finish()).toBe(first);
    expect(renderXaiDictation(session, 80)[0]).toBe("Grok voice — Stopping…");
    session.cancel();
    stopping.resolve(speechPcm());
    await expect(first).resolves.toEqual({ kind: "discarded", streamed: false });
    expect(upload).not.toHaveBeenCalled();
    session.cancel();
    session.fail("ignored");
    await expect(session.outcome).resolves.toEqual({ kind: "discarded", streamed: false });
    const empty = new XaiDictationSession({ recording: fakeRecording(Buffer.alloc(0)), language: "en", mode: "clip", upload });
    await expect(empty.finish()).resolves.toEqual({ kind: "silent", streamed: false });
  });

  it("gives platform-specific microphone guidance", () => {
    expect(xaiMicrophoneHelp("darwin")).toMatch(/System Settings/);
    expect(xaiMicrophoneHelp("win32")).toMatch(/Privacy & security/);
    expect(xaiMicrophoneHelp("linux")).toMatch(/pavucontrol|wpctl/);
  });
});
