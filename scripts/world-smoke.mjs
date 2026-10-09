// Singleplayer: creates a fresh world, changes it, stops, and checks the change survived reopening the world.
// Usage: node scripts/world-smoke.mjs <version> [name]
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '../dist/index.js';
import { sleep, until } from './e2e.mjs';

const [version = '1.21.11', name = 'WorldBot'] = process.argv.slice(2);
const world = 'calcite-world-smoke';
const client = new Client({ name, version, world, render: 'off', account: { type: 'offline', username: name } });
client.on('phase', (p) => console.log(`[phase] ${p}`));
const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(label);
};
const diamonds = async () => (await client.inventory()).items.find((i) => i.id === 'minecraft:diamond')?.count ?? 0;

try {
  await rm(join(client.gameDir, 'saves', world), { recursive: true, force: true });
  await client.start();
  check('a new world is created and joined', client.phase === 'in_game', client.status().game?.player);
  await client.command('give @s diamond 7');
  check('commands are allowed in a new world', (await until(async () => (await diamonds()) === 7)) === true, await diamonds());
  await client.stop();
  check('stop leaves the client stopped', client.phase === 'stopped');

  await client.start();
  check('the existing world is opened again', client.phase === 'in_game');
  await sleep(1000);
  check('the inventory was saved on stop', (await diamonds()) === 7, await diamonds());
  console.log(failures.length ? `WORLD FAILED: ${failures.join(', ')}` : 'WORLD OK');
  process.exitCode = failures.length ? 1 : 0;
} catch (err) {
  console.error('WORLD FAILED:', err.code ?? '', err.message);
  console.error(
    client
      .logsSince({ limit: 30 })
      .map((l) => `  ${l.source}: ${l.line}`)
      .join('\n'),
  );
  process.exitCode = 1;
} finally {
  await client.stop();
}
