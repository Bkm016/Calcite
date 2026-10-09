import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseOptions, serializeOptions, writeOptions, defaultOptions } from '../dist/options.js';
import { tempDir } from './helpers.mjs';

test('options merge keeps user keys and overrides managed ones', async (t) => {
  const dir = await tempDir(t, 'calcite-opt-');
  await writeFile(join(dir, 'options.txt'), 'lang:de_de\nrenderDistance:32\nkey_key.jump:key.keyboard.space\n');
  await writeOptions(dir, defaultOptions({ renderDistance: 6 }));
  const map = parseOptions(await readFile(join(dir, 'options.txt'), 'utf8'));
  assert.equal(map.get('lang'), 'de_de');
  assert.equal(map.get('renderDistance'), '6');
  assert.equal(map.get('onboardAccessibility'), 'false');
  assert.equal(map.get('key_key.jump'), 'key.keyboard.space');
  assert.equal(parseOptions(serializeOptions(map)).size, map.size);
});
