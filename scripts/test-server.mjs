// A disposable Paper server for the end-to-end scripts: offline mode, a flat peaceful world, the bots as operators
// and ViaVersion/ViaBackwards so older clients can join. Files are cached in the given directory.
// Standalone: node scripts/test-server.mjs [dir] [port] — runs until interrupted.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { download } from '../dist/net.js';

const JARS = [
  {
    file: 'paper.jar',
    url: 'https://fill-data.papermc.io/v1/objects/5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba/paper-1.21.11-132.jar',
    sha256: '5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba',
  },
  {
    file: 'plugins/ViaVersion-5.12.0.jar',
    url: 'https://github.com/ViaVersion/ViaVersion/releases/download/5.12.0/ViaVersion-5.12.0.jar',
    sha256: '72c40a6a702d67f226fc9a0d8ad82aba1483fdabe2e6159bcdddb2dc070750b0',
  },
  {
    file: 'plugins/ViaBackwards-5.12.0.jar',
    url: 'https://github.com/ViaVersion/ViaBackwards/releases/download/5.12.0/ViaBackwards-5.12.0.jar',
    sha256: '194e9250224632274d7b3c17e411e031a9223c1863c6f5138d53c721f07ab78d',
  },
];

/** The UUID an offline-mode server gives a player name. */
export function offlineUuid(name) {
  const b = createHash('md5').update(`OfflinePlayer:${name}`).digest();
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  return port;
}

function properties(port) {
  return [
    `server-port=${port}`,
    'online-mode=false',
    'enforce-secure-profile=false',
    'level-type=minecraft\\:flat',
    'generate-structures=false',
    'spawn-protection=0',
    'difficulty=peaceful',
    'view-distance=6',
    'simulation-distance=4',
    'pause-when-empty-seconds=-1',
    'motd=Calcite e2e',
    '',
  ].join('\n');
}

/**
 * Starts the server and resolves once it accepts players.
 * Returns {address, command(line), stop()}; the world is recreated on every start.
 */
export async function startTestServer({ dir, port, operators = [], java = 'java', timeoutMs = 300_000 }) {
  dir = resolve(dir);
  port ??= await freePort();
  await Promise.all(JARS.map((j) => download(j.url, join(dir, j.file), { sha256: j.sha256 })));
  await rm(join(dir, 'world'), { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'eula.txt'), 'eula=true\n');
  await writeFile(join(dir, 'server.properties'), properties(port));
  const ops = operators.map((name) => ({ uuid: offlineUuid(name), name, level: 4, bypassesPlayerLimit: false }));
  await writeFile(join(dir, 'ops.json'), JSON.stringify(ops, null, 2));

  const proc = spawn(java, ['-Xmx1G', '-jar', 'paper.jar', '--nogui'], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: proc.stdout });
  const tail = [];
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Paper did not start within ${timeoutMs}ms:\n${tail.join('\n')}`)), timeoutMs);
    lines.on('line', (line) => {
      tail.push(line);
      if (tail.length > 40) tail.shift();
      if (/Done \(/.test(line)) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Paper exited with code ${code}:\n${tail.join('\n')}`));
    });
  });
  const command = (line) => proc.stdin.write(`${line}\n`);
  const stop = async () => {
    if (proc.exitCode !== null) return;
    command('stop');
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
    await once(proc, 'exit');
    clearTimeout(timer);
  };
  try {
    await ready;
  } catch (err) {
    proc.kill('SIGKILL');
    throw err;
  }
  command('gamerule immediate_respawn true');
  return { address: `127.0.0.1:${port}`, command, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir = '.e2e/paper', port] = process.argv.slice(2);
  const server = await startTestServer({ dir, port: port ? Number(port) : undefined, operators: ['ActBot'] });
  console.log(`Paper ready at ${server.address}; Ctrl+C stops it`);
  process.once('SIGINT', () => void server.stop().then(() => process.exit(0)));
}
