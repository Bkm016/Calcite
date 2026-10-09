import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supportsQuickPlay, requiredJavaMajor } from '../dist/mojang.js';

test('version json helpers', () => {
  assert.equal(
    supportsQuickPlay({ arguments: { game: [{ rules: [], value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}'] }] } }),
    true,
  );
  assert.equal(supportsQuickPlay({ minecraftArguments: '--username ${auth_player_name}' }), false);
  assert.equal(requiredJavaMajor({}), 8);
  assert.equal(requiredJavaMajor({ javaVersion: { majorVersion: 21 } }), 21);
});
