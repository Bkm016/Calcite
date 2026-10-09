import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ensureJava } from './java.js';
import { getVersionJson, requiredJavaMajor, resolveVersion } from './mojang.js';
import { download, httpJson } from './net.js';
import { resolvePaths, type CalcitePaths } from './paths.js';

const FILL_API = 'https://fill.papermc.io/v3/projects/paper/versions';

/** ViaVersion and ViaBackwards let clients of other versions join (they need Java 17+). */
const VIA_PLUGINS = [
  {
    url: 'https://github.com/ViaVersion/ViaVersion/releases/download/5.12.0/ViaVersion-5.12.0.jar',
    sha256: '72c40a6a702d67f226fc9a0d8ad82aba1483fdabe2e6159bcdddb2dc070750b0',
  },
  {
    url: 'https://github.com/ViaVersion/ViaBackwards/releases/download/5.12.0/ViaBackwards-5.12.0.jar',
    sha256: '194e9250224632274d7b3c17e411e031a9223c1863c6f5138d53c721f07ab78d',
  },
];

/** Plugins placed by an earlier start, removed again when they are no longer wanted. */
const MANAGED_PLUGINS = 'plugins/.calcite-managed.json';

export interface PaperServerOptions {
  /** Server directory; jars are cached there. */
  dir: string;
  /** Minecraft version of the server (the latest Paper build for it is used). */
  version: string;
  /** Port (default: a free one). */
  port?: number;
  /** Player names to make operators (offline-mode UUIDs). */
  operators?: string[];
  /** Plugin jars to install (local paths). */
  plugins?: string[];
  /** Install ViaVersion and ViaBackwards so other client versions can join (default true; needs Java 17+). */
  via?: boolean;
  /** Keep the world of the previous start instead of generating a new one (default false). */
  keepWorld?: boolean;
  /** server.properties entries on top of the test defaults (offline, flat, peaceful, no spawn protection). */
  properties?: Record<string, string>;
  /** Max heap (default "1G"). */
  memory?: string;
  javaPath?: string;
  /** Startup timeout (default 5 minutes). */
  timeoutMs?: number;
  /** Receives every console line. */
  onLine?: (line: string) => void;
  paths?: CalcitePaths;
}

export interface PaperServer {
  /** "127.0.0.1:port", ready for {@code ClientOptions.server}. */
  readonly address: string;
  readonly port: number;
  readonly dir: string;
  /** Sends a console command. */
  command(line: string): void;
  /** Sends a console command and resolves with the first console line after it that matches {@code expect}. */
  run(line: string, expect: RegExp, timeoutMs?: number): Promise<string>;
  /** Resolves with the next console line that matches {@code pattern}. */
  waitForLine(pattern: RegExp, timeoutMs?: number): Promise<string>;
  /** Stops the server (saving the world) and waits for it to exit. */
  stop(): Promise<void>;
}

