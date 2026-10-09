import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offlineUuid, serverProperties } from '../dist/paper.js';

test('offlineUuid matches the server-side offline player UUID', () => {
  assert.equal(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
});

test('serverProperties sets test defaults that overrides can replace', () => {
  const props = serverProperties(25600, { difficulty: 'normal', 'max-players': '5' }).trim().split('\n');
  assert.ok(props.includes('server-port=25600'));
  assert.ok(props.includes('online-mode=false'));
  assert.ok(props.includes('difficulty=normal'));
  assert.ok(!props.includes('difficulty=peaceful'));
  assert.ok(props.includes('max-players=5'));
});
