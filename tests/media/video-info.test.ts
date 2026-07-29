import { describe, expect, it } from "vitest";
import { IMAGE_TO_VIDEO_MP4_PREFIX_BYTES } from "../../extensions/xai/media/constants";
import { Mp4StreamInspector, validateMp4Prefix } from "../../extensions/xai/media/video-info";

function box(type: string, payload: Buffer = Buffer.alloc(0), size = 8 + payload.length): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(size, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function extendedBox(type: string, payload: Buffer = Buffer.alloc(0), largeSize = BigInt(16 + payload.length)): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, "ascii");
  header.writeBigUInt64BE(largeSize, 8);
  return Buffer.concat([header, payload]);
}

function ftyp(major: string, compatible: string[] = [], options: { extended?: boolean } = {}): Buffer {
  const payload = Buffer.concat([
    Buffer.from(major, "ascii"),
    Buffer.alloc(4),
    ...compatible.map((brand) => Buffer.from(brand, "ascii")),
  ]);
  return options.extended ? extendedBox("ftyp", payload) : box("ftyp", payload);
}

function pushAll(inspector: Mp4StreamInspector, buffer: Buffer, chunkSize: number): void {
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    inspector.push(buffer.subarray(offset, offset + chunkSize));
  }
}

describe("bounded MP4 prefix validation", () => {
  it("accepts a major brand and a later compatible brand", () => {
    expect(() => validateMp4Prefix(ftyp("isom"))).not.toThrow();
    expect(() => validateMp4Prefix(ftyp("qt  ", ["mp42"]))).not.toThrow();
    expect(() => validateMp4Prefix(ftyp("isom", [], { extended: true }))).not.toThrow();
  });

  it("rejects short, non-ftyp, and truncated extended prefixes", () => {
    expect(() => validateMp4Prefix(Buffer.alloc(15))).toThrow(/valid bounded MP4/);
    expect(() => validateMp4Prefix(box("moov", Buffer.alloc(16)))).toThrow(/valid bounded MP4/);
    const truncatedExtended = ftyp("isom", [], { extended: true }).subarray(0, 20);
    expect(() => validateMp4Prefix(truncatedExtended)).toThrow(/valid bounded MP4/);
  });

  it("rejects declared sizes outside the bounded window", () => {
    const undersized = Buffer.concat([box("ftyp", Buffer.alloc(12), 12), Buffer.alloc(8)]);
    expect(() => validateMp4Prefix(undersized)).toThrow(/valid bounded MP4/);
    const oversized = box("ftyp", Buffer.alloc(24), IMAGE_TO_VIDEO_MP4_PREFIX_BYTES + 1);
    expect(() => validateMp4Prefix(oversized)).toThrow(/valid bounded MP4/);
    const beyondPrefix = box("ftyp", Buffer.alloc(12), 64);
    expect(() => validateMp4Prefix(beyondPrefix)).toThrow(/valid bounded MP4/);
  });

  it("rejects unsupported brands", () => {
    expect(() => validateMp4Prefix(ftyp("qt  ", ["wmv3"]))).toThrow(/unsupported MP4 brand/);
  });
});

describe("MP4 stream inspection", () => {
  it("accepts moov and mdat boxes across arbitrary chunk boundaries", () => {
    const stream = Buffer.concat([
      ftyp("isom"),
      box("moov", Buffer.alloc(24, 1)),
      box("mdat", Buffer.alloc(40, 2)),
    ]);
    for (const chunkSize of [1, 3, 7, stream.length]) {
      const inspector = new Mp4StreamInspector();
      pushAll(inspector, stream, chunkSize);
      expect(() => inspector.finish()).not.toThrow();
    }
  });

  it("accepts extended-size media boxes", () => {
    const inspector = new Mp4StreamInspector();
    pushAll(inspector, Buffer.concat([
      extendedBox("moov", Buffer.alloc(16, 1)),
      extendedBox("mdat", Buffer.alloc(32, 2)),
    ]), 5);
    expect(() => inspector.finish()).not.toThrow();
  });

  it("stops consuming after an open-ended mdat box", () => {
    const inspector = new Mp4StreamInspector();
    inspector.push(Buffer.concat([box("moov"), box("mdat", Buffer.alloc(0), 0), Buffer.from("trailing bytes")]));
    inspector.push(Buffer.from("more trailing bytes"));
    expect(() => inspector.finish()).not.toThrow();
  });

  it("rejects malformed box sizes", () => {
    expect(() => new Mp4StreamInspector().push(box("moov", Buffer.alloc(0), 4)))
      .toThrow(/malformed MP4 box structure/);
    expect(() => new Mp4StreamInspector().push(box("moov", Buffer.alloc(0), 0)))
      .toThrow(/malformed MP4 box structure/);
    expect(() => new Mp4StreamInspector().push(extendedBox("mdat", Buffer.alloc(0), 8n)))
      .toThrow(/malformed MP4 box structure/);
    expect(() => new Mp4StreamInspector().push(extendedBox("mdat", Buffer.alloc(0), BigInt(Number.MAX_SAFE_INTEGER) + 1n)))
      .toThrow(/malformed MP4 box structure/);
  });

  it("requires complete moov and mdat structure at the end of the stream", () => {
    const missingMdat = new Mp4StreamInspector();
    missingMdat.push(box("moov", Buffer.alloc(8)));
    expect(() => missingMdat.finish()).toThrow(/required MP4 movie\/media structure/);

    const missingMoov = new Mp4StreamInspector();
    missingMoov.push(box("mdat", Buffer.alloc(8)));
    expect(() => missingMoov.finish()).toThrow(/required MP4 movie\/media structure/);

    const partialHeader = new Mp4StreamInspector();
    partialHeader.push(Buffer.concat([box("moov"), box("mdat")]).subarray(0, 12));
    expect(() => partialHeader.finish()).toThrow(/required MP4 movie\/media structure/);

    const truncatedPayload = new Mp4StreamInspector();
    truncatedPayload.push(Buffer.concat([box("moov"), box("mdat", Buffer.alloc(16))]).subarray(0, 20));
    expect(() => truncatedPayload.finish()).toThrow(/required MP4 movie\/media structure/);

    const pendingExtendedType = new Mp4StreamInspector();
    pendingExtendedType.push(Buffer.concat([box("moov"), extendedBox("mdat")]).subarray(0, 16));
    expect(() => pendingExtendedType.finish()).toThrow(/required MP4 movie\/media structure/);
  });
});
