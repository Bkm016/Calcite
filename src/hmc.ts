import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { download, javaProxyProps } from './net.js';
import type { CalcitePaths } from './paths.js';

/** Pinned HeadlessMC release (MIT, https://github.com/headlesshq/headlessmc). */
export const HMC_VERSION = '3.0.0-RC3';
export const HMC_URL = `https://github.com/headlesshq/headlessmc/releases/download/${HMC_VERSION}/headlessmc.jar`;
export const HMC_SHA256 = 'dcc061a336ecf7aa638794bd47840fa9970b31d562e630e84c3d587c906153a8';

/** Path of the HeadlessMC jar (CALCITE_HMC_JAR overrides the pinned download). */
export async function ensureHmc(paths: CalcitePaths): Promise<string> {
  if (process.env.CALCITE_HMC_JAR) return process.env.CALCITE_HMC_JAR;
  const file = join(paths.hmcJars, `headlessmc-${HMC_VERSION}.jar`);
  await download(process.env.CALCITE_HMC_URL || HMC_URL, file, { sha256: HMC_SHA256 });
  return file;
}

/** Escapes one entry of a comma separated HeadlessMC list setting. */
export function hmcListEntry(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/,/g, '\\,');
}

/** Converts a Java executable path to the Java home path expected by HeadlessMC. */
export function hmcJavaHome(javaPath: string): string {
  return javaPath.replace(/[\\/]bin[\\/]java(?:\.exe)?$/i, '');
}

/** Quotes one argument for HeadlessMC's `--jvm`/`--game` options, which are split like a shell command line. */
export function hmcQuote(arg: string): string {
  return `"${arg.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * Writes the HeadlessMC profile used when launching `versionId` from `location`. HeadlessMC only runs a version
 * with the exact Java major the version asks for; the profile pins the runtime Calcite chose instead. With a
 * {@code loader} the profile selects that platform (fabric, forge, neoforge) and build for Minecraft {@code versionId}.
 */
export async function writeHmcProfile(
  location: string,
  versionId: string,
  gameDir: string,
  javaMajor: number,
  loader?: { kind: string; build?: string },
): Promise<void> {
  const build = loader ? hmcVersionArgs(versionId, loader).at(2) : undefined;
  const version = { side: null, platform: loader?.kind ?? 'vanilla', version: versionId, build: build ?? null };
  const profile = {
    name: 'calcite',
    version,
    currentVersion: version,
    path: pathToFileURL(gameDir).href,
    options: { resolution: null, quickPlayPath: null, join: null, demo: false },
    patchers: [],
    systemProperties: {},
    vmArgs: [],
    gameArgs: [],
    javaVersion: javaMajor,
    eulaStatus: 'UNKNOWN',
    hasDefaultClientJvmArgs: true,
    hmcVersion: 0,
  };
  await mkdir(join(location, 'profiles'), { recursive: true });
  await writeFile(join(location, 'profiles', 'calcite.json'), JSON.stringify(profile, null, 2));
}

/**
 * HeadlessMC's version argument: "1.21.11", or "fabric 1.21.11 0.19.5" for a mod loader. HeadlessMC names NeoForge
 * builds without the Minecraft part of their version (NeoForge 21.11.45 for 1.21.11 is build "45").
 */
export function hmcVersionArgs(versionId: string, loader?: { kind: string; build?: string }): string[] {
  if (!loader) return [versionId];
  let build = loader.build;
  if (build && loader.kind === 'neoforge') {
    const prefix = `${versionId.startsWith('1.') ? versionId.slice(2) : versionId}.`;
    if (build.startsWith(prefix)) build = build.slice(prefix.length);
  }
  return [loader.kind, versionId, ...(build ? [build] : [])];
}

export interface HmcRun {
  child: ChildProcess;
  /** Resolves with the exit code when the HeadlessMC process exits. */
  exited: Promise<number | null>;
}

export interface HmcRunOptions {
  javaPath: string;
  hmcJar: string;
  /** HeadlessMC files location (config, accounts, caches) of this run. */
  location: string;
  /** hmc.* (and other) system properties for this run. */
  props?: Record<string, string>;
  /** HeadlessMC command line, e.g. ["launch", "1.21.11", "--headless"]. */
  command: string[];
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
}

const live = new Set<ChildProcess>();
let exitGuard = false;

/** Kills every still-running HeadlessMC tree when the host process exits, so nothing is orphaned. */
function guardExit(): void {
  if (exitGuard) return;
  exitGuard = true;
  const killAll = () => {
    for (const child of live) {
      if (child.pid === undefined || child.exitCode !== null) continue;
      if (process.platform === 'win32')
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else signalGroup(child, child.pid, 'SIGKILL');
    }
    live.clear();
  };
  process.once('exit', killAll);
  // A signal without a handler terminates Node without an 'exit' event; when nobody else handles it, clean up and
  // die with the conventional status. Hosts that handle the signal themselves end up in 'exit' above.
  for (const [signal, code] of [
    ['SIGTERM', 143],
    ['SIGHUP', 129],
    ['SIGINT', 130],
  ] as const) {
    process.on(signal, () => {
      if (process.listenerCount(signal) > 1) return;
      killAll();
      process.exit(code);
    });
  }
}

/**
 * Runs one HeadlessMC command non-interactively; HeadlessMC exits once the command (and a launched game) finished.
 * Settings are passed as -D system properties, which take precedence over any config file.
 */
export function runHmc(opts: HmcRunOptions): HmcRun {
  const props: Record<string, string> = {
    'hmc.files.location': opts.location,
    'hmc.jline.enabled': 'false',
    'hmc.log.console-level': 'INFO',
    ...javaProxyProps(),
    ...opts.props,
  };
  const args = [...Object.entries(props).map(([k, v]) => `-D${k}=${v}`), '-jar', opts.hmcJar, ...opts.command];
  mkdirSync(opts.location, { recursive: true });
  const child = spawn(opts.javaPath, args, {
    cwd: opts.location,
    env: opts.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // own process group on POSIX so the whole tree (launcher + game) can be stopped together
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  guardExit();
  live.add(child);
  child.once('exit', () => live.delete(child));
  for (const stream of [child.stdout, child.stderr]) {
    const rl = createInterface({ input: stream });
    rl.on('line', (line) => opts.onLine?.(line));
  }
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  return { child, exited };
}

/** Signals the process group led by {@code child} (see {@link runHmc}), or the child alone when that fails. */
function signalGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** Stops a process tree started by {@link runHmc}. */
export async function killTree(child: ChildProcess, graceMs = 5000): Promise<void> {
  const pid = child.pid;
  if (child.exitCode !== null || child.signalCode !== null || pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    signalGroup(child, pid, 'SIGTERM');
    const timer = setTimeout(() => signalGroup(child, pid, 'SIGKILL'), graceMs);
    void exited.finally(() => clearTimeout(timer));
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, graceMs * 2))]);
}
