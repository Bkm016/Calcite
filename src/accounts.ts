import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureHmc, killTree, runHmc } from './hmc.js';
import { ensureLauncherJava } from './java.js';
import { withLock } from './lock.js';
import type { CalcitePaths } from './paths.js';

/** HeadlessMC account providers. */
const MICROSOFT = 'default';
const OFFLINE = 'offline';

/** HeadlessMC files location holding the Microsoft sessions created by `calcite login`. */
export function accountsHome(paths: CalcitePaths): string {
  return paths.hmcHome;
}

/** HeadlessMC 3 stores the sessions (including refresh tokens) of one provider in this file. */
function storeFile(location: string, provider: string): string {
  return join(location, '.auth', provider, '.accounts.json');
}

function lastUsedFile(location: string): string {
  return join(location, '.auth', 'last', '.accounts.json');
}

/** Microsoft sessions of `calcite login`; Calcite restricts the file to the current user. */
export function accountsFile(paths: CalcitePaths): string {
  return storeFile(accountsHome(paths), MICROSOFT);
}

export function accountsLock(paths: CalcitePaths): string {
  return join(paths.hmcHome, 'accounts.lock');
}

export interface AccountInfo {
  name: string;
  uuid?: string;
  /** The account used when a client does not name one. */
  primary: boolean;
}

type Json = Record<string, unknown>;

async function readStore(file: string): Promise<Json> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as { accounts?: unknown };
    return data.accounts && typeof data.accounts === 'object' && !Array.isArray(data.accounts) ? (data.accounts as Json) : {};
  } catch {
    return {};
  }
}

async function writeStore(file: string, accounts: Json): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ accounts, version: 0 }, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(file, 0o600).catch(() => undefined); // Windows: the profile ACL applies
}

function findKey(accounts: Json, name: string): string | undefined {
  return Object.keys(accounts).find((k) => k.toLowerCase() === name.toLowerCase());
}

/** The Minecraft profile id inside a stored MinecraftAuth session (an object carrying both the name and the id). */
function findUuid(session: unknown, name: string): string | undefined {
  const stack: unknown[] = [session];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const obj = node as Json;
    if (typeof obj.name === 'string' && obj.name.toLowerCase() === name.toLowerCase() && typeof obj.id === 'string') return obj.id;
    for (const v of Object.values(obj)) if (v && typeof v === 'object') stack.push(v);
  }
  return undefined;
}

/** Name of the most recently used Microsoft account of a HeadlessMC location. */
async function lastUsed(location: string): Promise<string | undefined> {
  const latest = (await readStore(lastUsedFile(location))).latest;
  if (!Array.isArray(latest)) return undefined;
  const entry = latest.find((e) => e && typeof e === 'object' && (e as Json).provider === MICROSOFT) as Json | undefined;
  return typeof entry?.name === 'string' ? entry.name : undefined;
}

/** Stored Microsoft accounts (no secrets). */
export async function listAccounts(paths: CalcitePaths): Promise<AccountInfo[]> {
  const accounts = await readStore(accountsFile(paths));
  const names = Object.keys(accounts);
  const last = await lastUsed(accountsHome(paths));
  const primary = (last && findKey(accounts, last)) ?? names[0];
  return names.map((name) => ({ name, uuid: findUuid(accounts[name], name), primary: name === primary }));
}

export async function removeAccount(paths: CalcitePaths, name: string): Promise<boolean> {
  return withLock(accountsLock(paths), async () => {
    const accounts = await readStore(accountsFile(paths));
    const key = findKey(accounts, name);
    if (!key) return false;
    Reflect.deleteProperty(accounts, key);
    await writeStore(accountsFile(paths), accounts);
    return true;
  });
}

/** UUID the vanilla server assigns to an offline player (version 3, from "OfflinePlayer:<name>"), without dashes. */
export function offlineUuid(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return hash.toString('hex');
}

export type LaunchAccount = { type: 'offline'; username: string } | { type: 'microsoft'; name?: string };

/**
 * Prepares the private HeadlessMC location of one client so that HeadlessMC launches exactly this account.
 * Microsoft sessions are copied from the `calcite login` store; {@link syncAccount} writes refreshed tokens back.
 * Returns the account name.
 */
export async function prepareAccount(paths: CalcitePaths, location: string, account: LaunchAccount): Promise<string> {
  if (account.type === 'offline') {
    const name = account.username;
    await rm(storeFile(location, MICROSOFT), { force: true });
    await writeStore(storeFile(location, OFFLINE), {
      [name]: { provider: OFFLINE, name, uuid: offlineUuid(name), token: '', type: 'msa', xuid: '' },
    });
    await writeStore(lastUsedFile(location), { latest: [{ provider: OFFLINE, name }] });
    return name;
  }
  return withLock(accountsLock(paths), async () => {
    const accounts = await listAccounts(paths);
    if (!accounts.length)
      throw Object.assign(new Error('No Microsoft account is stored; run `calcite login` first'), { code: 'not_logged_in' });
    const wanted = account.name;
    const match = wanted ? accounts.find((a) => a.name.toLowerCase() === wanted.toLowerCase()) : accounts.find((a) => a.primary);
    if (!match) {
      throw Object.assign(new Error(`No stored Microsoft account named "${wanted}" (have: ${accounts.map((a) => a.name).join(', ')})`), {
        code: 'unknown_account',
      });
    }
    const session = (await readStore(accountsFile(paths)))[match.name];
    await rm(storeFile(location, OFFLINE), { force: true });
    await writeStore(storeFile(location, MICROSOFT), { [match.name]: session });
    await writeStore(lastUsedFile(location), { latest: [{ provider: MICROSOFT, name: match.name }] });
    return match.name;
  });
}

/** Copies a Microsoft session refreshed by a launch back into the `calcite login` store. */
export async function syncAccount(paths: CalcitePaths, location: string, name: string): Promise<void> {
  const local = await readStore(storeFile(location, MICROSOFT));
  const key = findKey(local, name);
  if (!key) return;
  await withLock(accountsLock(paths), async () => {
    const accounts = await readStore(accountsFile(paths));
    const central = findKey(accounts, name);
    if (!central || JSON.stringify(accounts[central]) === JSON.stringify(local[key])) return; // removed meanwhile, or unchanged
    accounts[central] = local[key];
    await writeStore(accountsFile(paths), accounts);
  });
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
 * in Calcite's HeadlessMC location and refreshed automatically on every launch.
 */
export async function startLogin(paths: CalcitePaths, { timeoutMs = 15 * 60_000 } = {}): Promise<LoginHandle> {
  const java = await ensureLauncherJava(paths);
  const hmcJar = await ensureHmc(paths);
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
    location: accountsHome(paths),
    command: ['login'],
    onLine: (line) => {
      const go = /To login visit (https?:\/\/\S+)/.exec(line);
      if (go) resolveUrl(go[1]);
      const ok = /Logged in to account (.+?) successfully/.exec(line);
      if (ok) account = ok[1];
      if (/AuthException|Failed to login|You can't play|Exception:/.test(line) && !failure) failure = line.trim();
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
    await chmod(accountsFile(paths), 0o600).catch(() => undefined);
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
