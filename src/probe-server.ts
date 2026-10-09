import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { logger } from './log.js';

const log = logger('probe');

export const PROBE_PROTOCOL = 1;

export class ProbeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProbeError';
  }
}

/** An event the probe forwards from the game or an extension. */
export interface ProbeEvent {
  name: string;
  data: unknown;
  time: number;
}

interface ProbeServerEvents {
  connected: [];
  disconnected: [];
  event: [event: ProbeEvent];
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * TCP endpoint (127.0.0.1, random port) the in-game probe connects to. Authenticated with a random token;
 * JSON objects separated by newlines.
 */
export class ProbeServer extends EventEmitter<ProbeServerEvents> {
  readonly token = randomBytes(24).toString('hex');
  private server: Server | null = null;
  private socket: Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  port = 0;

  async listen(): Promise<number> {
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Probe server has no TCP address');
    this.port = address.port;
    return this.port;
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    let authed = false;
    const helloTimer = setTimeout(() => {
      if (!authed) socket.destroy();
    }, 10_000);
    const rl = createInterface({ input: socket });
    rl.on('line', (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        socket.destroy();
        return;
      }
      if (!authed) {
        if (msg.type !== 'hello' || msg.token !== this.token) {
          log.warn('rejected a probe connection with a wrong token');
          socket.destroy();
          return;
        }
        if (msg.protocol !== PROBE_PROTOCOL) {
          log.warn(`probe protocol ${String(msg.protocol)} differs from ${PROBE_PROTOCOL}`);
        }
        authed = true;
        clearTimeout(helloTimer);
        this.socket?.destroy();
        this.socket = socket;
        log.debug(`probe connected (java ${String(msg.java)})`);
        this.emit('connected');
        return;
      }
      if (msg.type === 'event') {
        this.emit('event', { name: String(msg.name), data: msg.data, time: Number(msg.time) || Date.now() });
        return;
      }
      this.onResponse(msg);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (this.socket === socket) {
        this.socket = null;
        this.failAll(new ProbeError('disconnected', 'The game closed the probe connection'));
        this.emit('disconnected');
      }
    });
  }

  private onResponse(msg: Record<string, unknown>): void {
    const id = Number(msg.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.result);
    else
      pending.reject(
        new ProbeError(typeof msg.code === 'string' ? msg.code : 'error', typeof msg.error === 'string' ? msg.error : 'probe error'),
      );
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  /** Sends one request to the probe. */
  request<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new ProbeError('not_connected', 'The game probe is not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProbeError('timeout', `Probe request "${op}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      socket.write(JSON.stringify({ id, op, args }) + '\n');
    });
  }

  async close(): Promise<void> {
    this.failAll(new ProbeError('closed', 'Probe server closed'));
    this.socket?.destroy();
    this.socket = null;
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
