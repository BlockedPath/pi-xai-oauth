import { XAI_DICTATION_SILENCE_PEAK, XAI_WAV_HEADER_BYTES } from "./constants";

/** Audio containers this package recognizes from their leading bytes. */
export type XaiAudioMimeType =
  | "audio/wav"
  | "audio/mpeg"
  | "audio/flac"
  | "audio/ogg"
  | "audio/mp4"
  | "audio/webm"
  | "audio/aac";

/** Upload filename extension for each recognized container. */
export const XAI_AUDIO_FILE_EXTENSIONS: Readonly<Record<XaiAudioMimeType, string>> = {
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "audio/aac": "aac",
};

function ascii(bytes: Uint8Array, start: number, text: string): boolean {
  if (bytes.length < start + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[start + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * Identify an audio container from its leading bytes, never from a file name.
 * Returns undefined for anything that is not a recognized audio container.
 */
export function sniffAudioMimeType(bytes: Uint8Array): XaiAudioMimeType | undefined {
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio/wav";
  if (ascii(bytes, 0, "fLaC")) return "audio/flac";
  if (ascii(bytes, 0, "OggS")) return "audio/ogg";
  if (ascii(bytes, 4, "ftyp")) return "audio/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "audio/webm";
  }
  if (ascii(bytes, 0, "ID3")) return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff) {
    const second = bytes[1] ?? 0;
    // ADTS AAC: 12-bit sync with the layer bits fixed at 00.
    if ((second & 0xf6) === 0xf0) return "audio/aac";
    // MPEG audio: 11-bit sync, a defined version, and a defined layer.
    const version = (second >> 3) & 0b11;
    const layer = (second >> 1) & 0b11;
    if ((second & 0xe0) === 0xe0 && version !== 0b01 && layer !== 0b00) return "audio/mpeg";
  }
  return undefined;
}

/**
 * Wrap little-endian PCM16 mono frames in a canonical 44-byte RIFF/WAVE
 * header. A trailing odd byte is dropped so the data chunk stays frame-aligned.
 */
export function encodePcm16MonoWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const dataLength = pcm.length & ~1;
  const output = Buffer.alloc(XAI_WAV_HEADER_BYTES + dataLength);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + dataLength, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(dataLength, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, dataLength).copy(output, XAI_WAV_HEADER_BYTES);
  return output;
}

/** Return the peak absolute PCM16 little-endian sample value. */
export function pcm16Peak(pcm: Uint8Array): number {
  let peak = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = ((pcm[offset] ?? 0) | ((pcm[offset + 1] ?? 0) << 8)) << 16 >> 16;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

/** Whether a PCM16 clip contains only silence, which is what a denied microphone grant records. */
export function isSilentPcm16(pcm: Uint8Array, threshold = XAI_DICTATION_SILENCE_PEAK): boolean {
  return pcm16Peak(pcm) <= threshold;
}
