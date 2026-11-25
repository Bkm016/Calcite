import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeStoryboard, loadStoryboardFile, validateStoryboard } from '../dist/storyboard.js';
import { tempDir } from './helpers.mjs';

function fakeDriver(failAtExec) {
  const events = [];
  let active = null;
  const driver = {
    async executeLine(line) {
      events.push(['exec', line]);
      if (failAtExec && line === failAtExec) throw new Error('boom');
      return undefined;
    },
    async startRecording(opts) {
      events.push(['startRecording', opts]);
      active = {
        output: opts?.output ?? '/tmp/test.mp4',
        pid: 1,
        fps: 60,
        crf: 18,
        cursor: true,
        display: ':99',
        region: { x: 0, y: 0, width: 854, height: 480 },
        startedAt: Date.now(),
        elapsedMs: 0,
      };
      return active;
    },
    async stopRecording() {
      events.push(['stopRecording']);
      const out = active?.output ?? '/tmp/test.mp4';
      active = null;
      return { path: out, durationMs: 500, frames: 30, width: 854, height: 480, bytes: 2048 };
    },
    recording() {
      return active;
    },
    async focusWindow() {
      events.push(['focus']);
    },
    async mouseMove(x, y, opts) {
      events.push(['move', x, y, opts]);
    },
    async mouseClick(opts) {
      events.push(['click', opts]);
    },
    async keyPress(key, opts) {
      events.push(['key', key, opts]);
    },
    async panLook(opts) {
      events.push(['pan', opts]);
      return { yaw: 0, pitch: 0 };
    },
    async screenshot() {
      events.push(['shot']);
      return { png: Buffer.from('PNGDATA') };
    },
  };
  return { driver, events };
}

test('executeStoryboard runs setup -> startRecording -> steps -> stopRecording -> teardown and writes shots', async (t) => {
  const dir = await tempDir(t, 'calcite-sb-');
  const shotPath = join(dir, 'frame.png');
  const sbPath = join(dir, 'demo.json');
  await writeFile(
    sbPath,
    JSON.stringify({
      name: 'demo',
      fps: 60,
      preroll: 0,
      postroll: 0,
      setup: [{ exec: ':look 0 -90', focus: true }],
      steps: [
        { note: 'open UI', exec: ['/fq mapdemo'], wait: 0 },
        { move: { x: 420, y: 160, duration: 0.2, space: 'window' } },
        { click: { x: 420, y: 160, button: 1, hold: 0.04 } },
        { pan: { dyaw: 30, dpitch: -10, duration: 0.1 } },
        { key: 'Escape' },
        { shot: shotPath },
      ],
      teardown: [{ exec: ':close' }],
    }),
  );

  const loaded = await loadStoryboardFile(sbPath);
  assert.equal(loaded.name, 'demo');

  const { driver, events } = fakeDriver();
  const res = await executeStoryboard(driver, sbPath, { output: join(dir, 'out.mp4') });
  assert.equal(res.dryRun, false);
  assert.equal(res.stepsExecuted, 6);
  assert.deepEqual(res.shots, [shotPath]);
  assert.equal(res.recording?.frames, 30);
  assert.equal(await readFile(shotPath, 'utf8'), 'PNGDATA');

  assert.deepEqual(
    events.map((e) => e[0]),
    ['exec', 'focus', 'startRecording', 'exec', 'move', 'click', 'pan', 'key', 'shot', 'stopRecording', 'exec'],
  );
});

test('executeStoryboard stops active recording and runs teardown even when a step fails', async () => {
  const { driver, events } = fakeDriver('/fail');
  await assert.rejects(
    executeStoryboard(driver, {
      preroll: 0,
      postroll: 0,
      steps: [{ exec: '/fail' }],
      teardown: [{ exec: ':close' }],
    }),
    /boom/,
  );
  assert.deepEqual(
    events.map((e) => e[0]),
    ['startRecording', 'exec', 'stopRecording', 'exec'],
  );
  assert.equal(driver.recording(), null);
});

test('executeStoryboard dryRun validates without calling driver and rejects malformed storyboards', async () => {
  const { driver, events } = fakeDriver();
  const logs = [];
  const res = await executeStoryboard(
    driver,
    { name: 'dry', steps: [{ note: 'hi', wait: 1, key: 'Escape' }] },
    { dryRun: true, onLog: (l) => logs.push(l) },
  );
  assert.equal(res.dryRun, true);
  assert.equal(res.stepsExecuted, 1);
  assert.deepEqual(events, []);
  assert.ok(logs.some((l) => l.includes('key Escape')));
  assert.throws(() => validateStoryboard({}), { code: 'bad_request' });
  assert.throws(() => validateStoryboard({ steps: ['not-an-object'] }), { code: 'bad_request' });
});
