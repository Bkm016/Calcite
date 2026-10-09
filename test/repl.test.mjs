import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execute, formatSurroundings } from '../dist/repl.js';

/** Records every client call; methods return whatever {@code results} has for them. */
function fakeClient(results = {}) {
  const calls = [];
  const client = new Proxy(
    {},
    {
      get:
        (_target, method) =>
        (...args) => {
          calls.push([method, ...args]);
          return Promise.resolve(results[method]);
        },
    },
  );
  return { client, calls };
}

test('chat and slash commands go to the client', async () => {
  const { client, calls } = fakeClient();
  assert.equal(await execute(client, 'hello there'), undefined);
  assert.equal(await execute(client, '/time set day'), undefined);
  assert.deepEqual(calls, [
    ['chat', 'hello there'],
    ['command', 'time set day'],
  ]);
});

test('commands parse their arguments', async () => {
  const { client, calls } = fakeClient();
  await execute(client, ':goto 10 -20');
  await execute(client, ':lookat 1 2 3');
  await execute(client, ':use 4 5 6 10');
  await execute(client, ':move forward,jump 5');
  await execute(client, ':transfer oak_log 3 inventory');
  await execute(client, ':call ext:hello {"name": "a b"}');
  assert.deepEqual(calls, [
    ['walkTo', 10, -20, { y: undefined }],
    ['look', { x: 1, y: 2, z: 3 }],
    ['use', { block: { x: 4, y: 5, z: 6 }, holdTicks: 10 }],
    ['move', { forward: true, jump: true }, { ticks: 5 }],
    ['transfer', 'oak_log', { count: 3, to: 'inventory' }],
    ['call', 'ext:hello', { name: 'a b' }],
  ]);
});

test('results print as text or JSON', async () => {
  const { client } = fakeClient({ state: { health: 20 }, entities: [{ id: 7, type: 'pig', x: 1, y: 2, z: 3 }] });
  assert.equal(await execute(client, ':state'), '{\n  "health": 20\n}');
  assert.equal(await execute(client, ':ents'), '7\tpig\t\t1.0 2.0 3.0');
  assert.match(await execute(client, ':help'), /^ {2}:goto <x> <z> \[y\] +walk there along a path$/m);
});

test('bad input reports usage', async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(execute(client, ':goto 10'), { code: 'bad_request', message: 'usage: :goto <x> <z> [y]' });
  await assert.rejects(execute(client, ':dig 1 two 3'), { code: 'bad_request' });
  await assert.rejects(execute(client, ':nope'), { code: 'unknown_command' });
  await assert.rejects(execute(client, ':toString'), { code: 'unknown_command' });
  assert.deepEqual(calls, []);
});

test('formatSurroundings', () => {
  const text = formatSurroundings({
    x: 1,
    y: 64,
    z: -2.5,
    facing: 'north',
    biome: 'plains',
    dimension: 'overworld',
    timeOfDay: 1000,
    standingOn: 'grass_block',
    map: ['.#', '@.'],
    legend: '@ you, # stone',
    blocks: [{ id: 'stone', count: 3, nearest: [0, 63, 0] }],
    entities: [{ id: 9, type: 'cow', name: 'Bess', distance: 4 }],
  });
  assert.deepEqual(text.split('\n'), [
    '1.0 64.0 -2.5 facing north in plains (overworld), time 1000',
    'standing on grass_block',
    '  .#',
    '  @.',
    '  @ you, # stone',
    '    3  stone  nearest 0 63 0',
    'entity 9 cow "Bess" at 4m',
  ]);
});
