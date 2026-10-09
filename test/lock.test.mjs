import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireLock } from '../dist/lock.js';
import { tempDir } from './helpers.mjs';

test('lock excludes a second holder and recovers from a dead owner', async (t) => {
  const dir = await tempDir(t, 'calcite-lock-');
  const lock = join(dir, 'l');
  const release = await acquireLock(lock, { timeoutMs: 0 });
  await assert.rejects(acquireLock(lock, { timeoutMs: 0 }));
  await release();
  const again = await acquireLock(lock, { timeoutMs: 0 });
  await again();
  // dead owner
  await mkdir(lock);
  await writeFile(join(lock, 'owner'), '999999999');
  const taken = await acquireLock(lock, { timeoutMs: 0 });
  await taken();
});
