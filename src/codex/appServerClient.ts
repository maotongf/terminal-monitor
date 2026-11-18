import * as crypto from 'node:crypto';
import * as net from 'node:net';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

type JsonObject = Record<string, unknown>;

/** A small WebSocket JSON-RPC client for Codex's local Unix control socket. */
export class AppServerClient {
  private socket?: net.Socket;
  private opening?: Promise<void>;
  private upgraded = false;
  private initialized = false;
  private initializePromise?: Promise<void>;
  private handshakeBuffer = Buffer.alloc(0);
  private frameBuffer = Buffer.alloc(0);
  private fragmentOpcode?: number;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private disposed = false;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  constructor(private readonly socketPath: string, private readonly clientVersion: string) {}

  async request<T>(method: string, params: JsonObject): Promise<T> {
    await this.ensureInitialized();
    return this.requestRaw<T>(method, params);
  }

  dispose(): void {
    this.disposed = true;
    const socket = this.socket;
    this.socket = undefined;
    this.initialized = false;
    this.upgraded = false;
    socket?.destroy();
    this.rejectPending(new Error('Codex App Server connection closed.'));
  }

  private async ensureInitialized(): Promise<void> {
    await this.connect();
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = (async () => {
      await this.requestRaw('initialize', {
        clientInfo: {
          name: 'terminal_monitor',
          title: 'Terminal Monitor',
          version: this.clientVersion
        },
        capabilities: { experimentalApi: true }
      });
      this.sendMessage({ method: 'initialized', params: {} });
      this.initialized = true;
    })();

    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = undefined;
    }
  }

  private async connect(): Promise<void> {
    if (this.disposed) throw new Error('Codex App Server client disposed.');
    if (this.socket && this.upgraded) return;
    if (this.opening) return this.opening;

    this.opening = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      this.socket = socket;
      socket.setNoDelay(true);
      let settled = false;
      let key = '';
      const openTimer = setTimeout(() => {
        fail(new Error('Codex App Server socket handshake timed out.'));
        socket.destroy();
      }, 5000);

      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(openTimer);
          reject(error);
        }
        this.handleDisconnect(socket, error);
      };

      socket.on('connect', () => {
        key = crypto.randomBytes(16).toString('base64');
        socket.write(
          `GET / HTTP/1.1\r\n` +
          `Host: localhost\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`
        );
      });

      socket.on('data', chunk => {
        if (!this.upgraded) {
          this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
          const boundary = this.handshakeBuffer.indexOf('\r\n\r\n');
          if ((boundary < 0 && this.handshakeBuffer.length > 16384) || boundary > 16384) {
            fail(new Error('Codex App Server handshake exceeded the size limit.'));
            socket.destroy();
            return;
          }
          if (boundary < 0) return;

          const headers = this.handshakeBuffer.subarray(0, boundary).toString('ascii');
          const remainder = this.handshakeBuffer.subarray(boundary + 4);
          this.handshakeBuffer = Buffer.alloc(0);
          const expected = crypto.createHash('sha1')
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64');
          const accept = headers.match(/\r\nsec-websocket-accept:\s*([^\r\n]+)/i)?.[1]?.trim();
          if (!/^HTTP\/1\.1 101\b/.test(headers) || accept !== expected) {
            fail(new Error('Codex App Server rejected the local socket connection.'));
            socket.destroy();
            return;
          }

          this.upgraded = true;
          clearTimeout(openTimer);
          if (!settled) {
            settled = true;
            resolve();
          }
          if (remainder.length) this.consumeFrames(remainder);
          return;
        }
        this.consumeFrames(chunk);
      });

      socket.on('error', error => fail(error));
      socket.on('close', () => fail(new Error('Codex App Server socket closed.')));
    });

    try {
      await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  private requestRaw<T>(method: string, params: JsonObject): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}.`));
      }, 7000);
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timeout
      });
      try {
        this.sendMessage({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendMessage(message: JsonObject): void {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(message), 'utf8'));
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    const socket = this.socket;
    if (!socket || socket.destroyed || !this.upgraded) {
      throw new Error('Codex App Server is disconnected.');
    }

    const mask = crypto.randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    const masked = Buffer.allocUnsafe(payload.length);
    for (let index = 0; index < payload.length; index++) {
      masked[index] = payload[index] ^ mask[index % 4];
    }
    socket.write(Buffer.concat([header, mask, masked]));
  }

  private consumeFrames(chunk: Buffer): void {
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    while (this.frameBuffer.length >= 2) {
      const first = this.frameBuffer[0];
      const second = this.frameBuffer[1];
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.frameBuffer.length < 4) return;
        length = this.frameBuffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.frameBuffer.length < 10) return;
        const extendedLength = this.frameBuffer.readBigUInt64BE(2);
        if (extendedLength > 8n * 1024n * 1024n) {
          const socket = this.socket;
          this.handleDisconnect(socket, new Error('Codex App Server frame exceeded the size limit.'));
          socket?.destroy();
          return;
        }
        length = Number(extendedLength);
        offset = 10;
      }
      if (length > 8 * 1024 * 1024) {
        const socket = this.socket;
        this.handleDisconnect(socket, new Error('Codex App Server frame exceeded the size limit.'));
        socket?.destroy();
        return;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.frameBuffer.length < offset + length) return;

      let payload = this.frameBuffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.frameBuffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((value, index) => value ^ mask[index % 4]));
      }
      this.frameBuffer = this.frameBuffer.subarray(offset + length);

      if (opcode === 0x8) {
        this.socket?.end();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0xA, payload);
        continue;
      }
      if (opcode === 0xA) continue;

      if (opcode === 0x0) {
        if (this.fragmentOpcode === undefined) continue;
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > 8 * 1024 * 1024) {
          const socket = this.socket;
          this.handleDisconnect(socket, new Error('Codex App Server message exceeded the size limit.'));
          socket?.destroy();
          return;
        }
        this.fragments.push(payload);
        if (final) {
          const complete = Buffer.concat(this.fragments);
          const originalOpcode = this.fragmentOpcode;
          this.fragments = [];
          this.fragmentBytes = 0;
          this.fragmentOpcode = undefined;
          if (originalOpcode === 0x1) this.handleText(complete);
        }
        continue;
      }
      if (opcode === 0x1 && !final) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
      } else if (opcode === 0x1) {
        this.handleText(payload);
      }
    }
  }

  private handleText(payload: Buffer): void {
    let message: JsonObject;
    try {
      const parsed = JSON.parse(payload.toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object') return;
      message = parsed as JsonObject;
    } catch {
      return;
    }

    const id = message.id;
    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (message.error && typeof message.error === 'object') {
      const error = message.error as JsonObject;
      pending.reject(new Error(typeof error.message === 'string' ? error.message : 'Codex App Server request failed.'));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleDisconnect(socket: net.Socket | undefined, error: Error): void {
    if (socket && this.socket !== socket) return;
    this.socket = undefined;
    this.upgraded = false;
    this.initialized = false;
    this.handshakeBuffer = Buffer.alloc(0);
    this.frameBuffer = Buffer.alloc(0);
    this.fragmentOpcode = undefined;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}
