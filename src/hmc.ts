import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { download } from './net.js';
import type { CalcitePaths } from './paths.js';

/** Pinned HeadlessMC release (MIT, https://github.com/headlesshq/headlessmc). */
export const HMC_VERSION = '2.10.0';
export const HMC_URL = `https://github.com/headlesshq/headlessmc/releases/download/${HMC_VERSION}/headlessmc-launcher-wrapper-${HMC_VERSION}.jar`;
export const HMC_SHA256 = 'bf80d84516eeeb9a51fa35894c4466b146d55d0146cd6d2adc49fdd231654536';

/** Path of the HeadlessMC launcher jar (CALCITE_HMC_JAR overrides the pinned download). */
export async function ensureHmc(paths: CalcitePaths): Promise<string> {
  if (process.env.CALCITE_HMC_JAR) return process.env.CALCITE_HMC_JAR;
  const file = join(paths.hmcJars, `headlessmc-launcher-wrapper-${HMC_VERSION}.jar`);
  await download(process.env.CALCITE_HMC_URL || HMC_URL, file, { sha256: HMC_SHA256 });
  return file;
}

/**
 * Base config of the shared HeadlessMC home. Per-client settings are passed as -D system properties, which
 * HeadlessMC reads before its config file, so concurrent clients never rewrite a shared file.
 */
export async function ensureHmcHome(paths: CalcitePaths): Promise<void> {
  const dir = join(paths.hmcHome, 'HeadlessMC');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'config.properties'),
    [
      '# Managed by Calcite. Per-client values are passed as -Dhmc.* system properties.',
      `hmc.mcdir=${paths.minecraft.replace(/\\/g, '\\\\')}`,
      'hmc.store.accounts=true',
      'hmc.account.refresh.on.game.launch=true',
      'hmc.exit.on.failed.command=true',
      'hmc.always.download.assets.index=true',
      'hmc.http.user.agent.enabled=true',
      '',
    ].join('\n'),
  );
}

export interface HmcRun {
  child: ChildProcess;
  /** Resolves with the exit code when the HeadlessMC process exits. */
  exited: Promise<number | null>;
}

export interface HmcRunOptions {
  javaPath: string;
  hmcJar: string;
  paths: CalcitePaths;
  /** hmc.* (and other) system properties for this run. */
  props: Record<string, string>;
  /** HeadlessMC command line, e.g. ["launch", "1.21.11", "-lwjgl"]. */
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
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    live.clear();
  };
  process.once('exit', killAll);
  // A signal without a handler terminates Node without an 'exit' event; when nobody else handles it, clean up and
  // die with the conventional status. Hosts that handle the signal themselves end up in 'exit' above.
  for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129], ['SIGINT', 130]] as const) {
    process.on(signal, () => {
      if (process.listenerCount(signal) > 1) return;
      killAll();
      process.exit(code);
    });
  }
}

/** Runs one HeadlessMC command non-interactively (`--command ...`) in the shared HeadlessMC home. */
export function runHmc(opts: HmcRunOptions): HmcRun {
  const args = [
    ...Object.entries(opts.props).map(([k, v]) => `-D${k}=${v}`),
    '-jar',
    opts.hmcJar,
    '--command',
    ...opts.command,
  ];
  const child = spawn(opts.javaPath, args, {
    cwd: opts.paths.hmcHome,
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
    if (!stream) continue;
    const rl = createInterface({ input: stream });
    rl.on('line', (line) => opts.onLine?.(line));
  }
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  return { child, exited };
}

/** Stops a process tree started by {@link runHmc}. */
export async function killTree(child: ChildProcess, graceMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, graceMs);
    exited.finally(() => clearTimeout(timer));
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, graceMs * 2))]);
}
