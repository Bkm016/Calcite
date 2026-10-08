import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LockOptions {
  /** How long to wait for a busy lock (0 = fail immediately). */
  timeoutMs?: number;
  /** A lock older than this is considered abandoned even if its owner pid is alive (pid reuse). */
  staleMs?: number;
}

/**
 * Cross-process lock based on an atomic mkdir. A lock whose owner process is gone (or that is older than
 * {@code staleMs}) is taken over. Returns the release function.
 */
export async function acquireLock(dir: string, { timeoutMs = 10 * 60_000, staleMs = Infinity }: LockOptions = {}): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  let wait = 50;
  for (;;) {
    try {
      await mkdir(dir);
      await writeFile(join(dir, 'owner'), String(process.pid));
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(dir, { recursive: true, force: true });
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        await mkdir(dirname(dir), { recursive: true });
        continue;
      }
      if (code !== 'EEXIST') throw err;
    }
    let stale = false;
    try {
      const info = await stat(dir);
      let owner = 0;
      try {
        owner = Number(await readFile(join(dir, 'owner'), 'utf8'));
      } catch {
        // owner not written yet
      }
      if (owner > 0) stale = !alive(owner) || Date.now() - info.mtimeMs > staleMs;
      else stale = Date.now() - info.mtimeMs > 10_000;
    } catch {
      continue; // lock vanished meanwhile
    }
    if (stale) {
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Lock is held by another process: ${dir}`);
    }
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 2, 1000);
  }
}

/** Runs {@code fn} while holding the lock. */
export async function withLock<T>(dir: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const release = await acquireLock(dir, { staleMs: 30 * 60_000, ...opts });
  try {
    return await fn();
  } finally {
    await release();
  }
}
