import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOD_ERROR_LINE, gameStage } from '../dist/stage.js';

test('gameStage', () => {
  const world = { inGame: true, loading: false, screen: null };
  assert.equal(gameStage(world), 'playing');
  assert.equal(gameStage({ ...world, screen: 'ChatScreen' }), 'playing');
  assert.equal(gameStage({ ...world, screen: 'LevelLoadingScreen' }), 'loading');
  assert.equal(gameStage({ ...world, loading: true }), 'loading');
  assert.equal(gameStage({ inGame: false, loading: false, screen: 'TitleScreen' }), 'title');
  assert.equal(gameStage({ inGame: false, loading: true, screen: 'TitleScreen' }), 'loading');
  assert.equal(gameStage({ inGame: false, screen: 'DisconnectedScreen' }), 'disconnected');
  assert.equal(gameStage({ inGame: false, screen: 'LoadingErrorScreen' }), 'mod_error');
});

test('MOD_ERROR_LINE picks the lines that explain a failure', () => {
  assert.ok(MOD_ERROR_LINE.test('[12:00:01] [main/ERROR]: Mod sodium requires fabric-api'));
  assert.ok(MOD_ERROR_LINE.test('Missing or unsupported mandatory dependencies'));
  assert.ok(!MOD_ERROR_LINE.test('[12:00:01] [main/INFO]: Loading 42 mods'));
});
