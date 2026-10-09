import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import {
  BackendWatch,
  reconnectDelay,
  reconnectLimit,
  waitForServer,
  gameJvmArgs,
  hmcLaunchCommand,
  hmcProperties,
  joinArgs,
  probeConfig,
  propValue,
  tcpReachable,
} from '../dist/launch.js';

test('propValue escapes properties syntax', () => {
  assert.equal(propValue('C:\\games\\a=b:c'), 'C\\:\\\\games\\\\a\\=b\\:c');
  assert.equal(propValue('plain'), 'plain');
});

test('probeConfig lists numbered entries in order', () => {
  const text = probeConfig({
    port: 4000,
    token: 'abc',
    mappings: ['/m/a b.txt', 'official'],
    version: '1.21.4',
    extensions: ['C:\\x.jar'],
    headless: true,
    render: 'always',
  });
  assert.deepEqual(text.split('\n'), [
    'port=4000',
    'token=abc',
    'mappings.1=/m/a b.txt',
    'mappings.2=official',
    'version=1.21.4',
    'extensions.1=C\\:\\\\x.jar',
    'headless=true',
    'render=on',
    'exitOnDisconnect=true',
    '',
  ]);
  assert.match(
    probeConfig({ port: 1, token: 't', mappings: [], version: 'v', extensions: [], headless: false, render: 'auto' }),
    /^render=off$/m,
  );
});

test('hmcLaunchCommand', () => {
  const base = { versionId: '1.21.4', offline: false, headless: false, jvmArgs: ['-Xmx2G'], gameArgs: [] };
  assert.deepEqual(hmcLaunchCommand(base), ['launch', '1.21.4', '--jvm="-Xmx2G"']);
  const full = hmcLaunchCommand({ ...base, offline: true, headless: true, gameArgs: ['--server', 'a b'] });
  assert.ok(full.includes('--offline') && full.includes('--headless'));
  assert.equal(full.at(-1)?.startsWith('--game='), true);
  assert.deepEqual(hmcLaunchCommand({ ...base, loader: { kind: 'fabric', build: '0.16.9' } }).slice(1, 4), ['fabric', '1.21.4', '0.16.9']);
});

test('joinArgs picks Quick Play or --server', () => {
  const server = { host: 'mc.local', port: 25566 };
  assert.deepEqual(joinArgs(server, true), ['--quickPlayMultiplayer', 'mc.local:25566']);
  assert.deepEqual(joinArgs(server, false), ['--server', 'mc.local', '--port', '25566']);
});

test('BackendWatch reports backend failures after the grace period', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reports = [];
  const watch = new BackendWatch((errors) => reports.push([...errors]), 1000);
  watch.line('x BackendCreationException: no OpenGL 3.3');
  t.mock.timers.tick(500);
  watch.line('x BackendCreationException: no Vulkan ');
  t.mock.timers.tick(999);
  assert.equal(reports.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(reports, [['no OpenGL 3.3', 'no Vulkan']]);
});

test('BackendWatch stands down once a backend comes up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stuck = false;
  const watch = new BackendWatch(() => (stuck = true), 1000);
  watch.line('BackendCreationException: no Vulkan');
  watch.line('Using graphics backend OpenGL');
  t.mock.timers.tick(5000);
  assert.equal(stuck, false);
  watch.line('BackendCreationException: again');
  watch.dispose();
  t.mock.timers.tick(5000);
  assert.equal(stuck, false);
});

test('tcpReachable', async () => {
  const server = createServer((s) => s.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await tcpReachable('127.0.0.1', port), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await tcpReachable('127.0.0.1', port, 500), false);
});

test('gameJvmArgs', () => {
  const saved = { ...process.env };
  try {
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];
    assert.deepEqual(gameJvmArgs({ headless: false }), ['-Xmx2G']);
    assert.deepEqual(gameJvmArgs({ headless: true, agent: 'probe.jar=a.properties', memory: '4G', extra: ['-Dx=1'] }), [
      '-Djoml.nounsafe=true',
      '-javaagent:probe.jar=a.properties',
      '-Xmx4G',
      '-Dx=1',
    ]);
  } finally {
    process.env = saved;
  }
});

test('hmcProperties', () => {
  const props = hmcProperties({
    minecraftDir: '/mc',
    gameDir: '/g',
    javaPath: '/jdk/bin/java',
    virtualDisplay: true,
    assetsVerified: false,
  });
  assert.equal(props['hmc.files.game'], '/g');
  assert.equal(props['hmc.xvfb.check'], 'true');
  assert.equal(props['hmc.assets.dummy'], 'false');
  assert.equal(props['hmc.java.download'], 'false');
});

test('waitForServer waits for the port to open', async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  const messages = [];
  const server = createServer((s) => s.destroy());
  setTimeout(() => server.listen(port, '127.0.0.1'), 150);
  await waitForServer(
    { host: '127.0.0.1', port },
    { timeoutMs: 5000, stopped: () => false, onWaiting: (m) => messages.push(m), retryMs: 20, reportMs: 50 },
  );
  server.close();
  assert.ok(messages.length > 0 && messages[0].startsWith(`still waiting for 127.0.0.1:${port}`), messages[0]);
});

test('waitForServer gives up or stops', async () => {
  const closed = { host: '127.0.0.1', port: 1 };
  const opts = { stopped: () => false, onWaiting: () => undefined, retryMs: 10 };
  await assert.rejects(waitForServer(closed, { ...opts, timeoutMs: 50 }), { code: 'server_unreachable' });
  await assert.rejects(waitForServer(closed, { ...opts, timeoutMs: 5000, stopped: () => true }), { code: 'stopped' });
});

test('reconnect policy', () => {
  assert.equal(reconnectLimit(undefined), 10);
  assert.equal(reconnectLimit(true), 10);
  assert.equal(reconnectLimit(false), 0);
  assert.equal(reconnectLimit({ maxAttempts: 3 }), 3);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(reconnectDelay), [5000, 10000, 20000, 40000, 60000, 60000]);
});
