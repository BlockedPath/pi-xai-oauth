import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  downloadXaiVideo,
  isPublicVideoDownloadAddress,
} from "../../extensions/xai/video-download";
import { validateMp4Prefix } from "../../extensions/xai/media/video-info";
import { createTempDir } from "../fixtures/temp";

const PUBLIC_IPV4 = "93.184.216.34";
const downloadBase = {
  url: "https://cdn.example.test/video.mp4",
  outputRoot: process.cwd(),
  sessionRoot: process.cwd(),
  duration: 6 as const,
  resolution: "480p" as const,
};

function publicLookup() {
  return vi.fn(async () => [{ address: PUBLIC_IPV4, family: 4 }]) as any;
}

function httpsRequestMock(options: {
  statusCode?: number;
  headers?: Record<string, string | string[] | undefined>;
  chunks?: Buffer[];
  remoteAddress?: string;
} = {}) {
  return vi.fn((_requestOptions: unknown, callback: (res: any) => void) => {
    let errorHandler: ((error: Error) => void) | undefined;
    let socketHandler: ((socket: any) => void) | undefined;
    let destroyed = false;
    const req = {
      once(event: string, handler: (...args: any[]) => void) {
        if (event === "socket") socketHandler = handler;
        if (event === "error") errorHandler = handler;
        return this;
      },
      end() {
        queueMicrotask(() => {
          socketHandler?.({
            remoteAddress: options.remoteAddress ?? PUBLIC_IPV4,
            once(event: string, handler: () => void) {
              if (event === "secureConnect") {
                queueMicrotask(() => {
                  handler();
                  if (destroyed) return;
                  const chunks = options.chunks ?? [];
                  const response = new Readable({
                    read() {
                      for (const chunk of chunks) this.push(chunk);
                      this.push(null);
                    },
                  }) as any;
                  response.statusCode = options.statusCode ?? 200;
                  response.headers = options.headers ?? { "content-type": "video/mp4" };
                  callback(response);
                });
              }
              return this;
            },
          });
        });
      },
      destroy(error?: Error) {
        destroyed = true;
        if (error && errorHandler) queueMicrotask(() => errorHandler!(error));
      },
    };
    return req;
  });
}

