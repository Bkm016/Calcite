import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolvePaths } from '../dist/paths.js';
import { listAccounts, offlineUuid, prepareAccount, removeAccount, syncAccount } from '../dist/accounts.js';
import { tempDir } from './helpers.mjs';

test('accounts store parsing, instance preparation and removal', async (t) => {
  const home = await tempDir(t, 'calcite-acc-');
  const paths = resolvePaths(home);
  const auth = join(paths.hmcHome, '.auth');
  await mkdir(join(auth, 'default'), { recursive: true });
  await mkdir(join(auth, 'last'), { recursive: true });
  const session = (name, id, token) => ({ minecraftProfile: { value: { id, name } }, token });
  await writeFile(
    join(auth, 'default', '.accounts.json'),
    JSON.stringify({ accounts: { Alice: session('Alice', 'a-1', 1), Bob: session('Bob', 'b-2', 1) }, version: 0 }),
  );
  await writeFile(
    join(auth, 'last', '.accounts.json'),
    JSON.stringify({ accounts: { latest: [{ provider: 'default', name: 'Bob' }] }, version: 0 }),
  );
  assert.deepEqual(
    (await listAccounts(paths)).map((a) => [a.name, a.uuid, a.primary]),
    [
      ['Alice', 'a-1', false],
      ['Bob', 'b-2', true],
    ],
  );

  // a client location gets exactly the chosen session; a refreshed session is copied back
  const loc = join(home, 'instance');
  assert.equal(await prepareAccount(paths, loc, { type: 'microsoft' }), 'Bob');
  assert.equal(await prepareAccount(paths, loc, { type: 'microsoft', name: 'alice' }), 'Alice');
  const local = JSON.parse(await readFile(join(loc, '.auth', 'default', '.accounts.json'), 'utf8'));
  assert.deepEqual(Object.keys(local.accounts), ['Alice']);
  assert.deepEqual(JSON.parse(await readFile(join(loc, '.auth', 'last', '.accounts.json'), 'utf8')).accounts.latest, [
    { provider: 'default', name: 'Alice' },
  ]);
  local.accounts.Alice.token = 2;
  await writeFile(join(loc, '.auth', 'default', '.accounts.json'), JSON.stringify(local));
  await syncAccount(paths, loc, 'Alice');
  assert.equal(JSON.parse(await readFile(join(auth, 'default', '.accounts.json'), 'utf8')).accounts.Alice.token, 2);
  await assert.rejects(prepareAccount(paths, loc, { type: 'microsoft', name: 'Carol' }), (e) => e.code === 'unknown_account');

  assert.equal(await prepareAccount(paths, loc, { type: 'offline', username: 'Notch' }), 'Notch');
  const offline = JSON.parse(await readFile(join(loc, '.auth', 'offline', '.accounts.json'), 'utf8'));
  assert.equal(offline.accounts.Notch.uuid, 'b50ad385829d3141a2167e7d7539ba7f');
  assert.equal(offlineUuid('Notch'), 'b50ad385829d3141a2167e7d7539ba7f');
  await assert.rejects(readFile(join(loc, '.auth', 'default', '.accounts.json')));

  assert.equal(await removeAccount(paths, 'alice'), true);
  assert.deepEqual(
    (await listAccounts(paths)).map((a) => a.name),
    ['Bob'],
  );
  assert.equal(await removeAccount(paths, 'nobody'), false);
});
