import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseServer, CalciteError, Client } from '../dist/client.js';
import { parseJavaSettings, pickJava } from '../dist/java.js';
import { supportsQuickPlay, requiredJavaMajor } from '../dist/mojang.js';
import { readZipEntry, zipContains } from '../dist/zip.js';
import { compareBuilds, findLoader, loaderBuild, parseLoader } from '../dist/loaders.js';
import { compose, parseMojang, parseTiny, parseTsrg } from '../dist/names.js';
import { resolveExtensions, syncMods } from '../dist/mods.js';
import { parseOptions, serializeOptions, writeOptions, defaultOptions } from '../dist/options.js';
import { bypassProxy, javaProxyProps, proxyFor } from '../dist/net.js';
import { resolvePaths, safeProbeDir } from '../dist/paths.js';
import { acquireLock } from '../dist/lock.js';
import { listAccounts, offlineUuid, prepareAccount, removeAccount, syncAccount } from '../dist/accounts.js';
import { hmcJavaHome, hmcListEntry, hmcQuote, hmcVersionArgs } from '../dist/hmc.js';

test('parseServer', () => {
  assert.deepEqual(parseServer('mc.example.com'), { host: 'mc.example.com', port: 25565 });
  assert.deepEqual(parseServer('127.0.0.1:25570'), { host: '127.0.0.1', port: 25570 });
  assert.deepEqual(parseServer('[::1]:1234'), { host: '::1', port: 1234 });
  assert.deepEqual(parseServer('[::1]'), { host: '::1', port: 25565 });
  assert.deepEqual(parseServer({ host: 'a', port: 0 }), { host: 'a', port: 25565 });
});

test('parseJavaSettings', () => {
  assert.deepEqual(parseJavaSettings('    java.specification.version = 1.8\n    java.version = 1.8.0_402\n'), { major: 8, version: '1.8.0_402' });
  assert.deepEqual(parseJavaSettings('    java.specification.version = 21\n    java.version = 21.0.5\n'), { major: 21, version: '21.0.5' });
  assert.equal(parseJavaSettings('garbage'), null);
});

test('pickJava prefers exact major, falls back to newer only for >8', () => {
  const installs = [
    { path: '/j8', major: 8, version: '1.8' },
    { path: '/j17', major: 17, version: '17' },
    { path: '/j21', major: 21, version: '21' },
  ];
  assert.equal(pickJava(installs, 17).path, '/j17');
  assert.equal(pickJava(installs, 16).path, '/j17');
  assert.equal(pickJava(installs.slice(1), 8), undefined);
  assert.equal(pickJava(installs, 25), undefined);
});