/** The UUID an offline-mode server gives a player name. */
export function offlineUuid(name: string): string {
  const b = createHash('md5').update(`OfflinePlayer:${name}`).digest();
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function serverProperties(port: number, overrides: Record<string, string> = {}): string {
  const props: Record<string, string> = {
    'server-port': String(port),
    'online-mode': 'false',
    'enforce-secure-profile': 'false',
    'level-type': 'minecraft\\:flat',
    'generate-structures': 'false',
    'spawn-protection': '0',
    difficulty: 'peaceful',
    'view-distance': '6',
    'simulation-distance': '4',
    'pause-when-empty-seconds': '-1',
    motd: 'Calcite test server',
    ...overrides,
  };
  return `${Object.entries(props)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`;
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  server.close();
  return port;
}

interface PaperBuild {
  id: number;
  downloads: Record<string, { name: string; url: string; checksums: { sha256: string } }>;
}

async function installPaper(dir: string, version: string): Promise<void> {
  const build = await httpJson<PaperBuild>(`${FILL_API}/${encodeURIComponent(version)}/builds/latest`);
  const jar = build.downloads['server:default'];
  await download(jar.url, join(dir, 'paper.jar'), { sha256: jar.checksums.sha256 });
}

/** Copies the wanted plugins in and removes the ones an earlier start placed that are no longer wanted. */
async function installPlugins(dir: string, plugins: string[], via: boolean): Promise<void> {
  const pluginDir = join(dir, 'plugins');
  await mkdir(pluginDir, { recursive: true });
  const previous = JSON.parse(await readFile(join(dir, MANAGED_PLUGINS), 'utf8').catch(() => '[]')) as string[];
  const placed: string[] = [];
  for (const plugin of plugins) {
    await copyFile(resolve(plugin), join(pluginDir, basename(plugin)));
    placed.push(basename(plugin));
  }
  if (via) {
    for (const p of VIA_PLUGINS) placed.push(basename(await download(p.url, join(pluginDir, basename(p.url)), { sha256: p.sha256 })));
  }
  for (const stale of previous.filter((p) => !placed.includes(p))) await rm(join(pluginDir, stale), { force: true });
  await writeFile(join(dir, MANAGED_PLUGINS), JSON.stringify(placed));
}

/** Starts a disposable Paper server for tests and resolves once it accepts players. */
export async function startPaperServer(opts: PaperServerOptions): Promise<PaperServer> {
  const dir = resolve(opts.dir);
  const paths = opts.paths ?? resolvePaths();
  const port = opts.port ?? (await freePort());
  const json = await getVersionJson(paths, await resolveVersion(paths, opts.version));
  const java = await ensureJava(paths, requiredJavaMajor(json), { javaPath: opts.javaPath });

  await mkdir(dir, { recursive: true });
  await installPaper(dir, json.id);
  await installPlugins(dir, opts.plugins ?? [], (opts.via ?? true) && java.major >= 17);
  if (!opts.keepWorld) {
    for (const world of ['world', 'world_nether', 'world_the_end']) await rm(join(dir, world), { recursive: true, force: true });
  }
  await writeFile(join(dir, 'eula.txt'), 'eula=true\n');
  await writeFile(join(dir, 'server.properties'), serverProperties(port, opts.properties));
  const ops = (opts.operators ?? []).map((name) => ({ uuid: offlineUuid(name), name, level: 4, bypassesPlayerLimit: false }));
  await writeFile(join(dir, 'ops.json'), JSON.stringify(ops, null, 2));

  const proc = spawn(java.path, [`-Xmx${opts.memory ?? '1G'}`, '-jar', 'paper.jar', '--nogui'], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiters = new Set<{ pattern: RegExp; resolve: (line: string) => void }>();
  const tail: string[] = [];
  for (const stream of [proc.stdout, proc.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      tail.push(line);
      if (tail.length > 40) tail.shift();
      opts.onLine?.(line);
      for (const w of waiters) {
        if (w.pattern.test(line)) {
          waiters.delete(w);
          w.resolve(line);
        }
      }
    });
  }
  const exited = once(proc, 'exit');

  const waitForLine = (pattern: RegExp, timeoutMs = 10_000): Promise<string> =>
    new Promise((resolveLine, reject) => {
      const waiter = {
        pattern,
        resolve: (line: string) => {
          clearTimeout(timer);
          resolveLine(line);
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`No console line matched ${pattern} within ${timeoutMs}ms:\n${tail.slice(-10).join('\n')}`));
      }, timeoutMs);
      waiters.add(waiter);
    });
  const command = (line: string) => {
    proc.stdin.write(`${line}\n`);
  };
  const stop = async () => {
    if (proc.exitCode !== null) return;
    command('stop');
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
    await exited;
    clearTimeout(timer);
  };

  const timeoutMs = opts.timeoutMs ?? 300_000;
  const done = waitForLine(/Done \(/, timeoutMs);
  done.catch(() => undefined); // still pending when the server exits first
  const failure = await Promise.race([
    done.then(
      () => null,
      (err: unknown) => err as Error,
    ),
    exited.then(([code]) => new Error(`Paper exited with code ${String(code)}:\n${tail.join('\n')}`)),
  ]);
  if (failure) {
    proc.kill('SIGKILL');
    throw failure;
  }
  return {
    address: `127.0.0.1:${port}`,
    port,
    dir,
    command,
    run: (line, expect, ms) => {
      const matched = waitForLine(expect, ms);
      command(line);
      return matched;
    },
    waitForLine,
    stop,
  };
}
