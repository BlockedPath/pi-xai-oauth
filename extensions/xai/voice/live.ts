import { resolveXaiRoute, type XaiCredential } from "../routing";
import { xaiLiveSpeechHeaders } from "../wire";
import { XaiVoiceOperationError } from "./common";
import {
  XAI_DICTATION_SAMPLE_RATE,
  XAI_LIVE_STT_CONNECT_TIMEOUT_MS,
  XAI_LIVE_STT_ENDPOINTING_MS,
  XAI_LIVE_STT_FINISH_TIMEOUT_MS,
  XAI_LIVE_STT_MAX_BUFFERED_BYTES,
  XAI_LIVE_STT_MAX_MESSAGE_BYTES,
  XAI_STT_MAX_TRANSCRIPT_CHARS,
  type XaiSttLanguage,
} from "./constants";

// Strip C0/C1 controls so live text can never carry terminal escape sequences.
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

/** Minimal WebSocket surface used here; Node's undici and Bun both accept handshake headers. */
export interface XaiLiveSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export type XaiLiveSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => XaiLiveSocket;

export interface LiveTranscriptionDependencies {
  createSocket?: XaiLiveSocketFactory;
  connectTimeoutMs?: number;
  finishTimeoutMs?: number;
  maxBufferedBytes?: number;
}

/** A live speech-to-text stream that accepts PCM and assembles the transcript as xAI recognizes it. */
export interface XaiLiveTranscription {
  /** Forward PCM16LE mono audio; ignored once the stream has failed or is finishing. */
  send(chunk: Uint8Array): void;
  /** Committed utterances plus the current interim words. */
  preview(): string;
  /** A safe reason when the live stream can no longer be used. */
  failure(): string | undefined;
  /** Signal the end of audio and resolve with the final transcript. */
  finish(signal?: AbortSignal): Promise<string>;
  /** Close the stream without waiting for a transcript. */
  close(): void;
}

function defaultSocketFactory(): XaiLiveSocketFactory | undefined {
  const WebSocketImpl = (globalThis as any).WebSocket;
  if (typeof WebSocketImpl !== "function") return undefined;
  return (url, options) => new WebSocketImpl(url, options) as XaiLiveSocket;
}

function clean(text: unknown): string {
  return typeof text === "string" ? text.replace(CONTROL_PATTERN, " ").replace(/\s+/g, " ").trim() : "";
}

