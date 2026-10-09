import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseServer, parseWorld, CalciteError, Client } from '../dist/client.js';
import { resolvePaths } from '../dist/paths.js';

test('parseServer', () => {
  assert.deepEqual(parseServer('mc.example.com'), { host: 'mc.example.com', port: 25565 });
  assert.deepEqual(parseServer('127.0.0.1:25570'), { host: '127.0.0.1', port: 25570 });
  assert.deepEqual(parseServer('[::1]:1234'), { host: '::1', port: 1234 });
  assert.deepEqual(parseServer('[::1]'), { host: '::1', port: 25565 });
  assert.deepEqual(parseServer({ host: 'a', port: 0 }), { host: 'a', port: 25565 });
});

test('Client validates names', () => {
  assert.throws(() => new Client({ name: 'bad name', version: '1.21.11' }), CalciteError);
  assert.throws(() => new Client({ name: 'ok', version: '1.21.11', account: { type: 'offline', username: 'x' } }), CalciteError);
  const c = new Client({ name: 'ok', version: '1.21.11', paths: resolvePaths('/tmp/calcite-unused') });
  assert.equal(c.phase, 'idle');
});

test('Client rejects mods without a loader', () => {
  assert.throws(() => new Client({ name: 'm', version: '1.21.11', mods: ['x.jar'], paths: resolvePaths('/tmp/calcite-unused') }), /loader/);
  assert.throws(
    () => new Client({ name: 'm', version: '1.21.11', loader: 'quilt', paths: resolvePaths('/tmp/calcite-unused') }),
    /Unknown mod loader/,
  );
});

test('parseWorld fills defaults and checks the save name', () => {
  assert.deepEqual(parseWorld('My World_2'), { name: 'My World_2', create: true, gameMode: 'survival' });
  assert.equal(parseWorld('生存测试').name, '生存测试');
  assert.deepEqual(parseWorld({ name: 'w', gameMode: 'creative', create: false, seed: '42' }), {
    name: 'w',
    create: false,
    gameMode: 'creative',
    seed: '42',
  });
  for (const bad of ['', ' padded', 'trailing ', '../up', 'a/b', 'x'.repeat(65)]) {
    assert.throws(
      () => parseWorld(bad),
      (err) => err instanceof CalciteError && err.code === 'bad_world',
      bad,
    );
  }
});

test('Client takes a server or a world, not both', () => {
  const paths = resolvePaths('/tmp/calcite-unused');
  assert.throws(() => new Client({ name: 'w', version: '1.21.11', server: 'a', world: 'b', paths }), /either a server or a world/);
  const c = new Client({ name: 'w', version: '1.21.11', world: 'Survival', paths });
  assert.deepEqual(c.status().world, { name: 'Survival', create: true, gameMode: 'survival' });
  assert.equal(c.status().server, undefined);
});
