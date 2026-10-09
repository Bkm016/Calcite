import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { PROBE_PROTOCOL, ProbeServer } from '../dist/probe-server.js';

/** A stand-in for the in-game probe: a socket plus a reader of the server's requests. */
async function fakeProbe(server, token = server.token) {
  const socket = connect(server.port, '127.0.0.1');
  await once(socket, 'connect');
  const send = (msg) => socket.write(JSON.stringify(msg) + '\n');
  send({ type: 'hello', token, protocol: PROBE_PROTOCOL, java: '21' });
  const requests = createInterface({ input: socket })[Symbol.asyncIterator]();
  const next = async () => JSON.parse((await requests.next()).value);
  return { socket, send, next };
}

async function started(t) {
  const server = new ProbeServer();
  await server.listen();
  t.after(() => server.close());
  return server;
}

test('requests round-trip once the probe authenticates', async (t) => {
  const server = await started(t);
  const connected = once(server, 'connected');
  const probe = await fakeProbe(server);
  await connected;
  assert.equal(server.connected, true);

  const ok = server.request('state', { full: true });
  const req = await probe.next();
  assert.deepEqual({ op: req.op, args: req.args }, { op: 'state', args: { full: true } });
  probe.send({ id: req.id, ok: true, result: { health: 20 } });
  assert.deepEqual(await ok, { health: 20 });

  const failed = server.request('dig');
  const req2 = await probe.next();
  probe.send({ id: req2.id, ok: false, code: 'unreachable', error: 'too far' });
  await assert.rejects(failed, { name: 'ProbeError', code: 'unreachable', message: 'too far' });
});

test('events are forwarded', async (t) => {
  const server = await started(t);
  const probe = await fakeProbe(server);
  await once(server, 'connected');
  const event = once(server, 'event');
  probe.send({ type: 'event', name: 'death', data: { cause: 'lava' }, time: 42 });
  assert.deepEqual((await event)[0], { name: 'death', data: { cause: 'lava' }, time: 42 });
});

test('a wrong token is rejected', async (t) => {
  const server = await started(t);
  const probe = await fakeProbe(server, 'wrong');
  await once(probe.socket, 'close');
  assert.equal(server.connected, false);
  await assert.rejects(server.request('state'), { code: 'not_connected' });
});

test('pending requests fail when the probe disconnects', async (t) => {
  const server = await started(t);
  const probe = await fakeProbe(server);
  await once(server, 'connected');
  const pending = server.request('walk');
  await probe.next();
  const disconnected = once(server, 'disconnected');
  probe.socket.destroy();
  await assert.rejects(pending, { code: 'disconnected' });
  await disconnected;
});

test('requests time out', async (t) => {
  const server = await started(t);
  await fakeProbe(server);
  await once(server, 'connected');
  await assert.rejects(server.request('slow', {}, 50), { code: 'timeout' });
});
