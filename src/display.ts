import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { logger } from './log.js';

const log = logger('display');

export interface DisplayLease {
  /** Environment variables the game needs (DISPLAY, software GL). */
  env: Record<string, string>;
  /** True when Calcite started its own Xvfb (HeadlessMC must then be told to check for it). */
  virtual: boolean;
  release(): void;
}

export function which(binary: string): string | null {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, binary);
    if (existsSync(p)) return p;
  }
  return null;
}

/** True when a GPU device node exists (Linux); otherwise Mesa software rendering is used. */
export function hasGpu(): boolean {
  if (process.platform !== 'linux') return true;
  try {
    return readdirSync('/dev/dri').some((f) => f.startsWith('renderD') || f.startsWith('card'));
  } catch {
    return false;
  }
}

const libCache = new Map<string, boolean>();

/** True when a shared library (e.g. "libEGL.so.1") is present in the usual Linux library directories. */
export function hasSharedLib(name: string): boolean {
  const cached = libCache.get(name);
  if (cached !== undefined) return cached;
  const dirs = ['/usr/lib64', '/usr/lib', '/lib64', '/lib', '/usr/local/lib'];
  for (const base of ['/usr/lib', '/lib']) {
    try {
      for (const d of readdirSync(base)) if (/-linux-gnu/.test(d)) dirs.push(join(base, d));
    } catch {
      // not there
    }
  }
  const found = dirs.some((d) => existsSync(join(d, name)));
  libCache.set(name, found);
  return found;
}

function softwareGlEnv(): Record<string, string> {
  return hasGpu() ? {} : { LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' };
}

/**
 * Environment for a virtual (Xvfb) display. Minecraft 26.x renders through SDL3 and asks for an sRGB-capable
 * framebuffer, which Xvfb's GLX never offers; SDL's EGL path provides it. Older versions use GLFW and ignore this.
 */
function virtualDisplayEnv(): Record<string, string> {
  return { ...softwareGlEnv(), ...(hasSharedLib('libEGL.so.1') ? { SDL_VIDEO_FORCE_EGL: '1' } : {}) };
}

let shared: { proc: ChildProcess; display: string; refs: number } | null = null;

function freeDisplayNumber(): number {
  for (let n = 99; n < 199; n++) {
    if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error('No free X display number between :99 and :198');
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

/**
 * Provides a display for a rendering client.
 * - Linux with DISPLAY set (desktop, or an existing Xvfb): use it.
 * - Linux without DISPLAY: start a shared Xvfb (needs the `Xvfb` binary) with software GL when there is no GPU.
 * - Windows / macOS: the native display is used.
 */
export async function acquireDisplay(opts: { width?: number; height?: number; forceVirtual?: boolean } = {}): Promise<DisplayLease> {
  if (process.platform !== 'linux') {
    return { env: {}, virtual: false, release() {} };
  }
  if (process.env.DISPLAY && !opts.forceVirtual) {
    const virtual = /xvfb/i.test(process.env.CALCITE_DISPLAY_KIND || '');
    return { env: { DISPLAY: process.env.DISPLAY, ...(virtual ? virtualDisplayEnv() : softwareGlEnv()) }, virtual, release() {} };
  }
  if (!shared || shared.proc.exitCode !== null) {
    const xvfb = which('Xvfb');
    if (!xvfb) {
      throw new Error('Rendering on a Linux machine without a display needs Xvfb and Mesa: apt-get install -y xvfb libgl1-mesa-dri libegl1 libegl-mesa0 (or run with --render off)');
    }
    const n = freeDisplayNumber();
    const width = opts.width ?? 1280;
    const height = opts.height ?? 720;
    const proc = spawn(xvfb, [`:${n}`, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'], {
      stdio: 'ignore',
      detached: false,
    });
    proc.unref();
    const ok = await waitFor(() => existsSync(`/tmp/.X11-unix/X${n}`) || proc.exitCode !== null, 10_000);
    if (!ok || proc.exitCode !== null) throw new Error(`Xvfb :${n} failed to start`);
    log.info(`started Xvfb :${n} (${width}x${height})`);
    shared = { proc, display: `:${n}`, refs: 0 };
    const cleanup = () => {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    };
    process.once('exit', cleanup);
  }
  const lease = shared;
  lease.refs++;
  let released = false;
  return {
    env: { DISPLAY: lease.display, ...virtualDisplayEnv() },
    virtual: true,
    release() {
      if (released) return;
      released = true;
      lease.refs--;
      if (lease.refs <= 0 && shared === lease) {
        lease.proc.kill();
        shared = null;
      }
    },
  };
}
