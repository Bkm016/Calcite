import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WindowInput, easeInOut, parseMouseLocation, shortestYawDelta, toRootPoint } from '../dist/window-input.js';

test('math and coordinate helpers', () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(0.5), 0.5);
  assert.equal(easeInOut(1), 1);
  assert.equal(shortestYawDelta(170, -170), 20);
  assert.equal(shortestYawDelta(-170, 170), -20);
  assert.equal(shortestYawDelta(0, 90), 90);

  const region = { x: 200, y: 100, width: 800, height: 480, windowId: '0x400005' };
  assert.deepEqual(toRootPoint(50, 25, region, 'window'), { x: 250, y: 125 });
  assert.deepEqual(toRootPoint(0.5, 0.25, region, 'norm'), { x: 600, y: 220 });
  assert.deepEqual(toRootPoint(12, 34, region, 'root'), { x: 12, y: 34 });

  assert.deepEqual(parseMouseLocation('X=420\nY=310\nSCREEN=0\n'), { x: 420, y: 310 });
  assert.equal(parseMouseLocation('bad'), null);
});

test('WindowInput drives focus, smooth mouseMove, mouseClick, keyPress and shortest-arc panLook', async () => {
  const xdoCalls = [];
  const lookCalls = [];
  let rot = { yaw: 170, pitch: 0 };

  const input = new WindowInput({
    platform: 'linux',
    getDisplay: () => ':114',
    isHeadless: () => false,
    detectRegion: async () => ({ x: 200, y: 100, width: 800, height: 480, windowId: '0x400005' }),
    findBinary: () => '/usr/bin/xdotool',
    getRotation: async () => rot,
    setRotation: async (next) => {
      lookCalls.push(next);
      rot = next;
      return next;
    },
    runCommand: async (_cmd, args) => {
      xdoCalls.push(args);
      if (args[0] === 'getmouselocation') return 'X=200\nY=100\n';
      return '';
    },
  });

  await input.mouseMove(100, 50);
  await input.mouseClick({ x: 200, y: 100, button: 3, durationMs: 30, steps: 3, holdMs: 5 });
  await input.keyPress('Escape', { repeat: 2, delayMs: 0 });
  const finalRot = await input.panLook({ yaw: -170, pitch: -45, durationMs: 20, steps: 4 });

  // First call focuses the window once, then moves directly
  assert.deepEqual(xdoCalls[0], ['windowfocus', '--sync', '0x400005']);
  assert.deepEqual(xdoCalls[1], ['mousemove', '--sync', '300', '150']);
  // Click performs getmouselocation, 3 smooth mousemove steps ending at (400, 200), then mousedown/mouseup btn 3
  assert.deepEqual(xdoCalls[2], ['getmouselocation', '--shell']);
  assert.deepEqual(xdoCalls[5], ['mousemove', '400', '200']);
  assert.deepEqual(xdoCalls[6], ['mousedown', '3']);
  assert.deepEqual(xdoCalls[7], ['mouseup', '3']);
  assert.deepEqual(xdoCalls[8], ['key', '--clearmodifiers', 'Escape']);
  assert.deepEqual(xdoCalls[9], ['key', '--clearmodifiers', 'Escape']);

  // Pan interpolated across +170 -> +190 (shortest arc +20 deg), pitch 0 -> -45
  assert.equal(lookCalls.length, 4);
  assert.equal(finalRot.yaw, 190);
  assert.equal(finalRot.pitch, -45);
});

test('WindowInput validates headless, platform, missing xdotool and bad arguments', async () => {
  const base = {
    platform: 'linux',
    getDisplay: () => ':99',
    isHeadless: () => false,
    findBinary: () => '/usr/bin/xdotool',
    getRotation: async () => ({ yaw: 0, pitch: 0 }),
    setRotation: async (r) => r,
  };
  await assert.rejects(new WindowInput({ ...base, isHeadless: () => true }).focus(), { code: 'headless' });
  await assert.rejects(new WindowInput({ ...base, platform: 'darwin' }).focus(), { code: 'unsupported_platform' });
  await assert.rejects(new WindowInput({ ...base, findBinary: () => null }).focus(), { code: 'missing_dependency' });
  await assert.rejects(new WindowInput(base).mouseClick({ x: 10 }), { code: 'bad_request' });
  await assert.rejects(new WindowInput(base).keyPress('   '), { code: 'bad_request' });
});
