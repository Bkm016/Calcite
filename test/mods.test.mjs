import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveExtensions, syncMods } from '../dist/mods.js';
import { resolvePaths } from '../dist/paths.js';
import { tempDir } from './helpers.mjs';

test('syncMods replaces only the mods Calcite placed', async (t) => {
  const dir = await tempDir(t, 'calcite-mods-');
  await writeFile(join(dir, 'a.jar'), 'a');
  await writeFile(join(dir, 'b.jar'), 'b');
  const game = join(dir, 'game');
  await mkdir(join(game, 'mods'), { recursive: true });
  await writeFile(join(game, 'mods', 'mine.jar'), 'user');
  await syncMods(game, [
    { name: 'a.jar', file: join(dir, 'a.jar'), source: 'a' },
    { name: 'b.jar', file: join(dir, 'b.jar'), source: 'b' },
  ]);
  assert.deepEqual((await readdir(join(game, 'mods'))).sort(), ['.calcite-mods.json', 'a.jar', 'b.jar', 'mine.jar']);
  await syncMods(game, [{ name: 'b.jar', file: join(dir, 'b.jar'), source: 'b' }]);
  assert.deepEqual((await readdir(join(game, 'mods'))).sort(), ['.calcite-mods.json', 'b.jar', 'mine.jar']);
  await syncMods(game, []);
  assert.deepEqual(await readdir(join(game, 'mods')), ['mine.jar']);
});

test('resolveExtensions accepts local jars and rejects missing ones', async (t) => {
  const dir = await tempDir(t, 'calcite-ext-');
  const jar = join(dir, 'e.jar');
  await writeFile(jar, 'x');
  const paths = resolvePaths(join(dir, 'home'));
  assert.deepEqual(await resolveExtensions(paths, [jar, jar, ' ']), [jar]);
  await assert.rejects(resolveExtensions(paths, [join(dir, 'missing.jar')]), (e) => e.code === 'extension_not_found');
  await assert.rejects(resolveExtensions(paths, [dir]), (e) => e.code === 'extension_not_found');
});
