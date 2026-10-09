import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";

/** An in-memory WebSocket double that records sends and lets tests emit events. */
export class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "blob";
  sent: Array<string | Uint8Array> = [];
  closes: Array<number | undefined> = [];
  throwOnSend = false;
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  constructor(readonly url: string, readonly options: { headers: Record<string, string> }) {}

  addEventListener(type: string, listener: (event: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  emit(type: string, event: any = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  message(value: unknown) {
    this.emit("message", { data: typeof value === "string" ? value : JSON.stringify(value) });
  }

  send(data: string | Uint8Array) {
    if (this.throwOnSend) throw new Error("socket closed with secret oauth-token");
    this.sent.push(data);
  }

  close(code?: number) {
    this.closes.push(code);
  }

  /** Parsed JSON text frames sent by the client. */
  json(): any[] {
    return this.sent.filter((item): item is string => typeof item === "string").map((item) => JSON.parse(item));
  }
}

export interface FakeWsConnection {
  request: IncomingMessage;
  sendText(text: string): void;
  close(): void;
}

/**
 * Start a minimal RFC 6455 server on 127.0.0.1 that completes the handshake,
 * decodes masked client frames, and lets the test reply with text frames.
 */
export async function startFakeWsServer(onConnection: (
  connection: FakeWsConnection,
  onFrame: (handler: (opcode: number, payload: Buffer) => void) => void,
) => void) {
  const sockets: Socket[] = [];
  const server = createServer();
  server.on("upgrade", (request, socket: Socket) => {
    sockets.push(socket);
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let frameHandler: (opcode: number, payload: Buffer) => void = () => undefined;
    const connection: FakeWsConnection = {
      request,
      sendText(text) {
        const payload = Buffer.from(text);
        const header = payload.length < 126
          ? Buffer.from([0x81, payload.length])
          : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
        socket.write(Buffer.concat([header, payload]));
      },
      close() {
        socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
        socket.end();
      },
    };
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0]! & 0x0f;
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let index = 0; index < payload.length; index += 1) payload[index]! ^= mask[index % 4]!;
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 0x8) {
          socket.end();
          return;
        }
        frameHandler(opcode, payload);
      }
    });
    onConnection(connection, (handler) => {
      frameHandler = handler;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
