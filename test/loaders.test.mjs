import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CalciteError } from '../dist/client.js';
import { compareBuilds, findLoader, loaderBuild, parseLoader } from '../dist/loaders.js';
import { resolvePaths } from '../dist/paths.js';
import { hmcVersionArgs } from '../dist/hmc.js';
import { tempDir } from './helpers.mjs';

test('parseLoader and loader version ids', () => {
  assert.equal(parseLoader(undefined), undefined);
  assert.equal(parseLoader('vanilla'), undefined);
  assert.deepEqual(parseLoader('Fabric'), { kind: 'fabric', build: undefined });
  assert.deepEqual(parseLoader('neoforge@21.11.45'), { kind: 'neoforge', build: '21.11.45' });
  assert.throws(() => parseLoader('quilt'), CalciteError);
  assert.throws(() => parseLoader('forge@../x'), CalciteError);
  assert.equal(loaderBuild('fabric', 'fabric-loader-0.19.5-1.21.11', '1.21.11'), '0.19.5');
  assert.equal(loaderBuild('fabric', 'fabric-loader-0.19.5-1.21.1', '1.21.11'), undefined);
  assert.equal(loaderBuild('forge', '1.20.1-forge-47.4.26', '1.20.1'), '47.4.26');
  assert.equal(loaderBuild('neoforge', 'neoforge-21.11.45', '1.21.11'), '21.11.45');
  assert.ok(compareBuilds('0.19.10', '0.19.5') > 0);
  assert.ok(compareBuilds('21.11.45', '21.11.45-beta') < 0);
  assert.deepEqual(hmcVersionArgs('1.21.11'), ['1.21.11']);
  assert.deepEqual(hmcVersionArgs('1.21.11', { kind: 'fabric' }), ['fabric', '1.21.11']);
  assert.deepEqual(hmcVersionArgs('1.21.11', { kind: 'neoforge', build: '21.11.45' }), ['neoforge', '1.21.11', '45']);
  assert.deepEqual(hmcVersionArgs('26.3', { kind: 'neoforge', build: '26.3.7-beta' }), ['neoforge', '26.3', '7-beta']);
  assert.deepEqual(hmcVersionArgs('1.20.1', { kind: 'forge', build: '47.4.26' }), ['forge', '1.20.1', '47.4.26']);
});

test('findLoader picks the requested or newest installed build', async (t) => {
  const home = await tempDir(t, 'calcite-loader-');
  const paths = resolvePaths(home);
  for (const [id, inherits] of [
    ['fabric-loader-0.19.5-1.21.11', '1.21.11'],
    ['fabric-loader-0.19.10-1.21.11', '1.21.11'],
    ['neoforge-21.1.200', '1.21.1'],
  ]) {
    await mkdir(join(paths.minecraft, 'versions', id), { recursive: true });
    await writeFile(join(paths.minecraft, 'versions', id, `${id}.json`), JSON.stringify({ id, inheritsFrom: inherits }));
  }
  assert.equal((await findLoader(paths, '1.21.11', { kind: 'fabric' }))?.build, '0.19.10');
  assert.equal((await findLoader(paths, '1.21.11', { kind: 'fabric', build: '0.19.5' }))?.id, 'fabric-loader-0.19.5-1.21.11');
  assert.equal(await findLoader(paths, '1.21.11', { kind: 'neoforge' }), undefined);
  assert.equal((await findLoader(paths, '1.21.1', { kind: 'neoforge' }))?.build, '21.1.200');
});
