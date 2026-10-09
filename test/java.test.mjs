import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJavaSettings, pickJava } from '../dist/java.js';

test('parseJavaSettings', () => {
  assert.deepEqual(parseJavaSettings('    java.specification.version = 1.8\n    java.version = 1.8.0_402\n'), {
    major: 8,
    version: '1.8.0_402',
  });
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