describe("video download safety", () => {
  it("accepts public addresses and rejects special-use ranges", () => {
    expect(isPublicVideoDownloadAddress("93.184.216.34")).toBe(true);
    expect(isPublicVideoDownloadAddress("::ffff:93.184.216.34")).toBe(true);
    expect(isPublicVideoDownloadAddress("::93.184.216.34")).toBe(true);
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "198.18.0.1",
      "203.0.113.1",
      "0.0.0.0",
      "192.0.0.1",
      "198.51.100.1",
      "224.0.0.1",
      "::127.0.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
      "2606:2800:220:1:248:1893:25c8:1946",
      "::ffff:127.0.0.1",
    ]) expect(isPublicVideoDownloadAddress(address)).toBe(false);
  });

  it("validates bounded MP4 ftyp evidence", () => {
    const valid = Buffer.from([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
      0x69, 0x73, 0x6f, 0x32, 0x6d, 0x70, 0x34, 0x32,
    ]);
    expect(() => validateMp4Prefix(valid)).not.toThrow();
    expect(() => validateMp4Prefix(Buffer.alloc(24))).toThrow(/valid bounded MP4/);
    const badBrand = Buffer.from(valid);
    badBrand.write("nope", 8, "ascii");
    badBrand.write("bad!", 16, "ascii");
    badBrand.write("bad?", 20, "ascii");
    expect(() => validateMp4Prefix(badBrand)).toThrow(/unsupported MP4 brand/);
  });

  it("rejects unsafe URLs and mixed public/private DNS before HTTPS", async () => {
    const request = vi.fn();
    const base = {
      outputRoot: process.cwd(),
      sessionRoot: process.cwd(),
      duration: 6 as const,
      resolution: "480p" as const,
    };
    await expect(downloadXaiVideo({ ...base, url: "http://example.test/video.mp4" }))
      .rejects.toThrow(/failed safely/);
    await expect(downloadXaiVideo({ ...base, url: "https://cdn.example.test/video.mp4" }, {
      lookup: vi.fn(async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]) as any,
      request: request as any,
    })).rejects.toThrow(/failed safely/);
    expect(request).not.toHaveBeenCalled();
  });

  it("pins public IPv4 when dual-stack DNS also returns non-public IPv6", async () => {
    const request = vi.fn();
    await expect(downloadXaiVideo({
      url: "https://cdn.example.test/video.mp4",
      outputRoot: process.cwd(),
      sessionRoot: process.cwd(),
      duration: 6,
      resolution: "480p",
    }, {
      lookup: vi.fn(async () => [
        { address: "2606:4700::6812:1350", family: 6 },
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]) as any,
      request: request as any,
    })).rejects.toThrow(/failed safely/);
    expect(request).not.toHaveBeenCalled();

    // Mixed public IPv4 + IPv6 must not be rejected solely because IPv6 is non-public.
    // Request is issued with the public IPv4 pin; the mocked request never completes HTTPS.
    const dualStackRequest = vi.fn((_options: any, _callback: any) => {
      const req = {
        once(event: string, handler: (...args: any[]) => void) {
          if (event === "error") queueMicrotask(() => handler(new Error("boom")));
          return this;
        },
        end() {},
        destroy() {},
      };
      return req;
    });
    await expect(downloadXaiVideo({
      url: "https://cdn.example.test/video.mp4",
      outputRoot: process.cwd(),
      sessionRoot: process.cwd(),
      duration: 6,
      resolution: "480p",
    }, {
      lookup: vi.fn(async () => [
        { address: "2606:4700::6812:1350", family: 6 },
        { address: "93.184.216.34", family: 4 },
      ]) as any,
      request: dualStackRequest as any,
    })).rejects.toThrow(/failed safely/);
    expect(dualStackRequest).toHaveBeenCalled();
    const pinned = dualStackRequest.mock.calls[0][0];
    expect(pinned.lookup).toEqual(expect.any(Function));
    await new Promise<void>((resolve, reject) => {
      pinned.lookup("cdn.example.test", {}, (err: Error | null, address: string, family: number) => {
        try {
          expect(err).toBeNull();
          expect(address).toBe("93.184.216.34");
          expect(family).toBe(4);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      pinned.lookup("cdn.example.test", { all: true }, (err: Error | null, addresses: Array<{ address: string; family: number }>) => {
        try {
          expect(err).toBeNull();
          expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });

  it("cancels a stalled DNS lookup without issuing HTTPS", async () => {
    const controller = new AbortController();
    const request = vi.fn();
    const pending = downloadXaiVideo({
      url: "https://cdn.example.test/video.mp4",
      outputRoot: process.cwd(),
      sessionRoot: process.cwd(),
      duration: 6,
      resolution: "480p",
      signal: controller.signal,
    }, {
      lookup: vi.fn(() => new Promise(() => {})) as any,
      request: request as any,
      timeoutMs: 10_000,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects credentialed, hashed, IP, non-443, and oversized download URLs before DNS", async () => {
    const lookup = vi.fn();
    const request = vi.fn();
    const deps = { lookup: lookup as any, request: request as any };
    await expect(downloadXaiVideo({ ...downloadBase, url: "https://user:pass@cdn.example.test/video.mp4" }, deps))
      .rejects.toThrow(/failed safely/);
    await expect(downloadXaiVideo({ ...downloadBase, url: "https://cdn.example.test/video.mp4#frag" }, deps))
      .rejects.toThrow(/failed safely/);
    await expect(downloadXaiVideo({ ...downloadBase, url: "https://93.184.216.34/video.mp4" }, deps))
      .rejects.toThrow(/failed safely/);
    await expect(downloadXaiVideo({ ...downloadBase, url: "https://cdn.example.test:444/video.mp4" }, deps))
      .rejects.toThrow(/failed safely/);
    await expect(downloadXaiVideo({
      ...downloadBase,
      url: `https://cdn.example.test/${"a".repeat(9000)}.mp4`,
    }, deps)).rejects.toThrow(/failed safely/);
    expect(lookup).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects non-2xx, unsupported MIME, oversized Content-Length, and pinned-address mismatch", async () => {
    await expect(downloadXaiVideo(downloadBase, {
      lookup: publicLookup(),
      request: httpsRequestMock({ statusCode: 404 }) as any,
    })).rejects.toThrow(/failed safely/);

    await expect(downloadXaiVideo(downloadBase, {
      lookup: publicLookup(),
      request: httpsRequestMock({
        headers: { "content-type": ["text/html; charset=utf-8"] },
      }) as any,
    })).rejects.toThrow(/unsupported media type/);

    await expect(downloadXaiVideo(downloadBase, {
      lookup: publicLookup(),
      request: httpsRequestMock({
        headers: { "content-type": "video/mp4", "content-length": "64" },
      }) as any,
      maxBytes: 32,
    })).rejects.toThrow(/byte limit/);

    await expect(downloadXaiVideo(downloadBase, {
      lookup: publicLookup(),
      request: httpsRequestMock({ remoteAddress: "8.8.8.8" }) as any,
    })).rejects.toThrow(/failed safely/);
  });

  it("times out a stalled DNS lookup without a caller abort", async () => {
    const request = vi.fn();
    await expect(downloadXaiVideo(downloadBase, {
      lookup: vi.fn(() => new Promise(() => {})) as any,
      request: request as any,
      timeoutMs: 25,
    })).rejects.toThrow(/timed out/);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an empty MP4 body after a successful HTTPS handshake", async () => {
    const temp = await createTempDir("pi-xai-video-empty-");
    try {
      await expect(downloadXaiVideo({
        ...downloadBase,
        outputRoot: join(temp.path, "out"),
        sessionRoot: temp.path,
      }, {
        lookup: publicLookup(),
        request: httpsRequestMock({
          headers: { "content-type": "application/mp4" },
          chunks: [],
        }) as any,
        timeoutMs: 3_000,
      })).rejects.toThrow(/failed safely/);
    } finally {
      await temp.cleanup();
    }
  });
});
