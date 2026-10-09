import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import tls from 'node:tls';
import { logger } from './log.js';

const log = logger('net');

export const USER_AGENT = 'calcite (+https://github.com/bkm016/Calcite)';

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

function env(name: string): string | undefined {
  return process.env[name] || process.env[name.toLowerCase()] || undefined;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

/** NO_PROXY matching: "*", exact hosts, ".suffix"/"suffix" domains, host:port and IPv4 CIDR. */
export function bypassProxy(target: URL, noProxy = env('NO_PROXY') ?? ''): boolean {
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  for (let rule of noProxy.split(/[\s,]+/)) {
    rule = rule.trim().toLowerCase();
    if (!rule) continue;
    if (rule === '*') return true;
    let rulePort: string | undefined;
    const m = /^([^:]+):(\d+)$/.exec(rule);
    if (m) [, rule, rulePort] = m;
    if (rulePort && rulePort !== port) continue;
    if (rule.includes('/')) {
      const [net, bits] = rule.split('/');
      if (isIP(net) !== 4 || isIP(host) !== 4) continue;
      const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
      if ((ipv4ToInt(host) & mask) === (ipv4ToInt(net) & mask)) return true;
      continue;
    }
    const domain = rule.replace(/^\*?\./, '');
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/** The proxy to use for {@code target}, honouring HTTPS_PROXY / HTTP_PROXY / NO_PROXY (any case). */
export function proxyFor(target: URL): URL | undefined {
  const raw = target.protocol === 'https:' ? (env('HTTPS_PROXY') ?? env('HTTP_PROXY')) : env('HTTP_PROXY');
  if (!raw || bypassProxy(target)) return undefined;
  return new URL(raw.includes('://') ? raw : `http://${raw}`);
}

/**
 * Java system properties that route a JVM (HeadlessMC, the game) through the HTTPS_PROXY / HTTP_PROXY / NO_PROXY
 * proxies; Java ignores those variables. Proxy credentials are not supported by Java's CONNECT handling.
 */
export function javaProxyProps(): Record<string, string> {
  const props: Record<string, string> = {};
  const parse = (raw: string | undefined) => {
    if (!raw) return undefined;
    try {
      const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
      return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || (url.protocol === 'https:' ? '443' : '80') };
    } catch {
      return undefined;
    }
  };
  const https = parse(env('HTTPS_PROXY') ?? env('HTTP_PROXY'));
  const http = parse(env('HTTP_PROXY'));
  if (https) Object.assign(props, { 'https.proxyHost': https.host, 'https.proxyPort': https.port });
  if (http) Object.assign(props, { 'http.proxyHost': http.host, 'http.proxyPort': http.port });
  if (https || http) {
    // Java patterns: "*.example.com", "localhost"; CIDR rules have no equivalent and are skipped
    const hosts = ['localhost', '127.*', '[::1]'];
    for (const rule of (env('NO_PROXY') ?? '').split(/[\s,]+/)) {
      const r = rule.trim().replace(/:\d+$/, '');
      if (!r || r.includes('/')) continue;
      hosts.push(r === '*' ? '*' : r.startsWith('.') ? `*${r}` : r);
    }
    props['http.nonProxyHosts'] = [...new Set(hosts)].join('|');
  }
  return props;
}

function proxyAuth(proxy: URL): Record<string, string> {
  if (!proxy.username) return {};
  const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { 'proxy-authorization': `Basic ${Buffer.from(cred).toString('base64')}` };
}

/** Opens a TLS connection to {@code target} through an HTTP(S) proxy using CONNECT. */
function tunnel(proxy: URL, target: URL, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const authority = `${target.hostname}:${target.port || 443}`;
    const req = (proxy.protocol === 'https:' ? https : http).request({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority, ...proxyAuth(proxy) },
      agent: false,
    });
    const timer = setTimeout(() => req.destroy(new Error(`Proxy CONNECT to ${authority} timed out`)), timeoutMs);
    req.once('connect', (res, socket) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT to ${authority} failed: HTTP ${res.statusCode}`));
        return;
      }
      const secure = tls.connect({ socket, servername: isIP(target.hostname) ? undefined : target.hostname });
      secure.once('secureConnect', () => resolve(secure));
      secure.once('error', reject);
    });
    req.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

interface RequestOptions {
  /** Time allowed to connect and receive headers. */
  timeoutMs?: number;
  /** Maximum silence while streaming the body. */
  idleMs?: number;
}

/** One GET without redirects. Resolves with the response (body not yet consumed). */
async function getOnce(url: URL, { timeoutMs = 60_000, idleMs = 120_000 }: RequestOptions): Promise<IncomingMessage> {
  const proxy = proxyFor(url);
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: '*/*', 'accept-encoding': 'identity' };
  let mod: typeof http | typeof https = url.protocol === 'https:' ? https : http;
  let options: https.RequestOptions = {
    protocol: url.protocol,
    host: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
  };
  if (proxy && url.protocol === 'https:') {
    const socket = await tunnel(proxy, url, timeoutMs);
    // No `agent` here: with `agent: false` Node 24 creates a fresh Agent and ignores `createConnection`, connecting
    // directly instead of through the tunnel. Without an agent the Host header falls back to port 80 unless
    // `defaultPort` is set, so set both explicitly.
    options = { ...options, defaultPort: 443, createConnection: () => socket };
    headers.host = url.host;
  } else if (proxy) {
    // Plain HTTP through a proxy: absolute-form request target.
    mod = proxy.protocol === 'https:' ? https : http;
    options = { protocol: proxy.protocol, host: proxy.hostname, port: proxy.port || undefined, path: url.toString(), agent: false };
    Object.assign(headers, proxyAuth(proxy), { host: url.host });
  }
  return new Promise((resolve, reject) => {
    const req = mod.request({ ...options, method: 'GET', headers });
    const timer = setTimeout(() => req.destroy(new Error(`Timed out waiting for ${url}`)), timeoutMs);
    req.once('response', (res) => {
      clearTimeout(timer);
      req.setTimeout(idleMs, () => req.destroy(new Error(`Download of ${url} stalled`)));
      resolve(res);
    });
    req.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

/** GET following redirects. Throws {@link HttpError} for non-2xx responses. */
async function get(url: string, opts: RequestOptions = {}): Promise<IncomingMessage> {
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    const res = await getOnce(current, opts);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= 10) throw new Error(`Too many redirects for ${url}`);
      current = new URL(res.headers.location, current);
      continue;
    }
    if (status >= 200 && status < 300) return res;
    res.resume();
    throw new HttpError(url, status);
  }
}

function retryable(err: unknown): boolean {
  return !(err instanceof HttpError) || err.status === 429 || err.status >= 500;
}

/** Runs a whole transfer with retries and exponential backoff on network errors, 429 and 5xx. */
async function withRetries<T>(url: string, fn: () => Promise<T>, retries = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!retryable(err) || attempt >= retries) throw err;
      const delay = 1000 * 2 ** attempt;
      log.debug(`retry ${attempt + 1}/${retries} for ${url} in ${delay}ms: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function readAll(res: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  const expected = Number(res.headers['content-length'] ?? -1);
  const body = Buffer.concat(chunks);
  if (expected >= 0 && body.length !== expected) throw new Error(`Truncated response: ${body.length}/${expected} bytes`);
  return body;
}

export async function httpText(url: string): Promise<string> {
  return withRetries(url, async () => (await readAll(await get(url))).toString('utf8'));
}

export async function httpJson<T>(url: string): Promise<T> {
  return JSON.parse(await httpText(url)) as T;
}

export async function hashFile(file: string, algorithm: 'sha1' | 'sha256'): Promise<string> {
  return createHash(algorithm)
    .update(await readFile(file))
    .digest('hex');
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export interface DownloadOptions {
  sha1?: string;
  sha256?: string;
  /** Skip the download when the file exists and (if a hash is given) matches. */
  reuse?: boolean;
}

/** Describes the first given hash that {@code file} does not match; undefined when all match. */
async function hashMismatch(file: string, opts: DownloadOptions): Promise<string | undefined> {
  for (const [algorithm, label] of [
    ['sha1', 'SHA-1'],
    ['sha256', 'SHA-256'],
  ] as const) {
    const expected = opts[algorithm]?.toLowerCase();
    if (!expected) continue;
    const actual = await hashFile(file, algorithm);
    if (actual !== expected) return `${label} mismatch: expected ${expected}, got ${actual}`;
  }
  return undefined;
}

/** Downloads to {@code dest} atomically (temp file + rename) and verifies the hash when given. */
export async function download(url: string, dest: string, opts: DownloadOptions = {}): Promise<string> {
  if ((opts.reuse ?? true) && (await exists(dest))) {
    const mismatch = await hashMismatch(dest, opts);
    if (!mismatch) return dest;
    log.warn(`${mismatch} for existing ${dest}, downloading again`);
  }
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.part`;
  try {
    await withRetries(url, async () => {
      const res = await get(url);
      const expected = Number(res.headers['content-length'] ?? -1);
      await pipeline(res, createWriteStream(tmp));
      if (expected >= 0) {
        const { size } = await stat(tmp);
        if (size !== expected) throw new Error(`Truncated download of ${url}: ${size}/${expected} bytes`);
      }
    });
    const mismatch = await hashMismatch(tmp, opts);
    if (mismatch) throw new Error(`${mismatch} (${url})`);
    await rename(tmp, dest);
    return dest;
  } finally {
    await rm(tmp, { force: true });
  }
}
