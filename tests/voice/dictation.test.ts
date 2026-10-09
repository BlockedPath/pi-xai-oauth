import { describe, expect, it, vi } from "vitest";
import { sniffAudioMimeType } from "../../extensions/xai/voice/audio";
import { XaiVoiceOperationError } from "../../extensions/xai/voice/common";
import {
  registerXaiVoice,
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
  return {
    program: "fake-recorder",
    ended: ended.promise,
    end: ended.resolve,
    bytesCaptured: () => pcm.length,
    level: vi.fn(() => 0.6),
    stop: vi.fn(async () => pcm),
    cancel: vi.fn(),
  };
}

function setup(options: {
  recording?: ReturnType<typeof fakeRecording>;
  startRecording?: () => Promise<any>;
  credentials?: Array<typeof credential | null>;
  transcribe?: (options: any) => Promise<{ text: string }>;
  locale?: string;
  platform?: NodeJS.Platform;
} = {}) {
  const h = createExtensionHarness();
  const recording = options.recording ?? fakeRecording();
  const startRecording = vi.fn(options.startRecording ?? (async () => recording));
  const credentials = [...(options.credentials ?? [credential, credential])];
  const resolveCredential = vi.fn(async () => (credentials.length > 0 ? credentials.shift()! : credential));
  const transcribe = vi.fn(options.transcribe ?? (async () => ({ text: "hello world" })));
  let clock = 1_000;
  const controller = registerXaiVoice(h.api, {
    startRecording,
    resolveCredential,
    transcribe: transcribe as any,
    now: () => clock,
    locale: () => options.locale,
    platform: options.platform ?? "linux",
  });
  return {
    h,
    controller,
    recording,
    startRecording,
    resolveCredential,
    transcribe,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function tuiContext(editorText = "draft") {
  const notices: Array<{ message: string; type?: string }> = [];
  let component: any;
  const renders = vi.fn();
  const ui = {
    notify: (message: string, type?: string) => notices.push({ message, type }),
    custom: vi.fn((factory: any) => new Promise((resolve) => {
      component = factory(
        { requestRender: renders },
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
    renders,
    component: async () => {
      await vi.waitFor(() => expect(component).toBeDefined());
      return component;
    },
  };
}

function rpcContext(choice: string | undefined, editorText = "draft ") {
  const notices: Array<{ message: string; type?: string }> = [];
  const ui = {
    notify: (message: string, type?: string) => notices.push({ message, type }),
    select: vi.fn(async () => choice),
    pasteToEditor: vi.fn(),
    getEditorText: vi.fn(() => editorText),
    setEditorText: vi.fn(),
  };
  return { ctx: { mode: "rpc", hasUI: true, ui }, ui, notices };
}

describe("Grok voice dictation", () => {
  it("registers /xai-voice with language completions and Grok Build's shortcuts", () => {
    const { h } = setup();
    const command = h.commands.get("xai-voice");
    expect(command.description).toMatch(/Grok voice/);
    expect(command.getArgumentCompletions("").map(({ value }: any) => value).slice(0, 3)).toEqual(["auto", "ar", "cs"]);
    expect(command.getArgumentCompletions("E")).toEqual([
      { value: "en", label: "en", description: "English" },
      { value: "es", label: "es", description: "Spanish" },
    ]);
    expect(command.getArgumentCompletions("zz")).toBeNull();
    expect([...h.shortcuts.keys()]).toEqual(["ctrl+space", "f8"]);
  });

  it("rejects invalid arguments and non-interactive modes before touching credentials or the microphone", async () => {
    const { h, startRecording, resolveCredential } = setup();
    const { ctx, notices } = tuiContext();
    await h.commands.get("xai-voice").handler("en es", ctx);
    await h.commands.get("xai-voice").handler("klingon", ctx);
    const printNotices: string[] = [];
    await h.commands.get("xai-voice").handler("", {
      mode: "print",
      hasUI: false,
      ui: { notify: (message: string) => printNotices.push(message) },
    });
    expect(notices.map(({ message }) => message)).toEqual([
      "Usage: /xai-voice [language|auto] — e.g. /xai-voice es",
      expect.stringMatching(/^Usage: .*Languages: auto, ar, cs/),
    ]);
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
    const { h, transcribe } = setup({ startRecording: async () => { throw error; } });
    const { ctx, notices } = tuiContext();
    await h.commands.get("xai-voice").handler("", ctx);
    expect(notices).toEqual([{ message, type: "error" }]);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("records, shows live status, transcribes a WAV clip, and inserts at the cursor", async () => {
    const upload = deferred<{ text: string }>();
    const { h, recording, transcribe, resolveCredential, advance } = setup({ transcribe: () => upload.promise });
    const { ctx, ui, notices, component } = tuiContext("draft");
    const running = h.commands.get("xai-voice").handler("", ctx);
    const view = await component();
    advance(7_400);
    expect(view.render(200)).toEqual([
      "Grok voice — ● Recording 0:07 / 5:00 ▅ · English",
      "  Enter or Ctrl+Space: transcribe · Esc: discard (nothing is sent)",
    ]);
    expect(view.render(12)[0]).toHaveLength(10);
    view.handleInput("enter");
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    expect(view.render(200)).toEqual(["Grok voice — Transcribing with xAI…", "  Esc: cancel"]);
    view.handleInput("enter");
    expect(recording.stop).toHaveBeenCalledTimes(1);
    const call = transcribe.mock.calls[0]![0];
    expect(call.credential).toEqual(credential);
    expect(call.language).toBe("en");
    expect(call.audio.mimeType).toBe("audio/wav");
    expect(sniffAudioMimeType(call.audio.bytes)).toBe("audio/wav");
    expect(call.audio.bytes.subarray(44)).toEqual(speechPcm());
    expect(call.signal).toBeInstanceOf(AbortSignal);
    upload.resolve({ text: "hello world" });
    await running;
    expect(resolveCredential).toHaveBeenCalledTimes(2);
    expect(ui.pasteToEditor).toHaveBeenCalledWith(" hello world");
    expect(ui.setEditorText).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    expect(recording.cancel).not.toHaveBeenCalled();
  });

  it.each(["\x00", "\x1b[19~", "\r"])("treats %j as the transcribe key", async (key) => {
    const { h, transcribe } = setup();
    const { ctx, ui, component } = tuiContext("");
    const running = h.commands.get("xai-voice").handler("", ctx);
    (await component()).handleInput(key);
    await running;
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(ui.pasteToEditor).toHaveBeenCalledWith("hello world");
  });

  it("discards a recording on Esc without stopping into an upload", async () => {
    const { h, recording, transcribe } = setup();
    const { ctx, ui, notices, component } = tuiContext();
    const running = h.commands.get("xai-voice").handler("", ctx);
    (await component()).handleInput("escape");
    await running;
    expect(recording.cancel).toHaveBeenCalledTimes(1);
    expect(recording.stop).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(ui.pasteToEditor).not.toHaveBeenCalled();
    expect(notices).toEqual([{ message: "Discarded the recording; nothing was sent to xAI.", type: "info" }]);
  });

  it("aborts an in-flight transcription on Esc", async () => {
    const { h, transcribe } = setup({
      transcribe: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    const { ctx, ui, notices, component } = tuiContext();
    const running = h.commands.get("xai-voice").handler("", ctx);
    const view = await component();
    view.handleInput("enter");
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
    view.handleInput("\x03");
    await running;
    expect(transcribe.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(ui.pasteToEditor).not.toHaveBeenCalled();
    expect(notices).toEqual([{ message: "Cancelled Grok voice transcription.", type: "info" }]);
  });

  it("never uploads a silent clip and explains the microphone permission", async () => {
    const { h, transcribe } = setup({ recording: fakeRecording(Buffer.alloc(3_200)), platform: "darwin" });
    const { ctx, notices, component } = tuiContext();
    const running = h.commands.get("xai-voice").handler("", ctx);
    (await component()).handleInput("enter");
    await running;
    expect(transcribe).not.toHaveBeenCalled();
    expect(notices).toEqual([{
      message: expect.stringMatching(/only silence, so nothing was sent to xAI\. Allow microphone access .*Privacy & Security/),
      type: "warning",
    }]);
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
  ])("reports empty and failed transcriptions %#", async (transcribeImpl, notice) => {
    const { h } = setup({ transcribe: transcribeImpl as any });
    const { ctx, ui, notices, component } = tuiContext();
    const running = h.commands.get("xai-voice").handler("", ctx);
    (await component()).handleInput("enter");
    await running;
    expect(ui.pasteToEditor).not.toHaveBeenCalled();
    expect(notices).toEqual([notice]);
  });

  it("fails safely when credentials disappear before upload", async () => {
    const { h, transcribe } = setup({ credentials: [credential, null] });
    const { ctx, notices, component } = tuiContext();
    const running = h.commands.get("xai-voice").handler("", ctx);
    (await component()).handleInput("enter");
    await running;
    expect(transcribe).not.toHaveBeenCalled();
    expect(notices).toEqual([{ message: "xAI credentials are no longer available; sign in again.", type: "error" }]);
  });

  it("stops capture at the duration cap and still waits for an explicit transcribe", async () => {
    const { h, recording, transcribe } = setup();
    const { ctx, ui, notices, component } = tuiContext("draft\n");
    const running = h.commands.get("xai-voice").handler("", ctx);
    const view = await component();
    recording.end("cap");
    await vi.waitFor(() => expect(view.render(200)[0]).toBe("Grok voice — Recording limit reached (5:00)"));
    expect(recording.stop).toHaveBeenCalledTimes(1);
    expect(transcribe).not.toHaveBeenCalled();
    expect(view.render(200)[1]).toBe("  Enter or Ctrl+Space: transcribe · Esc: discard (nothing is sent)");
    view.handleInput("enter");
    await running;
    expect(recording.stop).toHaveBeenCalledTimes(1);
    expect(ui.pasteToEditor).toHaveBeenCalledWith("hello world");
    expect(notices).toEqual([{
      message: "Recording stopped at the 5-minute limit; the captured part was transcribed.",
      type: "info",
    }]);
  });

  it("discards a clip after the recorder exits on its own without uploading", async () => {
    const { h, recording, transcribe } = setup();
    const { ctx, ui, notices, component } = tuiContext();
    const running = h.commands.get("xai-voice").handler("", ctx);
    const view = await component();
    recording.end("exited");
    await vi.waitFor(() => expect(view.render(200)[0]).toBe("Grok voice — The microphone recorder stopped"));
    view.handleInput("escape");
    await running;
    expect(transcribe).not.toHaveBeenCalled();
    expect(ui.pasteToEditor).not.toHaveBeenCalled();
    expect(notices).toEqual([{ message: "Discarded the recording; nothing was sent to xAI.", type: "info" }]);
  });

  it("reports the cap in RPC mode after the user chooses to transcribe", async () => {
    const recording = fakeRecording();
    const { h } = setup({ recording });
    const choice = deferred<string>();
    const { ctx, ui, notices } = rpcContext(undefined);
    ui.select.mockImplementation(() => choice.promise);
    const running = h.commands.get("xai-voice").handler("", ctx);
    await vi.waitFor(() => expect(ui.select).toHaveBeenCalled());
    recording.end("cap");
    await vi.waitFor(() => expect(recording.stop).toHaveBeenCalled());
    choice.resolve("Stop and transcribe");
    await running;
    expect(ui.setEditorText).toHaveBeenCalledWith("draft hello world");
    expect(notices).toEqual([{
      message: "Recording stopped at the 5-minute limit; the captured part was transcribed.",
      type: "info",
    }]);
  });

  it("uses a modal select in RPC mode and appends to the client editor", async () => {
    const { h, transcribe } = setup();
    const stop = rpcContext("Stop and transcribe");
    await h.commands.get("xai-voice").handler("", stop.ctx);
    expect(stop.ui.select).toHaveBeenCalledWith(
      "🎙 Grok voice is recording (English, up to 5:00)",
      ["Stop and transcribe", "Discard recording"],
    );
    expect(stop.ui.pasteToEditor).not.toHaveBeenCalled();
    expect(stop.ui.setEditorText).toHaveBeenCalledWith("draft hello world");
    expect(transcribe).toHaveBeenCalledTimes(1);

    const discard = rpcContext(undefined);
    await h.commands.get("xai-voice").handler("", discard.ctx);
    expect(discard.notices).toEqual([{ message: "Discarded the recording; nothing was sent to xAI.", type: "info" }]);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("falls back to setEditorText when the editor cannot be read", async () => {
    const { h } = setup();
    const { ctx, ui } = rpcContext("Stop and transcribe");
    ui.getEditorText.mockImplementation(() => {
      throw new Error("not available");
    });
    await h.commands.get("xai-voice").handler("", ctx);
    expect(ui.setEditorText).toHaveBeenCalledWith("hello world");
  });

  it("remembers the requested language for shortcuts until reset", async () => {
    const { h, controller, transcribe } = setup();
    const first = rpcContext("Stop and transcribe");
    await h.commands.get("xai-voice").handler("ES", first.ctx);
    const second = rpcContext("Stop and transcribe");
    await h.shortcuts.get("f8").handler(second.ctx);
    controller.reset();
    const third = rpcContext("Stop and transcribe");
    await h.shortcuts.get("ctrl+space").handler(third.ctx);
    expect(transcribe.mock.calls.map(([options]) => options.language)).toEqual(["es", "es", "en"]);
  });

  it("resolves auto from the system locale", async () => {
    const { h, transcribe } = setup({ locale: "pt_BR" });
    await h.commands.get("xai-voice").handler("auto", rpcContext("Stop and transcribe").ctx);
    expect(transcribe.mock.calls[0]![0].language).toBe("pt");
    expect(resolveXaiDictationLanguage("auto", "tl-PH")).toBe("fil");
    expect(resolveXaiDictationLanguage("auto", "zh-CN")).toBe("en");
    expect(resolveXaiDictationLanguage("auto", undefined)).toBe("en");
    expect(resolveXaiDictationLanguage("ja", "de-DE")).toBe("ja");
  });

  it("allows one dictation at a time and cancels it on reset", async () => {
    const { h, controller, recording, startRecording } = setup();
    const first = tuiContext();
    const running = h.commands.get("xai-voice").handler("", first.ctx);
    const view = await first.component();
    const second = tuiContext();
    await h.shortcuts.get("ctrl+space").handler(second.ctx);
    expect(second.notices).toEqual([{ message: "Grok voice is already recording.", type: "warning" }]);
    expect(startRecording).toHaveBeenCalledTimes(1);
    controller.reset();
    expect(recording.cancel).toHaveBeenCalledTimes(1);
    view.handleInput("escape");
    await running;
    expect(recording.stop).not.toHaveBeenCalled();
  });

  it("cancels the session when the overlay fails or is disposed early", async () => {
    const failing = setup();
    const { ctx, ui, notices } = tuiContext();
    ui.custom.mockImplementation(async () => {
      throw new Error("overlay failed");
    });
    await failing.h.commands.get("xai-voice").handler("", ctx);
    expect(failing.recording.cancel).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([{ message: "Grok voice stopped unexpectedly; nothing was inserted.", type: "error" }]);

    const disposed = setup();
    const view = tuiContext();
    const running = disposed.h.commands.get("xai-voice").handler("", view.ctx);
    const component = await view.component();
    component.dispose();
    expect(disposed.recording.cancel).toHaveBeenCalledTimes(1);
    component.handleInput("escape");
    await running;
  });

  it("shares one finish result and discards when cancelled while stopping", async () => {
    const stopping = deferred<Buffer>();
    const recording = { ...fakeRecording(), stop: vi.fn(() => stopping.promise) };
    const upload = vi.fn(async () => "text");
    const session = new XaiDictationSession(recording, "en", upload, () => 0);
    const first = session.finish();
    const second = session.finish();
    expect(second).toBe(first);
    expect(session.cancel()).toBe("discarded");
    stopping.resolve(speechPcm());
    await expect(first).resolves.toEqual({ kind: "discarded" });
    expect(upload).not.toHaveBeenCalled();
    expect(session.cancel()).toBe("cancelled");
    expect(await new XaiDictationSession(fakeRecording(Buffer.alloc(0)), "en", upload).finish())
      .toEqual({ kind: "silent" });
  });

  it("gives platform-specific microphone guidance", () => {
    expect(xaiMicrophoneHelp("darwin")).toMatch(/System Settings/);
    expect(xaiMicrophoneHelp("win32")).toMatch(/Privacy & security/);
    expect(xaiMicrophoneHelp("linux")).toMatch(/pavucontrol|wpctl/);
  });
});
