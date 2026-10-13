import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearPluginData, offlineUuid, serverProperties } from '../dist/paper.js';

test('offlineUuid matches the server-side offline player UUID', () => {
  assert.equal(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
});

test('serverProperties sets test defaults that overrides can replace', () => {
  const props = serverProperties(25600, { difficulty: 'normal', 'max-players': '5' }).trim().split('\n');
  assert.ok(props.includes('server-port=25600'));
  assert.ok(props.includes('online-mode=false'));
  assert.ok(props.includes('difficulty=normal'));
  assert.ok(!props.includes('difficulty=peaceful'));
  assert.ok(props.includes('max-players=5'));
});

test('clearPluginData removes plugin data folders but keeps jars and caches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'calcite-paper-'));
  try {
    const plugins = join(dir, 'plugins');
    await mkdir(join(plugins, 'Primordium'), { recursive: true });
    await writeFile(join(plugins, 'Primordium', 'instances.properties'), 'a=1');
    await mkdir(join(plugins, '.paper-remapped'), { recursive: true });
    await writeFile(join(plugins, 'Primordium.jar'), 'jar');
    await clearPluginData(dir);
    assert.deepEqual((await readdir(plugins)).sort(), ['.paper-remapped', 'Primordium.jar']);
    await clearPluginData(join(dir, 'missing')); // no plugins folder yet
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
