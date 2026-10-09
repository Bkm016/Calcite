import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { GameRun } from '../dist/game-run.js';
import { tempDir } from './helpers.mjs';

const probe = { mappings: ['official'], version: '1.21.4', extensions: [], headless: true, render: 'off' };

test('a headless run writes the probe settings and removes them when disposed', async (t) => {
  const dir = join(await tempDir(t, 'calcite-run-'), 'probe');
  const run = await GameRun.open({ dir, name: 'bot', probe });
  assert.equal(run.display, null);
  assert.match(run.configFile, /bot-[0-9a-f]{12}\.properties$/);
  const settings = await readFile(run.configFile, 'utf8');
  assert.match(settings, new RegExp(`^port=${run.probe.port}$`, 'm'));
  assert.match(settings, new RegExp(`^token=${run.probe.token}$`, 'm'));

  const socket = connect(run.probe.port, '127.0.0.1');
  await once(socket, 'connect');
  socket.destroy();

  let ticks = 0;
  run.poll(() => ticks++, 5);
  run.poll(() => (ticks += 100), 5);
  await new Promise((r) => setTimeout(r, 30));
  await run.dispose();
  const after = ticks;
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(after > 0 && after < 100, 'only the first poller runs');
  assert.equal(ticks, after, 'disposing stops the poller');
  assert.deepEqual(await readdir(dir), []);
  await assert.rejects(new Promise((resolve, reject) => connect(run.probe.port, '127.0.0.1', resolve).once('error', reject)));
});

test('a run that cannot write its settings leaves nothing open', async (t) => {
  const file = join(await tempDir(t, 'calcite-run-'), 'not-a-dir');
  await writeFile(file, '');
  await assert.rejects(GameRun.open({ dir: file, name: 'bot', probe }));
});
