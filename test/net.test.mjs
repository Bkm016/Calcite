import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { bypassProxy, download, javaProxyProps, proxyFor } from '../dist/net.js';
import { tempDir } from './helpers.mjs';

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

test('download reuses a file whose hash matches and replaces one that does not', async (t) => {
  const dir = await tempDir(t, 'calcite-dl-');
  const body = 'probe jar contents';
  const sha1 = createHash('sha1').update(body).digest('hex');
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/a.jar`;
  const dest = join(dir, 'lib', 'a.jar');
  const saved = process.env.NO_PROXY;
  process.env.NO_PROXY = '127.0.0.1';
  t.after(() => (saved === undefined ? delete process.env.NO_PROXY : (process.env.NO_PROXY = saved)));

  assert.equal(await download(url, dest, { sha1 }), dest);
  assert.equal(await readFile(dest, 'utf8'), body);
  await download(url, dest, { sha1 });
  assert.equal(requests, 1);

  await writeFile(dest, 'corrupted');
  await download(url, dest, { sha1 });
  assert.equal(requests, 2);
  assert.equal(await readFile(dest, 'utf8'), body);

  await assert.rejects(download(url, join(dir, 'b.jar'), { sha1: '0'.repeat(40) }), /SHA-1 mismatch/);
  assert.deepEqual(await readdir(dir), ['lib'], 'a failed download leaves no partial file');
});
