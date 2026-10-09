import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import {
  BackendWatch,
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