function comparable(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Combine committed utterances with the `transcript.done` text without
 * duplicating or dropping words. Grok Build treats `done` as the final
 * utterance, while other clients treat it as the whole session, so a `done`
 * that already contains the committed text replaces it and one that repeats
 * the last utterance is ignored.
 */
export function mergeXaiLiveTranscript(committed: readonly string[], pending: string, done: string): string {
  const committedText = committed.join(" ");
  if (!done) return [committedText, pending].filter(Boolean).join(" ");
  if (!committedText) return done;
  const doneComparable = comparable(done);
  const committedComparable = comparable(committedText);
  if (doneComparable.includes(committedComparable)) return done;
  if (committedComparable.endsWith(doneComparable)) return committedText;
  return `${committedText} ${done}`;
}

/** Build the pinned live speech-to-text socket URL with Grok Build's query contract. */
export function xaiLiveTranscriptionUrl(
  credential: XaiCredential,
  language: XaiSttLanguage,
  sampleRate = XAI_DICTATION_SAMPLE_RATE,
): string {
  const url = new URL(resolveXaiRoute(credential.kind, "speech-to-text-stream").url);
  url.searchParams.set("sample_rate", String(sampleRate));
  url.searchParams.set("encoding", "pcm");
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("language", language);
  url.searchParams.set("endpointing", String(XAI_LIVE_STT_ENDPOINTING_MS));
  return url.toString();
}

/**
 * Open a live speech-to-text stream to the pinned `wss://api.x.ai/v1/stt`
 * route, authorizing the WebSocket handshake with the OAuth or API-key
 * bearer, and resolve once xAI reports `transcript.created`.
 */
export async function connectXaiLiveTranscription(options: {
  credential: XaiCredential;
  language: XaiSttLanguage;
  sampleRate?: number;
  signal?: AbortSignal;
}, dependencies: LiveTranscriptionDependencies = {}): Promise<XaiLiveTranscription> {
  const createSocket = dependencies.createSocket ?? defaultSocketFactory();
  if (!createSocket) {
    throw new XaiVoiceOperationError("This runtime has no WebSocket client for live transcription.", "network_failure");
  }
  if (options.signal?.aborted) {
    throw new XaiVoiceOperationError("xAI live transcription was cancelled.", "cancelled");
  }
  const maxBuffered = dependencies.maxBufferedBytes ?? XAI_LIVE_STT_MAX_BUFFERED_BYTES;
  let socket: XaiLiveSocket;
  try {
    socket = createSocket(xaiLiveTranscriptionUrl(options.credential, options.language, options.sampleRate), {
      headers: xaiLiveSpeechHeaders(options.credential.token),
    });
    socket.binaryType = "arraybuffer";
  } catch {
    throw new XaiVoiceOperationError("xAI live transcription could not connect.", "network_failure");
  }

  const finals: string[] = [];
  let locked = "";
  let interim = "";
  let doneText: string | undefined;
  let failure: string | undefined;
  let ready = false;
  let finishing = false;
  let closed = false;
  let carry: Uint8Array | undefined;
  let settleReady: ((error?: XaiVoiceOperationError) => void) | undefined;
  let settleFinish: (() => void) | undefined;

  const transcriptLength = () => finals.reduce((total, text) => total + text.length + 1, 0) + locked.length + interim.length;
  const fail = (reason: string) => {
    failure ??= reason;
    closeSocket();
    settleFinish?.();
  };
  const closeSocket = () => {
    if (closed) return;
    closed = true;
    try {
      socket.close(1000);
    } catch {
      // The socket may already be closing; teardown stays best-effort.
    }
  };

  socket.addEventListener("message", (event: any) => {
    const data = event?.data;
    if (typeof data !== "string") return;
    if (Buffer.byteLength(data, "utf8") > XAI_LIVE_STT_MAX_MESSAGE_BYTES) {
      fail("xAI live transcription sent an oversized message.");
      return;
    }
    let message: any;
    try {
      message = JSON.parse(data);
    } catch {
      fail("xAI live transcription sent an invalid message.");
      return;
    }
    switch (message?.type) {
      case "transcript.created":
        ready = true;
        settleReady?.();
        return;
      case "transcript.partial": {
        const text = clean(message.text);
        if (!text || transcriptLength() + text.length > XAI_STT_MAX_TRANSCRIPT_CHARS) return;
        if (message.speech_final === true) {
          finals.push(text);
          locked = "";
          interim = "";
        } else if (message.is_final === true) {
          locked = locked ? `${locked} ${text}` : text;
          interim = "";
        } else {
          interim = text;
        }
        return;
      }
      case "transcript.done":
        doneText = clean(message.text).slice(0, XAI_STT_MAX_TRANSCRIPT_CHARS);
        settleFinish?.();
        return;
      case "error":
        // xAI's error text is not reflected; the clip can still be uploaded.
        fail("xAI live transcription reported an error.");
        settleReady?.(new XaiVoiceOperationError("xAI live transcription reported an error.", "http_failure"));
        return;
      default:
        return;
    }
  });
  socket.addEventListener("error", () => {
    fail("The xAI live transcription connection failed.");
    settleReady?.(new XaiVoiceOperationError("xAI live transcription could not connect.", "network_failure"));
  });
  socket.addEventListener("close", () => {
    closed = true;
    if (!finishing && doneText === undefined) failure ??= "The xAI live transcription connection closed.";
    settleReady?.(new XaiVoiceOperationError("xAI live transcription could not connect.", "network_failure"));
    settleFinish?.();
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      settle(new XaiVoiceOperationError("xAI live transcription timed out while connecting.", "timeout"));
    }, dependencies.connectTimeoutMs ?? XAI_LIVE_STT_CONNECT_TIMEOUT_MS);
    const onAbort = () => settle(new XaiVoiceOperationError("xAI live transcription was cancelled.", "cancelled"));
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
    if (ready) settle();
  });

  return {
    send(chunk) {
      if (failure || finishing || closed || chunk.length === 0) return;
      let bytes = chunk;
      if (carry) {
        bytes = Buffer.concat([carry, chunk]);
        carry = undefined;
      }
      if (bytes.length % 2 === 1) {
        carry = bytes.subarray(bytes.length - 1);
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (bytes.length === 0) return;
      if (socket.bufferedAmount > maxBuffered) {
        fail("The xAI live transcription connection stalled.");
        return;
      }
      try {
        socket.send(bytes);
      } catch {
        fail("The xAI live transcription connection failed.");
      }
    },
    preview() {
      return [...finals, locked, interim].filter(Boolean).join(" ");
    },
    failure: () => failure,
    async finish(signal) {
      if (failure) throw new XaiVoiceOperationError(failure, "network_failure");
      finishing = true;
      carry = undefined;
      if (!closed && doneText === undefined) {
        try {
          socket.send(JSON.stringify({ type: "audio.done" }));
        } catch {
          failure ??= "The xAI live transcription connection failed.";
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, dependencies.finishTimeoutMs ?? XAI_LIVE_STT_FINISH_TIMEOUT_MS);
          signal?.addEventListener("abort", done, { once: true });
          function done() {
            settleFinish = undefined;
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
          }
          settleFinish = done;
          if (closed || doneText !== undefined || failure) done();
        });
      }
      closeSocket();
      if (signal?.aborted) throw new XaiVoiceOperationError("xAI live transcription was cancelled.", "cancelled");
      // A failed stream may have lost audio; the caller uploads the whole clip instead.
      if (failure) throw new XaiVoiceOperationError(failure, "network_failure");
      const text = mergeXaiLiveTranscript(finals, [locked, interim].filter(Boolean).join(" "), doneText ?? "");
      if (!text && doneText === undefined) {
        throw new XaiVoiceOperationError("xAI live transcription ended without a transcript.", "timeout");
      }
      return text;
    },
    close: closeSocket,
  };
}
