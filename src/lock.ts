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

/** Whether the lock in {@code dir} was left behind; undefined when it vanished meanwhile. */
async function staleLock(dir: string, staleMs: number): Promise<boolean | undefined> {
  let modified: number;
  try {
    modified = (await stat(dir)).mtimeMs;
  } catch {
    return undefined;
  }
  const owner = Number(await readFile(join(dir, 'owner'), 'utf8').catch(() => ''));
  // a lock without an owner is still being created, unless that never finished
  if (!(owner > 0)) return Date.now() - modified > 10_000;
  return !alive(owner) || Date.now() - modified > staleMs;
}

/**
 * Cross-process lock based on an atomic mkdir. A lock whose owner process is gone (or that is older than
 * {@code staleMs}) is taken over. Returns the release function.
 */
export async function acquireLock(
  dir: string,
  { timeoutMs = 10 * 60_000, staleMs = Infinity }: LockOptions = {},
): Promise<() => Promise<void>> {
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
    const stale = await staleLock(dir, staleMs);
    if (stale === undefined) continue; // vanished meanwhile
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
