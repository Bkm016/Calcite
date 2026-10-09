import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolvePaths, safeProbeDir } from '../dist/paths.js';

test('probe dir is safe for JVM argument splitting', () => {
  const dir = safeProbeDir('/home/some user/.calcite');
  assert.doesNotMatch(dir, /[\s,=;"']/);
  const paths = resolvePaths('/tmp/x');
  assert.equal(paths.instances, join('/tmp/x', 'instances'));
});
