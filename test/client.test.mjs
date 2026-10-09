import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseServer, CalciteError, Client } from '../dist/client.js';
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
