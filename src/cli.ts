#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Command, InvalidArgumentError, Option } from 'commander';
import { listAccounts, removeAccount, startLogin } from './accounts.js';
import { Client, defaultUsername, installVersion, type Account, type ClickMode, type RenderMode } from './client.js';
import { hasSharedLib, which } from './display.js';
import { findJavaInstalls } from './java.js';
import { setLogLevel } from './log.js';
import { getManifest } from './mojang.js';
import { runMcpStdio } from './mcp.js';
import { resolvePaths } from './paths.js';
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

const json = (value: unknown) => out(JSON.stringify(value, null, 2));

/** Interactive action commands of `calcite launch`; returns false for unknown commands. */
async function action(client: Client, line: string): Promise<boolean> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const n = rest.map(Number);
  const need = (count: number) => {
    if (n.length < count || n.slice(0, count).some((v) => !Number.isFinite(v))) throw new Error(`:${cmd} needs ${count} numbers`);
  };
  switch (cmd) {
    case 'look':
      need(2);
      json(await client.look({ yaw: n[0], pitch: n[1] }));
      return true;
    case 'lookat':
      need(3);
      json(await client.look({ x: n[0], y: n[1], z: n[2] }));
      return true;
    case 'goto':
      need(2);
      json(await client.walkTo(n[0], n[1]));
      return true;
    case 'move': {
      const controls = Object.fromEntries((rest[0] ?? '').split(',').filter(Boolean).map((c) => [c, true]));
      json(await client.move(controls, { ticks: rest[1] ? Number(rest[1]) : 20 }));
      return true;
    }
    case 'stop':
      await client.stopActions();
      return true;
    case 'attack':
      json(await client.attack(rest[0] ? Number(rest[0]) : undefined));
      return true;
    case 'use':
      if (rest.length >= 3) {
        need(3);
        json(await client.use({ block: { x: n[0], y: n[1], z: n[2] }, holdTicks: n[3] || undefined }));
      } else {
        json(await client.use({ entityId: rest[0] ? n[0] : undefined, holdTicks: n[1] || undefined }));
      }
      return true;
    case 'dig':
      need(3);
      json(await client.dig({ x: n[0], y: n[1], z: n[2] }));
      return true;
    case 'block':
      need(3);
      json(await client.block({ x: n[0], y: n[1], z: n[2] }));
      return true;
    case 'target':
      json(await client.target());
      return true;
    case 'inv':
      json(await client.inventory());
      return true;
    case 'slot':
      need(1);
      json(await client.selectSlot(n[0]));
      return true;
    case 'container':
      json(await client.container());
      return true;
    case 'click':
      need(1);
      json(await client.click(n[0], { button: rest[1] ? n[1] : 0, mode: (rest[2] as ClickMode) ?? 'pickup' }));
      return true;
    case 'close':
      await client.closeContainer();
      return true;
    case 'drop':
      json(await client.drop({ all: rest[0] === 'all' }));
      return true;
    default:
      return false;
  }
}

const program = new Command()
  .name('calcite')
  .description('Run real Minecraft clients headlessly for testing and AI agents')
  .version(VERSION)
  .option('-v, --verbose', 'debug logging')
  .hook('preAction', (cmd) => {
    if (cmd.opts().verbose) setLogLevel('debug');
  });

