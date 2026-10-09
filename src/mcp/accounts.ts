import { z } from 'zod';
import { listAccounts, removeAccount, startLogin, type LoginHandle } from '../accounts.js';
import { CalciteError } from '../client.js';
import { tool, type ToolContext } from './shared.js';

interface PendingLogin {
  handle: LoginHandle;
  url?: string;
  account?: string;
  error?: string;
}

/** Microsoft accounts: device-code login, listing and removal. */
export function registerAccountTools({ server, paths }: ToolContext): void {
  const logins = new Map<number, PendingLogin>();
  let loginSeq = 0;

  tool(
    server,
    'account_list',
    { title: 'Stored Microsoft accounts', description: 'Microsoft accounts whose login is saved.', inputSchema: {} },
    async () => listAccounts(paths),
  );

  tool(
    server,
    'account_login_start',
    {
      title: 'Start Microsoft login',
      description:
        'Starts a Microsoft device login. Returns a URL the user must open in a browser and approve; then poll account_login_status. The session is saved and refreshed automatically.',
      inputSchema: {},
    },
    async () => {
      const id = ++loginSeq;
      const login: PendingLogin = { handle: await startLogin(paths) };
      logins.set(id, login);
      login.handle.done.then(
        (name) => (login.account = name),
        (e: unknown) => (login.error = (e as Error).message),
      );
      login.url = await login.handle.url;
      return { loginId: id, url: login.url, next: 'Ask the user to open the URL and sign in, then call account_login_status' };
    },
  );

  tool(
    server,
    'account_login_status',
    {
      title: 'Microsoft login status',
      description: 'Waits up to waitSeconds for a pending login started with account_login_start.',
      inputSchema: { loginId: z.number().int(), waitSeconds: z.number().min(0).max(120).default(30) },
    },
    async ({ loginId, waitSeconds }) => {
      const login = logins.get(loginId);
      if (!login) throw new CalciteError('unknown_login', `No login with id ${loginId}`);
      if (!login.account && !login.error) {
        await Promise.race([login.handle.done.catch(() => undefined), new Promise((r) => setTimeout(r, waitSeconds * 1000))]);
      }
      if (login.account) return { status: 'done', account: login.account };
      if (login.error) return { status: 'failed', error: login.error };
      return { status: 'pending', url: login.url };
    },
  );

  tool(
    server,
    'account_remove',
    { title: 'Remove a stored account', description: 'Deletes a saved Microsoft login.', inputSchema: { account: z.string() } },
    async ({ account }) => {
      if (!(await removeAccount(paths, account))) throw new CalciteError('unknown_account', `No stored account named "${account}"`);
      return `Removed ${account}`;
    },
  );
}
