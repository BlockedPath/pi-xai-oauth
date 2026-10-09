import { resolveXaiRoute, type XaiCredential } from "../routing";
import { xaiLiveSpeechHeaders } from "../wire";
import { XaiVoiceOperationError } from "./common";
import {
  XAI_TALK_CONNECT_TIMEOUT_MS,
  XAI_TALK_INPUT_TRANSCRIPTION_MODEL,
  XAI_TALK_MAX_AUDIO_DELTA_BYTES,
  XAI_TALK_MAX_BUFFERED_BYTES,
  XAI_TALK_MAX_LINE_CHARS,
  XAI_TALK_MAX_MESSAGE_BYTES,
  XAI_TALK_MODEL,
  XAI_TALK_SAMPLE_RATE,
  XAI_TALK_VAD_PREFIX_PADDING_MS,
  XAI_TALK_VAD_SILENCE_DURATION_MS,
  XAI_TALK_VAD_THRESHOLD,
  type XaiTtsVoice,
} from "./constants";
import type { XaiLiveSocket, XaiLiveSocketFactory } from "./live";

const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const BENIGN_ERROR_PATTERN = /no active response|already has an active response/i;

/** Callbacks for one realtime voice conversation. */
export interface XaiRealtimeHandlers {
  /** Grok's synthesized speech as PCM16LE mono at 24 kHz. */
  onAudio(pcm: Buffer, itemId?: string): void;
  /** Grok's spoken words; `final` text replaces the deltas for that reply and arrives once per reply. */
  onAssistantText(text: string, final: boolean): void;
  /**
   * Captions of the user's speech for one input item (`key`). xAI resends
   * cumulative snapshots of an utterance while it revises it, so `final`
   * text replaces that item's caption rather than starting a new turn.
   */
  onUserText(text: string, final: boolean, key?: string): void;
  /** Server VAD heard the user start speaking. */
  onSpeechStarted(): void;
  /** A response finished or was cancelled. */
  onResponseDone(): void;
  /** A non-fatal problem; the conversation continues. */
  onWarning(message: string): void;
  /** The connection ended; no further events follow. */
  onClose(reason: string | undefined): void;
}

/** A connected realtime voice conversation. */
export interface XaiRealtimeConversation {
  /** Whether Grok is generating a response. */
  readonly responseActive: boolean;
  /** Stream microphone PCM16LE mono at 24 kHz. */
  appendAudio(pcm: Buffer): void;
  /** Stop the response Grok is generating and drop any audio still arriving for it. */
  cancelResponse(): void;
  /** Trim Grok's last spoken item to what was actually heard. */
  truncate(itemId: string, audioEndMs: number): void;
  /** Close the conversation. */
  close(): void;
}

export interface XaiRealtimeOptions {
  credential: XaiCredential;
  voice: XaiTtsVoice;
  instructions: string;
  signal?: AbortSignal;
}

export interface XaiRealtimeDependencies {
  createSocket?: XaiLiveSocketFactory;
  connectTimeoutMs?: number;
  maxBufferedBytes?: number;
}

/** Build the pinned realtime URL for the Grok voice model. */
export function xaiRealtimeUrl(credential: XaiCredential, model = XAI_TALK_MODEL): string {
  const url = new URL(resolveXaiRoute(credential.kind, "realtime-voice").url);
  url.searchParams.set("model", model);
  return url.toString();
}

/** Build the session configuration: 24 kHz PCM both ways, server VAD, and input captions. */
export function buildXaiRealtimeSessionUpdate(voice: XaiTtsVoice, instructions: string): Record<string, unknown> {
  const format = { type: "audio/pcm", rate: XAI_TALK_SAMPLE_RATE };
  return {
    type: "session.update",
    session: {
      instructions,
      voice,
      output_modalities: ["audio"],
      turn_detection: {
        type: "server_vad",
        threshold: XAI_TALK_VAD_THRESHOLD,
        prefix_padding_ms: XAI_TALK_VAD_PREFIX_PADDING_MS,
        silence_duration_ms: XAI_TALK_VAD_SILENCE_DURATION_MS,
      },
      audio: {
        input: { format, transcription: { model: XAI_TALK_INPUT_TRANSCRIPTION_MODEL } },
        output: { format },
      },
    },
  };
}