program
  .command('launch')
  .description('Launch a client and control it from the terminal')
  .argument('[server]', 'host[:port] to join')
  .option('-n, --name <name>', 'client / instance name', 'calcite')
  .option('-V, --mc-version <version>', 'Minecraft version, "release" or "snapshot"', 'release')
  .option('-u, --username <name>', 'offline username (default: the client name)')
  .option('-m, --microsoft [account]', 'use a stored Microsoft account (primary one, or by name)')
  .addOption(new Option('-r, --render <mode>', 'renderer mode').choices(['on-demand', 'always', 'off']).default('on-demand'))
  .option('--java <path>', 'java executable to use')
  .option('--no-java-download', 'never download a Java runtime')
  .option('--memory <size>', 'max heap, e.g. 2G', '2G')
  .option('--no-reconnect', 'do not rejoin after a disconnect or crash')
  .action(async (server: string | undefined, o) => {
    const account: Account = o.microsoft
      ? { type: 'microsoft', name: typeof o.microsoft === 'string' ? o.microsoft : undefined }
      : { type: 'offline', username: o.username ?? defaultUsername(o.name) };
    const client = new Client({
      name: o.name,
      version: o.mcVersion,
      server,
      account,
      render: o.render as RenderMode,
      javaPath: o.java,
      allowJavaDownload: o.javaDownload,
      memory: o.memory,
      reconnect: o.reconnect,
    });
    client.on('phase', (p) => process.stderr.write(`[${p}]\n`));
    client.on('chat', (c) => out(c.message));
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
      process.stderr.write(client.logsSince({ limit: 30 }).map((l) => `  ${l.line}`).join('\n') + '\n');
      await client.stop();
      fail(err);
    }
    process.stderr.write(
      'Ready. Type chat, /command, or :state :ents [radius] :shot [file] :render on|off :respawn :quit\n' +
        'Actions: :look yaw pitch | :lookat x y z | :goto x z | :move forward,jump [ticks] | :stop | :attack [id] | :use [id | x y z] [hold]\n' +
        '         :dig x y z | :block x y z | :target | :inv | :slot n | :container | :click slot [button] [mode] | :close | :drop [all]\n',
    );
    const rl = createInterface({ input: process.stdin });
    rl.on('close', () => void stop());
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      try {
        if (line === ':quit' || line === ':q') break;
        else if (line === ':state') out(JSON.stringify(await client.state(), null, 2));
        else if (line.startsWith(':ents')) {
          const radius = Number(line.split(/\s+/)[1] ?? 32);
          for (const e of await client.entities({ radius })) {
            out(`${e.id}\t${e.type}\t${e.name ?? ''}${e.customName ? ` (${e.customName})` : ''}\t${e.x?.toFixed(1)} ${e.y?.toFixed(1)} ${e.z?.toFixed(1)}`);
          }
        } else if (line.startsWith(':shot')) {
          const file = line.split(/\s+/)[1] ?? `calcite-${Date.now()}.png`;
          const shot = await client.screenshot();
          await writeFile(file, shot.png);
          out(`saved ${file} (${shot.png.length} bytes)`);
        } else if (line.startsWith(':render')) {
          await client.setRender(line.endsWith('on'));
        } else if (line === ':respawn') await client.respawn();
        else if (line.startsWith(':') && (await action(client, line))) {
          // handled
        } else if (line.startsWith('/')) await client.command(line.slice(1));
        else if (line.startsWith(':')) process.stderr.write(`unknown command ${line}\n`);
        else await client.chat(line);
      } catch (err) {
        process.stderr.write(`error: ${(err as Error).message}\n`);
      }
    }
    await stop();
  });

program
  .command('install')
  .description('Download a version (client, libraries, assets, Java) without launching')
  .argument('[version]', 'version id, "release" or "snapshot"', 'release')
  .option('--java <path>', 'java executable to use')
  .action(async (version: string, o) => {
    try {
      const r = await installVersion(version, { javaPath: o.java, onLine: (l) => process.stderr.write(`  ${l}\n`) });
      out(`installed ${r.id} (java ${r.java}; probe ${r.probe})`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('versions')
  .description('List Minecraft versions')
  .addOption(new Option('-t, --type <type>', 'version type').choices(['release', 'snapshot', 'old_beta', 'old_alpha', 'all']).default('release'))
  .option('-l, --limit <n>', 'how many', positiveInt, 20)
  .action(async (o) => {
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
      if (!(await removeAccount(resolvePaths(), name))) fail(Object.assign(new Error(`No saved account named "${name}"`), { code: 'unknown_account' }));
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
      out(`egl:   ${hasSharedLib('libEGL.so.1') ? 'ok' : 'missing — Minecraft 26.x needs it to render on Xvfb (apt install libegl1 libegl-mesa0)'}`);
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
  .action(async (o) => {
    // stdout belongs to the protocol; logs go to stderr
    await runMcpStdio({ defaults: { render: o.render, memory: o.memory } });
  });

program.parseAsync().catch(fail);