test('version json helpers', () => {
  assert.equal(supportsQuickPlay({ arguments: { game: [{ rules: [], value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}'] }] } }), true);
  assert.equal(supportsQuickPlay({ minecraftArguments: '--username ${auth_player_name}' }), false);
  assert.equal(requiredJavaMajor({}), 8);
  assert.equal(requiredJavaMajor({ javaVersion: { majorVersion: 21 } }), 21);
});

test('options merge keeps user keys and overrides managed ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'calcite-opt-'));
  try {
    await writeFile(join(dir, 'options.txt'), 'lang:de_de\nrenderDistance:32\nkey_key.jump:key.keyboard.space\n');
    await writeOptions(dir, defaultOptions({ renderDistance: 6 }));
    const map = parseOptions(await readFile(join(dir, 'options.txt'), 'utf8'));
    assert.equal(map.get('lang'), 'de_de');
    assert.equal(map.get('renderDistance'), '6');
    assert.equal(map.get('onboardAccessibility'), 'false');
    assert.equal(map.get('key_key.jump'), 'key.keyboard.space');
    assert.equal(parseOptions(serializeOptions(map)).size, map.size);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('NO_PROXY matching', () => {
  const rules = 'localhost,127.0.0.0/8,.internal.example,example.org,svc:8443';
  assert.equal(bypassProxy(new URL('http://localhost:80/'), rules), true);
  assert.equal(bypassProxy(new URL('https://127.5.6.7/'), rules), true);
  assert.equal(bypassProxy(new URL('https://a.internal.example/'), rules), true);
  assert.equal(bypassProxy(new URL('https://sub.example.org/'), rules), true);
  assert.equal(bypassProxy(new URL('https://notexample.org/'), rules), false);
  assert.equal(bypassProxy(new URL('https://svc:8443/'), rules), true);
  assert.equal(bypassProxy(new URL('https://svc/'), rules), false);
  assert.equal(bypassProxy(new URL('https://piston-meta.mojang.com/'), rules), false);
  assert.equal(bypassProxy(new URL('https://x/'), '*'), true);
});

test('proxyFor reads env', () => {
  const saved = { ...process.env };
  try {
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[k];
    assert.equal(proxyFor(new URL('https://a/')), undefined);
    process.env.https_proxy = 'proxy.local:3128';
    assert.equal(proxyFor(new URL('https://a/'))?.host, 'proxy.local:3128');
    process.env.NO_PROXY = 'a';
    assert.equal(proxyFor(new URL('https://a/')), undefined);
  } finally {
    process.env = saved;
  }
});

test('probe dir is safe for JVM argument splitting', () => {
  const dir = safeProbeDir('/home/some user/.calcite');
  assert.doesNotMatch(dir, /[\s,=;"']/);
  const paths = resolvePaths('/tmp/x');
  assert.equal(paths.instances, join('/tmp/x', 'instances'));
});

test('lock excludes a second holder and recovers from a dead owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'calcite-lock-'));
  try {
    const lock = join(dir, 'l');
    const release = await acquireLock(lock, { timeoutMs: 0 });
    await assert.rejects(acquireLock(lock, { timeoutMs: 0 }));
    await release();
    const again = await acquireLock(lock, { timeoutMs: 0 });
    await again();
    // dead owner
    const { mkdir } = await import('node:fs/promises');
    await mkdir(lock);
    await writeFile(join(lock, 'owner'), '999999999');
    const taken = await acquireLock(lock, { timeoutMs: 0 });
    await taken();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('accounts store parsing, instance preparation and removal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'calcite-acc-'));
  try {
    const paths = resolvePaths(home);
    const { mkdir } = await import('node:fs/promises');
    const auth = join(paths.hmcHome, '.auth');
    await mkdir(join(auth, 'default'), { recursive: true });
    await mkdir(join(auth, 'last'), { recursive: true });
    const session = (name, id, token) => ({ minecraftProfile: { value: { id, name } }, token });
    await writeFile(join(auth, 'default', '.accounts.json'), JSON.stringify({ accounts: { Alice: session('Alice', 'a-1', 1), Bob: session('Bob', 'b-2', 1) }, version: 0 }));
    await writeFile(join(auth, 'last', '.accounts.json'), JSON.stringify({ accounts: { latest: [{ provider: 'default', name: 'Bob' }] }, version: 0 }));
    assert.deepEqual((await listAccounts(paths)).map((a) => [a.name, a.uuid, a.primary]), [['Alice', 'a-1', false], ['Bob', 'b-2', true]]);

    // a client location gets exactly the chosen session; a refreshed session is copied back
    const loc = join(home, 'instance');
    assert.equal(await prepareAccount(paths, loc, { type: 'microsoft' }), 'Bob');
    assert.equal(await prepareAccount(paths, loc, { type: 'microsoft', name: 'alice' }), 'Alice');
    const local = JSON.parse(await readFile(join(loc, '.auth', 'default', '.accounts.json'), 'utf8'));
    assert.deepEqual(Object.keys(local.accounts), ['Alice']);
    assert.deepEqual(JSON.parse(await readFile(join(loc, '.auth', 'last', '.accounts.json'), 'utf8')).accounts.latest, [{ provider: 'default', name: 'Alice' }]);
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
    assert.deepEqual((await listAccounts(paths)).map((a) => a.name), ['Bob']);
    assert.equal(await removeAccount(paths, 'nobody'), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('HeadlessMC argument quoting', () => {
  assert.equal(hmcJavaHome('C:\\Program Files\\Zulu\\zulu-25\\bin\\java.exe'), 'C:\\Program Files\\Zulu\\zulu-25');
  assert.equal(hmcJavaHome('/opt/java/bin/java'), '/opt/java');
  assert.equal(hmcQuote('-javaagent:C:\\a b\\p.jar=x'), '"-javaagent:C:\\\\a b\\\\p.jar=x"');
  assert.equal(hmcQuote('a"b'), '"a\\"b"');
  assert.equal(hmcListEntry('C:\\Java,1\\java.exe'), 'C:\\\\Java\\,1\\\\java.exe');
});

test('Client validates names', () => {
  assert.throws(() => new Client({ name: 'bad name', version: '1.21.11' }), CalciteError);
  assert.throws(() => new Client({ name: 'ok', version: '1.21.11', account: { type: 'offline', username: 'x' } }), CalciteError);
  const c = new Client({ name: 'ok', version: '1.21.11', paths: resolvePaths('/tmp/calcite-unused') });
  assert.equal(c.phase, 'idle');
});

test('zipContains reads the central directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'calcite-zip-'));
  try {
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('proxy environment is converted to Java system properties', () => {
  const saved = { ...process.env };
  try {
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) delete process.env[k];
    assert.deepEqual(javaProxyProps(), {});
    process.env.HTTPS_PROXY = 'http://user:pw@127.0.0.1:18080';
    process.env.NO_PROXY = '.internal.example,10.0.0.0/8,host:8080';
    assert.deepEqual(javaProxyProps(), {
      'https.proxyHost': '127.0.0.1',
      'https.proxyPort': '18080',
      'http.nonProxyHosts': 'localhost|127.*|[::1]|*.internal.example|host',
    });
  } finally {
    process.env = saved;
  }
});

test('parseLoader and loader version ids', () => {
  assert.equal(parseLoader(undefined), undefined);
  assert.equal(parseLoader('vanilla'), undefined);
  assert.deepEqual(parseLoader('Fabric'), { kind: 'fabric', build: undefined });
  assert.deepEqual(parseLoader('neoforge@21.11.45'), { kind: 'neoforge', build: '21.11.45' });
  assert.throws(() => parseLoader('quilt'), CalciteError);
  assert.throws(() => parseLoader('forge@../x'), CalciteError);
  assert.equal(loaderBuild('fabric', 'fabric-loader-0.19.5-1.21.11', '1.21.11'), '0.19.5');
  assert.equal(loaderBuild('fabric', 'fabric-loader-0.19.5-1.21.1', '1.21.11'), undefined);
  assert.equal(loaderBuild('forge', '1.20.1-forge-47.4.26', '1.20.1'), '47.4.26');
  assert.equal(loaderBuild('neoforge', 'neoforge-21.11.45', '1.21.11'), '21.11.45');
  assert.ok(compareBuilds('0.19.10', '0.19.5') > 0);
  assert.ok(compareBuilds('21.11.45', '21.11.45-beta') < 0);
  assert.deepEqual(hmcVersionArgs('1.21.11'), ['1.21.11']);
  assert.deepEqual(hmcVersionArgs('1.21.11', { kind: 'fabric' }), ['fabric', '1.21.11']);
  assert.deepEqual(hmcVersionArgs('1.21.11', { kind: 'neoforge', build: '21.11.45' }), ['neoforge', '1.21.11', '45']);
  assert.deepEqual(hmcVersionArgs('26.3', { kind: 'neoforge', build: '26.3.7-beta' }), ['neoforge', '26.3', '7-beta']);
  assert.deepEqual(hmcVersionArgs('1.20.1', { kind: 'forge', build: '47.4.26' }), ['forge', '1.20.1', '47.4.26']);
});

test('findLoader picks the requested or newest installed build', async () => {
  const home = await mkdtemp(join(tmpdir(), 'calcite-loader-'));
  try {
    const paths = resolvePaths(home);
    const { mkdir } = await import('node:fs/promises');
    for (const [id, inherits] of [['fabric-loader-0.19.5-1.21.11', '1.21.11'], ['fabric-loader-0.19.10-1.21.11', '1.21.11'], ['neoforge-21.1.200', '1.21.1']]) {
      await mkdir(join(paths.minecraft, 'versions', id), { recursive: true });
      await writeFile(join(paths.minecraft, 'versions', id, `${id}.json`), JSON.stringify({ id, inheritsFrom: inherits }));
    }
    assert.equal((await findLoader(paths, '1.21.11', { kind: 'fabric' }))?.build, '0.19.10');
    assert.equal((await findLoader(paths, '1.21.11', { kind: 'fabric', build: '0.19.5' }))?.id, 'fabric-loader-0.19.5-1.21.11');
    assert.equal(await findLoader(paths, '1.21.11', { kind: 'neoforge' }), undefined);
    assert.equal((await findLoader(paths, '1.21.1', { kind: 'neoforge' }))?.build, '21.1.200');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const MOJANG = [
  '# comment',
  'net.minecraft.client.Minecraft -> fgo:',
  '    net.minecraft.client.player.LocalPlayer player -> a',
  '    int fps -> b',
  '    java.lang.String fps -> c',
  '    12:15:void tick() -> d',
  '    20:22:void attack(net.minecraft.world.entity.Entity,int[]):33:35 -> a',
  '    40:41:void <init>() -> <init>',
  '    50:51:java.lang.String toString() -> toString',
  '    60:61:void unmapped() -> e',
  'net.minecraft.client.player.LocalPlayer -> fzz:',
  'net.minecraft.world.entity.Entity -> bsr:',
  'com.mojang.Library -> com.mojang.Library:',
  '    void open() -> open',
  '',
].join('\n');

test('Mojang mappings compose with intermediary (tiny v1 and v2)', () => {
  const v1 = [
    'v1\tofficial\tintermediary',
    'CLASS\tfgo\tnet/minecraft/class_310',
    'CLASS\tfzz\tnet/minecraft/class_746',
    'CLASS\tbsr\tnet/minecraft/class_1297',
    'FIELD\tfgo\tLfzz;\ta\tfield_1724',
    'FIELD\tfgo\tI\tb\tfield_1',
    'FIELD\tfgo\tLjava/lang/String;\tc\tfield_2',
    'METHOD\tfgo\t()V\td\tmethod_1574',
    'METHOD\tfgo\t(Lbsr;[I)V\ta\tmethod_9',
  ].join('\n');
  const v2 = [
    'tiny\t2\t0\tofficial\tintermediary',
    'c\tfgo\tnet/minecraft/class_310',
    '\tf\tLfzz;\ta\tfield_1724',
    '\tf\tI\tb\tfield_1',
    '\tf\tLjava/lang/String;\tc\tfield_2',
    '\tm\t()V\td\tmethod_1574',
    '\t\tp\t1\t\tignored',
    '\tm\t(Lbsr;[I)V\ta\tmethod_9',
    'c\tfzz\tnet/minecraft/class_746',
    'c\tbsr\tnet/minecraft/class_1297',
  ].join('\n');
  for (const tiny of [v1, v2]) {
    const target = parseTiny(tiny);
    const out = compose(parseMojang(MOJANG), target, (c) => target.classes.get(c.obf.replace(/\./g, '/'))?.replace(/\//g, '.') ?? (c.obf === c.named ? c.named : undefined));
    assert.equal(
      out,
      [
        'net.minecraft.client.Minecraft -> net.minecraft.class_310:',
        '    net.minecraft.client.player.LocalPlayer player -> field_1724',
        '    int fps -> field_1',
        '    java.lang.String fps -> field_2',
        '    void tick() -> method_1574',
        '    void attack(net.minecraft.world.entity.Entity,int[]) -> method_9',
        '    java.lang.String toString() -> toString',
        'net.minecraft.client.player.LocalPlayer -> net.minecraft.class_746:',
        'net.minecraft.world.entity.Entity -> net.minecraft.class_1297:',
        'com.mojang.Library -> com.mojang.Library:',
        '    void open() -> open',
        '',
      ].join('\n'),
    );
  }
});

test('Mojang mappings compose with SRG (tsrg2)', () => {
  const tsrg = ['tsrg2 obf srg id', 'fgo net/minecraft/src/C_1_ 1', '\ta f_91074_ 2', '\td ()V m_91398_ 3', '\t\t0 o p_0_ 4', '\tstatic', 'fzz net/minecraft/src/C_2_ 5'].join('\n');
  const out = compose(parseMojang(MOJANG), parseTsrg(tsrg), (c) => c.named);
  assert.match(out, /^net\.minecraft\.client\.Minecraft -> net\.minecraft\.client\.Minecraft:\n {4}net\.minecraft\.client\.player\.LocalPlayer player -> f_91074_\n {4}void tick\(\) -> m_91398_\n/);
});

test('syncMods replaces only the mods Calcite placed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'calcite-mods-'));
  try {
    const { readdir, mkdir } = await import('node:fs/promises');
    await writeFile(join(dir, 'a.jar'), 'a');
    await writeFile(join(dir, 'b.jar'), 'b');
    const game = join(dir, 'game');
    await mkdir(join(game, 'mods'), { recursive: true });
    await writeFile(join(game, 'mods', 'mine.jar'), 'user');
    await syncMods(game, [{ name: 'a.jar', file: join(dir, 'a.jar'), source: 'a' }, { name: 'b.jar', file: join(dir, 'b.jar'), source: 'b' }]);
    assert.deepEqual((await readdir(join(game, 'mods'))).sort(), ['.calcite-mods.json', 'a.jar', 'b.jar', 'mine.jar']);
    await syncMods(game, [{ name: 'b.jar', file: join(dir, 'b.jar'), source: 'b' }]);
    assert.deepEqual((await readdir(join(game, 'mods'))).sort(), ['.calcite-mods.json', 'b.jar', 'mine.jar']);
    await syncMods(game, []);
    assert.deepEqual(await readdir(join(game, 'mods')), ['mine.jar']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Client rejects mods without a loader', () => {
  assert.throws(() => new Client({ name: 'm', version: '1.21.11', mods: ['x.jar'], paths: resolvePaths('/tmp/calcite-unused') }), /loader/);
  assert.throws(() => new Client({ name: 'm', version: '1.21.11', loader: 'quilt', paths: resolvePaths('/tmp/calcite-unused') }), /Unknown mod loader/);
});

test('resolveExtensions accepts local jars and rejects missing ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'calcite-ext-'));
  try {
    const jar = join(dir, 'e.jar');
    await writeFile(jar, 'x');
    const paths = resolvePaths(join(dir, 'home'));
    assert.deepEqual(await resolveExtensions(paths, [jar, jar, ' ']), [jar]);
    await assert.rejects(resolveExtensions(paths, [join(dir, 'missing.jar')]), (e) => e.code === 'extension_not_found');
    await assert.rejects(resolveExtensions(paths, [dir]), (e) => e.code === 'extension_not_found');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
