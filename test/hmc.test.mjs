import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hmcJavaHome, hmcListEntry, hmcQuote } from '../dist/hmc.js';

test('HeadlessMC argument quoting', () => {
  assert.equal(hmcJavaHome('C:\\Program Files\\Zulu\\zulu-25\\bin\\java.exe'), 'C:\\Program Files\\Zulu\\zulu-25');
  assert.equal(hmcJavaHome('/opt/java/bin/java'), '/opt/java');
  assert.equal(hmcQuote('-javaagent:C:\\a b\\p.jar=x'), '"-javaagent:C:\\\\a b\\\\p.jar=x"');
  assert.equal(hmcQuote('a"b'), '"a\\"b"');
  assert.equal(hmcListEntry('C:\\Java,1\\java.exe'), 'C:\\\\Java\\,1\\\\java.exe');
});
