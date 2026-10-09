import { encodePcm16MonoWav } from "../../extensions/xai/voice/audio";

/** One loud PCM16 mono tone burst at 16 kHz. */
export function speechPcm(samples = 1_600): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin(index / 4) * 12_000), index * 2);
  }
  return pcm;
}

/** A small valid WAV clip. */
export function wavBytes(): Buffer {
  return encodePcm16MonoWav(speechPcm(160), 16_000);
}

/** A minimal MPEG-1 Layer III frame-shaped buffer behind an ID3 tag. */
export function mp3Bytes(): Buffer {
  return Buffer.concat([
    Buffer.from("ID3\x04\0\0\0\0\0\0", "latin1"),
    Buffer.from([0xff, 0xfb, 0x90, 0x64]),
    Buffer.alloc(32),
  ]);
}

/** A binary audio response fixture. */
export function audioResponse(
  body: Uint8Array,
  contentType = "audio/mpeg",
  status = 200,
): Response {
  return new Response(new Uint8Array(body), {
    status,
    headers: { "Content-Type": contentType },
  });
}
