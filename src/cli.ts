#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { listAccounts, removeAccount, startLogin } from './accounts.js';
import { Client, defaultUsername, installVersion, type Account, type GameEvent, type RenderMode } from './client.js';
import { hasSharedLib, which } from './display.js';
import { findJavaInstalls } from './java.js';
import { setLogLevel } from './log.js';
import { getManifest } from './mojang.js';
import { runMcpStdio } from './mcp/index.js';
import { resolvePaths } from './paths.js';
import { runRepl } from './repl.js';
import { VERSION } from './version.js';

const out = (line = '') => process.stdout.write(`${line}\n`);

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

function fail(err: unknown): never {
  const e = err as Error & { code?: string };
  process.stderr.write(`error${e.code ? ` [${e.code}]` : ''}: ${e.message}\n`);
  process.exit(1);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface LaunchOptions {
  name: string;
  mcVersion: string;
  loader?: string;
  mod: string[];
  ext: string[];
  username?: string;
  microsoft?: string | true;
  render: RenderMode;
  java?: string;
  javaDownload: boolean;
  memory: string;
  reconnect: boolean;
}

const program = new Command()
  .name('calcite')
  .description('Run real Minecraft clients headlessly for testing and AI agents')
  .version(VERSION, '--version') // -V is the launch command's --mc-version
  .option('-v, --verbose', 'debug logging')
  .hook('preAction', (cmd) => {
    if (cmd.opts<{ verbose?: boolean }>().verbose) setLogLevel('debug');
  });

program
  .command('launch')
  .description('Launch a client and control it from the terminal')
  .argument('[server]', 'host[:port] to join')
  .option('-n, --name <name>', 'client / instance name', 'calcite')
  .option('-V, --mc-version <version>', 'Minecraft version, "release" or "snapshot"', 'release')
  .option('-l, --loader <loader>', 'mod loader: fabric, forge or neoforge, optionally @version (e.g. fabric@0.19.5)')
  .option('--mod <spec>', 'mod jar, folder, URL or modrinth:<project>[@version] (repeatable; needs --loader)', collect, [])
  .option('--ext <jar>', 'probe extension jar or URL (repeatable)', collect, [])
  .option('-u, --username <name>', 'offline username (default: the client name)')
  .option('-m, --microsoft [account]', 'use a stored Microsoft account (primary one, or by name)')
  .addOption(new Option('-r, --render <mode>', 'renderer mode').choices(['on-demand', 'always', 'off']).default('on-demand'))
  .option('--java <path>', 'java executable to use')
  .option('--no-java-download', 'never download a Java runtime')
  .option('--memory <size>', 'max heap, e.g. 2G', '2G')
  .option('--no-reconnect', 'do not rejoin after a disconnect or crash')
  .action(async (server: string | undefined, o: LaunchOptions) => {
    const account: Account = o.microsoft
      ? { type: 'microsoft', name: typeof o.microsoft === 'string' ? o.microsoft : undefined }
      : { type: 'offline', username: o.username ?? defaultUsername(o.name) };
    const client = new Client({
      name: o.name,
      version: o.mcVersion,
      loader: o.loader,
      mods: o.mod,
      extensions: o.ext,
      server,
      account,
      render: o.render,
      javaPath: o.java,
      allowJavaDownload: o.javaDownload,
      memory: o.memory,
      reconnect: o.reconnect,
    });
    client.on('phase', (p) => process.stderr.write(`[${p}]\n`));
    client.on('chat', (c) => out(c.message));
    client.on('event', (e: GameEvent) => process.stderr.write(`[${e.name}] ${JSON.stringify(e.data)}\n`));
    let stopping = false;
    const stop = async (code = 0) => {
      if (stopping) return;
      stopping = true;
      await client.stop();
      process.exit(code);
    };
    process.once('SIGINT', () => void stop(130));
    process.once('SIGTERM', () => void stop(143));
    try {
      await client.start();
    } catch (err) {
      process.stderr.write(
        client
          .logsSince({ limit: 30 })
          .map((l) => `  ${l.line}`)
          .join('\n') + '\n',
      );
      await client.stop();
      fail(err);
    }
    await runRepl(client);
    await stop();
  });

program
  .command('install')
  .description('Download a version (client, libraries, assets, Java, mod loader) without launching')
  .argument('[version]', 'version id, "release" or "snapshot"', 'release')
  .option('-l, --loader <loader>', 'also install a mod loader: fabric, forge or neoforge, optionally @version')
  .option('--java <path>', 'java executable to use')
  .action(async (version: string, o: { loader?: string; java?: string }) => {
    try {
      const r = await installVersion(version, { loader: o.loader, javaPath: o.java, onLine: (l) => process.stderr.write(`  ${l}\n`) });
      out(`installed ${r.id}${r.loader ? ` with ${r.loader}` : ''} (java ${r.java}; probe ${r.probe})`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('versions')
  .description('List Minecraft versions')
  .addOption(
    new Option('-t, --type <type>', 'version type').choices(['release', 'snapshot', 'old_beta', 'old_alpha', 'all']).default('release'),
  )
  .option('-l, --limit <n>', 'how many', positiveInt, 20)
  .action(async (o: { type: string; limit: number }) => {
    try {
      const manifest = await getManifest(resolvePaths());
      out(`latest release ${manifest.latest.release}, snapshot ${manifest.latest.snapshot}`);
      for (const v of manifest.versions.filter((v) => o.type === 'all' || v.type === o.type).slice(0, o.limit)) {
        out(`${v.id.padEnd(24)} ${v.type.padEnd(9)} ${v.releaseTime.slice(0, 10)}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('login')
  .description('Log in with a Microsoft account (device code); the login is saved and refreshed automatically')
  .action(async () => {
    try {
      const handle = await startLogin(resolvePaths());
      process.once('SIGINT', () => void handle.cancel().then(() => process.exit(130)));
      out(`Open this URL in a browser and sign in:\n\n  ${await handle.url}\n`);
      out(`Logged in as ${await handle.done}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('accounts')
  .description('List saved Microsoft accounts')
  .action(async () => {
    try {
      const accounts = await listAccounts(resolvePaths());
      if (!accounts.length) out('No saved accounts. Run `calcite login`.');
      for (const a of accounts) out(`${a.primary ? '*' : ' '} ${a.name}${a.uuid ? `  ${a.uuid}` : ''}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('logout')
  .description('Remove a saved Microsoft account')
  .argument('<account>', 'profile name')
  .action(async (name: string) => {
    try {
      if (!(await removeAccount(resolvePaths(), name)))
        fail(Object.assign(new Error(`No saved account named "${name}"`), { code: 'unknown_account' }));
      out(`Removed ${name}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('doctor')
  .description('Check the environment')
  .action(async () => {
    const paths = resolvePaths();
    out(`calcite ${VERSION} on node ${process.versions.node} (${process.platform}/${process.arch})`);
    out(`home:  ${paths.home}`);
    out(`probe: ${paths.probe}`);
    const javas = await findJavaInstalls(paths);
    out(`java:  ${javas.length ? '' : 'none found (will be downloaded on demand)'}`);
    for (const j of javas) out(`  ${String(j.major).padStart(2)}  ${j.version.padEnd(12)} ${j.path}`);
    if (process.platform === 'linux') {
      const xvfb = which('Xvfb');
      out(`xvfb:  ${xvfb ?? 'missing — needed for screenshots without a display (apt install xvfb libgl1-mesa-dri libegl1 libegl-mesa0)'}`);
      out(
        `egl:   ${hasSharedLib('libEGL.so.1') ? 'ok' : 'missing — Minecraft 26.x needs it to render on Xvfb (apt install libegl1 libegl-mesa0)'}`,
      );
      out(`display: ${process.env.DISPLAY ?? 'none (a virtual one will be started)'}`);
    }
    try {
      const accounts = await listAccounts(paths);
      out(`accounts: ${accounts.map((a) => a.name).join(', ') || 'none'}`);
    } catch (err) {
      out(`accounts: unreadable (${(err as Error).message})`);
    }
    try {
      const m = await getManifest(paths, { refresh: true });
      out(`mojang: reachable (latest ${m.latest.release})`);
    } catch (err) {
      out(`mojang: UNREACHABLE (${(err as Error).message})`);
    }
  });

program
  .command('mcp')
  .description('Run the MCP server on stdio')
  .addOption(new Option('-r, --render <mode>', 'default renderer mode').choices(['on-demand', 'always', 'off']))
  .option('--memory <size>', 'default max heap')
  .option('--ext <jar>', 'probe extension jar or URL loaded into every client (repeatable)', collect, [])
  .action(async (o: { render?: RenderMode; memory?: string; ext: string[] }) => {
    // stdout belongs to the protocol; logs go to stderr
    await runMcpStdio({ defaults: { render: o.render, memory: o.memory, extensions: o.ext.length ? o.ext : undefined } });
  });

program.parseAsync().catch(fail);
