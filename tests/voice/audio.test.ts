import { describe, expect, it } from "vitest";
import {
  encodePcm16MonoWav,
  isSilentPcm16,
  pcm16Peak,
  sniffAudioMimeType,
} from "../../extensions/xai/voice/audio";
import { mp3Bytes, wavBytes } from "../fixtures/audio";

describe("Grok voice audio primitives", () => {
  it.each([
    ["audio/wav", wavBytes()],
    ["audio/mpeg", mp3Bytes()],
    ["audio/mpeg", Buffer.from([0xff, 0xf3, 0x84, 0xc4])],
    ["audio/mpeg", Buffer.from([0xff, 0xe3, 0x18, 0xc4])],
    ["audio/aac", Buffer.from([0xff, 0xf1, 0x50, 0x80])],
    ["audio/aac", Buffer.from([0xff, 0xf9, 0x50, 0x80])],
    ["audio/flac", Buffer.from("fLaC\0\0\0\x22", "latin1")],
    ["audio/ogg", Buffer.from("OggS\0\x02", "latin1")],
    ["audio/mp4", Buffer.from("\0\0\0\x20ftypM4A ", "latin1")],
    ["audio/webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f])],
  ])("recognizes %s from leading bytes", (mimeType, bytes) => {
    expect(sniffAudioMimeType(bytes)).toBe(mimeType);
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["text", Buffer.from("SECRET=value\n")],
    ["JSON", Buffer.from('{"error":"nope"}')],
    ["PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["RIFF that is not WAVE", Buffer.from("RIFF\0\0\0\0AVI ", "latin1")],
    ["reserved MPEG version", Buffer.from([0xff, 0xea, 0x90, 0x00])],
    ["reserved MPEG layer", Buffer.from([0xff, 0xe1, 0x90, 0x00])],
    ["truncated sync", Buffer.from([0xff])],
  ])("rejects %s bytes", (_name, bytes) => {
    expect(sniffAudioMimeType(bytes)).toBeUndefined();
  });

  it("writes Grok Build's canonical PCM16 mono WAV header", () => {
    const pcm = Buffer.from([0x01, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x00, 0x00]);
    const wav = encodePcm16MonoWav(pcm, 16_000);
    expect([...wav.subarray(0, 44)]).toEqual([
      0x52, 0x49, 0x46, 0x46, 44, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 1, 0,
      0x80, 0x3e, 0, 0, 0x00, 0x7d, 0, 0, 2, 0, 16, 0,
      0x64, 0x61, 0x74, 0x61, 8, 0, 0, 0,
    ]);
    expect(wav.subarray(44)).toEqual(pcm);
    expect(sniffAudioMimeType(wav)).toBe("audio/wav");
  });

  it("drops a trailing half sample and handles an empty clip", () => {
    const odd = encodePcm16MonoWav(Buffer.from([1, 2, 3]), 8_000);
    expect(odd.length).toBe(46);
    expect(odd.readUInt32LE(40)).toBe(2);
    expect(odd.subarray(44)).toEqual(Buffer.from([1, 2]));
    const empty = encodePcm16MonoWav(Buffer.alloc(0), 16_000);
    expect(empty.length).toBe(44);
    expect(empty.readUInt32LE(4)).toBe(36);
  });

  it("measures signed peaks and treats near-zero clips as silence", () => {
    expect(pcm16Peak(Buffer.from([0x00, 0x80]))).toBe(32_768);
    expect(pcm16Peak(Buffer.from([0xff, 0x7f, 0x01]))).toBe(32_767);
    expect(isSilentPcm16(Buffer.alloc(32_000))).toBe(true);
    const quiet = Buffer.alloc(8);
    quiet.writeInt16LE(-64, 2);
    expect(isSilentPcm16(quiet)).toBe(true);
    quiet.writeInt16LE(65, 4);
    expect(isSilentPcm16(quiet)).toBe(false);
  });
});