function cleanText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(CONTROL_PATTERN, "").slice(0, XAI_TALK_MAX_LINE_CHARS)
    : "";
}

function decodeAudio(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    return undefined;
  }
  const audio = Buffer.from(value, "base64");
  return audio.length > 0 && audio.length <= XAI_TALK_MAX_AUDIO_DELTA_BYTES ? audio : undefined;
}

function defaultSocketFactory(): XaiLiveSocketFactory | undefined {
  const WebSocketImpl = (globalThis as any).WebSocket;
  if (typeof WebSocketImpl !== "function") return undefined;
  return (url, options) => new WebSocketImpl(url, options) as XaiLiveSocket;
}

/**
 * Open a Grok realtime voice conversation on the pinned
 * `wss://api.x.ai/v1/realtime` route with the OAuth (or API-key) bearer on
 * the WebSocket handshake, configure it, and resolve on `session.updated`.
 * xAI error text is never reflected; failures are fixed, safe messages.
 */
export async function connectXaiRealtime(
  options: XaiRealtimeOptions,
  handlers: XaiRealtimeHandlers,
  dependencies: XaiRealtimeDependencies = {},
): Promise<XaiRealtimeConversation> {
  const createSocket = dependencies.createSocket ?? defaultSocketFactory();
  if (!createSocket) {
    throw new XaiVoiceOperationError("This runtime has no WebSocket client for Grok voice chat.", "network_failure");
  }
  if (options.signal?.aborted) {
    throw new XaiVoiceOperationError("Grok voice chat was cancelled.", "cancelled");
  }
  const maxBuffered = dependencies.maxBufferedBytes ?? XAI_TALK_MAX_BUFFERED_BYTES;
  let socket: XaiLiveSocket;
  try {
    socket = createSocket(xaiRealtimeUrl(options.credential), {
      headers: xaiLiveSpeechHeaders(options.credential.token),
    });
    socket.binaryType = "arraybuffer";
  } catch {
    throw new XaiVoiceOperationError("Grok voice chat could not connect.", "network_failure");
  }

  let ready = false;
  let closed = false;
  let ended = false;
  let responseActive = false;
  // Tracked only once xAI announces responses with `response.created`.
  let response: "none" | "active" | "done" | "cancelled" = "none";
  let assistantFinal = false;
  let speechSequence = 0;
  let carry: Uint8Array | undefined;
  let settleReady: ((error?: XaiVoiceOperationError) => void) | undefined;

  const send = (event: unknown) => {
    if (closed) return;
    try {
      socket.send(JSON.stringify(event));
    } catch {
      end("The Grok voice chat connection failed.");
    }
  };
  const closeSocket = () => {
    if (closed) return;
    closed = true;
    try {
      socket.close(1000);
    } catch {
      // Teardown is best-effort.
    }
  };
  const end = (reason: string | undefined) => {
    closeSocket();
    if (ended || !ready) return;
    ended = true;
    handlers.onClose(reason);
  };
  const inputKey = (message: any): string =>
    typeof message.item_id === "string" && message.item_id
      ? message.item_id.slice(0, 128)
      : `speech-${speechSequence}`;

  socket.addEventListener("open", () => send(buildXaiRealtimeSessionUpdate(options.voice, options.instructions)));
  socket.addEventListener("message", (event: any) => {
    const data = event?.data;
    if (typeof data !== "string") return;
    if (Buffer.byteLength(data, "utf8") > XAI_TALK_MAX_MESSAGE_BYTES) {
      end("Grok voice chat received an oversized message.");
      return;
    }
    let message: any;
    try {
      message = JSON.parse(data);
    } catch {
      end("Grok voice chat received an invalid message.");
      return;
    }
    const type = typeof message?.type === "string" ? message.type : "";
    if (!ready) {
      if (type === "session.updated") {
        ready = true;
        settleReady?.();
      } else if (type === "error") {
        settleReady?.(new XaiVoiceOperationError(
          "xAI refused the Grok voice chat session. Check that this account includes Grok voice.",
          "http_failure",
        ));
      }
      return;
    }
    // A cancelled response is retired so an interrupt cannot replay its audio.
    // A finished one only drops late captions: its trailing audio still plays.
    if (
      (response === "cancelled" || (response === "done" && type !== "response.output_audio.delta"))
      && type.startsWith("response.")
      && type !== "response.created"
    ) return;
    switch (type) {
      case "response.created":
        response = "active";
        responseActive = true;
        assistantFinal = false;
        return;
      case "response.output_audio.delta": {
        const audio = decodeAudio(message.delta ?? message.data);
        if (!audio) {
          end("Grok voice chat received invalid audio.");
          return;
        }
        // Trailing audio of a finished reply does not reopen it.
        if (response !== "done") responseActive = true;
        handlers.onAudio(audio, typeof message.item_id === "string" ? message.item_id : undefined);
        return;
      }
      case "response.output_audio_transcript.delta":
      case "response.output_text.delta":
      case "response.text.delta": {
        const text = cleanText(message.delta);
        if (!text) return;
        assistantFinal = false;
        handlers.onAssistantText(text, false);
        return;
      }
      case "response.output_audio_transcript.done":
      case "response.output_text.done":
      case "response.text.done": {
        const text = cleanText(message.transcript ?? message.text);
        if (!text || assistantFinal) return;
        assistantFinal = true;
        handlers.onAssistantText(text, true);
        return;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const text = cleanText(message.delta);
        if (text) handlers.onUserText(text, false, inputKey(message));
        return;
      }
      case "conversation.item.input_audio_transcription.updated":
      case "conversation.item.input_audio_transcription.completed": {
        const text = cleanText(message.transcript);
        if (text) handlers.onUserText(text, true, inputKey(message));
        return;
      }
      case "input_audio_buffer.speech_started":
        speechSequence += 1;
        handlers.onSpeechStarted();
        return;
      case "response.done":
        responseActive = false;
        assistantFinal = false;
        if (response === "active") response = "done";
        handlers.onResponseDone();
        return;
      case "error": {
        const detail = typeof message.error?.message === "string" ? message.error.message : "";
        // Racing cancels are expected and harmless; never reflect other detail.
        if (!BENIGN_ERROR_PATTERN.test(detail)) handlers.onWarning("xAI reported a Grok voice chat error.");
        return;
      }
      default:
        return;
    }
  });
  socket.addEventListener("error", () => {
    settleReady?.(new XaiVoiceOperationError("Grok voice chat could not connect.", "network_failure"));
    end("The Grok voice chat connection failed.");
  });
  socket.addEventListener("close", () => {
    closed = true;
    settleReady?.(new XaiVoiceOperationError("Grok voice chat could not connect.", "network_failure"));
    end(undefined);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      settle(new XaiVoiceOperationError("Grok voice chat timed out while connecting.", "timeout"));
    }, dependencies.connectTimeoutMs ?? XAI_TALK_CONNECT_TIMEOUT_MS);
    const onAbort = () => settle(new XaiVoiceOperationError("Grok voice chat was cancelled.", "cancelled"));
    function settle(error?: XaiVoiceOperationError) {
      if (!settleReady) return;
      settleReady = undefined;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) {
        closeSocket();
        reject(error);
      } else {
        resolve();
      }
    }
    settleReady = settle;
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });

  return {
    get responseActive() {
      return responseActive;
    },
    appendAudio(pcm) {
      if (closed || pcm.length === 0) return;
      let bytes: Uint8Array = pcm;
      if (carry) {
        bytes = Buffer.concat([carry, pcm]);
        carry = undefined;
      }
      if (bytes.length % 2 === 1) {
        carry = bytes.subarray(bytes.length - 1);
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (bytes.length === 0) return;
      if (socket.bufferedAmount > maxBuffered) {
        end("The Grok voice chat connection stalled.");
        return;
      }
      send({ type: "input_audio_buffer.append", audio: Buffer.from(bytes).toString("base64") });
    },
    cancelResponse() {
      // Interrupting a finished reply that is still playing drops its trailing audio.
      if (response === "done") response = "cancelled";
      if (!responseActive) return;
      responseActive = false;
      if (response === "active") response = "cancelled";
      send({ type: "response.cancel" });
    },
    truncate(itemId, audioEndMs) {
      send({
        type: "conversation.item.truncate",
        item_id: itemId,
        content_index: 0,
        audio_end_ms: Math.max(0, Math.floor(audioEndMs)),
      });
    },
    close() {
      ended = true;
      closeSocket();
    },
  };
}
