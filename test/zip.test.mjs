import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readZipEntry, zipContains } from '../dist/zip.js';
import { tempDir } from './helpers.mjs';

test('zipContains reads the central directory', async (t) => {
  const dir = await tempDir(t, 'calcite-zip-');
  const { execFileSync } = await import('node:child_process');
  const { jdkTool } = await import('../scripts/build-probe.mjs');
  await writeFile(join(dir, 'A.txt'), 'a');
  await writeFile(join(dir, 'C.txt'), 'calcite '.repeat(500));
  execFileSync(jdkTool('jar'), ['cf', join(dir, 't.jar'), '-C', dir, 'A.txt', '-C', dir, 'C.txt']);
  execFileSync(jdkTool('jar'), ['cf0', join(dir, 's.jar'), '-C', dir, 'C.txt']);
  assert.equal(await zipContains(join(dir, 't.jar'), 'A.txt'), true);
  assert.equal(await zipContains(join(dir, 't.jar'), 'B.txt'), false);
  assert.equal((await readZipEntry(join(dir, 't.jar'), 'C.txt'))?.toString(), 'calcite '.repeat(500));
  assert.equal((await readZipEntry(join(dir, 's.jar'), 'C.txt'))?.toString(), 'calcite '.repeat(500));
  assert.equal(await readZipEntry(join(dir, 't.jar'), 'B.txt'), null);
});
