import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureHmc, ensureHmcHome, killTree, runHmc } from './hmc.js';
import { ensureLauncherJava } from './java.js';
import { withLock } from './lock.js';
import type { CalcitePaths } from './paths.js';

/** HeadlessMC stores Microsoft sessions (refresh tokens) here; Calcite restricts it to the current user. */
export function accountsFile(paths: CalcitePaths): string {
  return join(paths.hmcHome, 'HeadlessMC', 'auth', '.accounts.json');
}

export function accountsLock(paths: CalcitePaths): string {
  return join(paths.hmcHome, 'accounts.lock');
}

export interface AccountInfo {
  name: string;
  uuid?: string;
  /** The account HeadlessMC uses for the next launch. */
  primary: boolean;
}

type Json = Record<string, unknown>;

function findProfile(account: Json): { name?: string; uuid?: string } {
  // FullJavaSession JSON: { mcProfile: { name, id, ... }, ... } (possibly nested)
  const stack: unknown[] = [account];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const obj = node as Json;
    if (obj.mcProfile && typeof obj.mcProfile === 'object') {
      const p = obj.mcProfile as Json;
      return { name: typeof p.name === 'string' ? p.name : undefined, uuid: typeof p.id === 'string' ? p.id : undefined };
    }
    for (const v of Object.values(obj)) if (v && typeof v === 'object') stack.push(v);
  }
  return {};
}

async function readAccounts(paths: CalcitePaths): Promise<Json[]> {
  try {
    const data = JSON.parse(await readFile(accountsFile(paths), 'utf8')) as { accounts?: Json[] };
    return Array.isArray(data.accounts) ? data.accounts : [];
  } catch {
    return [];
  }
}

/** Stored Microsoft accounts (no secrets). The first one is the primary account. */
export async function listAccounts(paths: CalcitePaths): Promise<AccountInfo[]> {
  return (await readAccounts(paths)).map((a, i) => ({ ...findProfile(a), name: findProfile(a).name ?? `account-${i}`, primary: i === 0 }));
}

export async function removeAccount(paths: CalcitePaths, name: string): Promise<boolean> {
  return withLock(accountsLock(paths), async () => {
    const accounts = await readAccounts(paths);
    const kept = accounts.filter((a) => findProfile(a).name?.toLowerCase() !== name.toLowerCase());
    if (kept.length === accounts.length) return false;
    await writeFile(accountsFile(paths), JSON.stringify({ accounts: kept }, null, 2));
    await restrictPermissions(paths);
    return true;
  });
}

async function restrictPermissions(paths: CalcitePaths): Promise<void> {
  if (process.platform === 'win32') return; // stays under the user's profile ACL
  await chmod(accountsFile(paths), 0o600).catch(() => undefined);
}

export interface LoginHandle {
  /** Microsoft device login URL (contains the code); open it in a browser and approve. */
  url: Promise<string>;
  /** Resolves with the Minecraft profile name once the login completed and the account was stored. */
  done: Promise<string>;
  cancel(): Promise<void>;
}

/**
 * Starts a Microsoft device-code login through HeadlessMC. The session (including the refresh token) is stored
 * in the shared HeadlessMC home and refreshed automatically on every launch.
 */
export async function startLogin(paths: CalcitePaths, { timeoutMs = 15 * 60_000 } = {}): Promise<LoginHandle> {
  const java = await ensureLauncherJava(paths);
  const hmcJar = await ensureHmc(paths);
  await ensureHmcHome(paths);
  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (err: Error) => void;
  const url = new Promise<string>((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });
  let failure = '';
  let account = '';
  const run = runHmc({
    javaPath: java.path,
    hmcJar,
    paths,
    props: { 'hmc.store.accounts': 'true' },
    command: ['login'],
    onLine: (line) => {
      const go = /Go to (https?:\/\/\S+)/.exec(line);
      if (go) resolveUrl(go[1]);
      const ok = /Logged into account (.+?) successfully/.exec(line);
      if (ok) account = ok[1];
      if (/Failed to login|You can't play|Login process cancelled/.test(line)) failure = line.trim();
    },
  });
  const timer = setTimeout(() => void killTree(run.child), timeoutMs);
  const done = run.exited.then(async () => {
    clearTimeout(timer);
    if (!account) {
      const err = new Error(failure || 'Login did not complete (timed out or cancelled)');
      rejectUrl(err);
      throw err;
    }
    await restrictPermissions(paths);
    return account;
  });
  done.catch(() => undefined);
  return {
    url,
    done,
    async cancel() {
      clearTimeout(timer);
      await killTree(run.child);
    },
  };
}
