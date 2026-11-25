import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  VideoRecorder,
  buildFfmpegArgs,
  clampRegion,
  evenDimension,
  parseFrameRate,
  parseRootGeometry,
  parseWindowGeometry,
} from '../dist/recorder.js';
import { tempDir } from './helpers.mjs';

test('evenDimension and clampRegion keep capture geometry valid for libx264', () => {
  assert.equal(evenDimension(855), 854);
  assert.equal(evenDimension(854), 854);
  assert.equal(evenDimension(1), 2);
  assert.deepEqual(clampRegion({ x: 10, y: 10, width: 855, height: 481 }, { width: 1280, height: 720 }), {
    x: 10,
    y: 10,
    width: 854,
    height: 480,
    fullScreen: false,
  });
  assert.deepEqual(clampRegion({ x: -5, y: 700, width: 500, height: 100 }, { width: 1280, height: 720 }), {
    x: 0,
    y: 700,
    width: 500,
    height: 20,
    fullScreen: false,
  });
});

test('parseRootGeometry and parseWindowGeometry locate the Minecraft window', () => {
  const rootOut = `
xwininfo: Window id: 0x19e (the root window) (has no name)
  Absolute upper-left X:  0
  Absolute upper-left Y:  0
  Width: 1280
  Height: 720
  -geometry 1280x720+0+0
`;
  const root = parseRootGeometry(rootOut);
  assert.deepEqual(root, { width: 1280, height: 720 });

  const treeOut = `
xwininfo: Window id: 0x19e (the root window) (has no name)
  Root window id: 0x19e (the root window) (has no name)
  2 children:
     0x200001 (has no name): ()  1280x720+0+0  +0+0
     0x400005 "Minecraft* 1.21.11": ("Minecraft* 1.21.11" "Minecraft* 1.21.11")  855x481+213+120  +213+120
`;
  assert.deepEqual(parseWindowGeometry(treeOut, root), {
    x: 213,
    y: 120,
    width: 854,
    height: 480,
    fullScreen: false,
    windowId: '0x400005',
  });
});

test('buildFfmpegArgs switches preset at high fps and parses rational frame rates', () => {
  const region = { x: 213, y: 120, width: 854, height: 480, fullScreen: false };
  const args60 = buildFfmpegArgs({
    display: ':114',
    region,
    output: '/tmp/out.mp4',
    fps: 60,
    crf: 18,
    cursor: false,
  });
  assert.equal(args60[args60.indexOf('-preset') + 1], 'ultrafast');
  assert.equal(args60[args60.indexOf('-draw_mouse') + 1], '0');
  assert.equal(args60[args60.indexOf('-i') + 1], ':114+213,120');

  const args30 = buildFfmpegArgs({
    display: ':99',
    region,
    output: '/tmp/out30.mp4',
    fps: 30,
    crf: 20,
    cursor: true,
  });
  assert.equal(args30[args30.indexOf('-preset') + 1], 'veryfast');
  assert.equal(args30[args30.indexOf('-draw_mouse') + 1], '1');

  assert.equal(parseFrameRate('60/1'), 60);
  assert.equal(parseFrameRate('30000/1001'), 29.97);
  assert.equal(parseFrameRate('0/0'), undefined);
});

test('VideoRecorder toggles render, stops cleanly on q, and rejects concurrent starts', async (t) => {
  const dir = await tempDir(t, 'calcite-rec-');
  const outFile = join(dir, 'clip.mp4');
  const markerFile = join(dir, 'received.txt');
  const renderCalls = [];

  // Tiny node script acting as a fake ffmpeg: writes output file and exits cleanly when 'q' arrives on stdin.
  const fakeScript = `
    const fs = require('node:fs');
    const out = process.argv[process.argv.length - 1];
    fs.writeFileSync(out, Buffer.alloc(1024, 1));
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (chunk.includes('q')) {
        fs.writeFileSync(${JSON.stringify(markerFile)}, 'got-q');
        process.exit(0);
      }
    });
    setInterval(() => {}, 1000);
  `;

  let renderDisabled = true;
  const recorder = new VideoRecorder({
    gameDir: dir,
    platform: 'linux',
    getDisplay: () => ':120',
    isHeadless: () => false,
    isRenderDisabled: async () => renderDisabled,
    setRender: async (enabled) => {
      renderCalls.push(enabled);
      renderDisabled = !enabled;
    },
    findBinary: () => '/usr/bin/ffmpeg',
    detectRegion: async () => ({ x: 0, y: 0, width: 854, height: 480, fullScreen: false }),
    spawnProcess: (_cmd, args, env) =>
      spawn(process.execPath, ['-e', fakeScript, '--', ...args], { env, stdio: ['pipe', 'ignore', 'pipe'] }),
    probeFile: async () => ({ width: 854, height: 480, fps: 60, frames: 42, durationMs: 700, bytes: 1024 }),
  });

  const started = await recorder.start({ output: outFile, fps: 60, crf: 18, warmupMs: 0 });
  assert.equal(started.output, outFile);
  assert.equal(started.display, ':120');
  assert.deepEqual(renderCalls, [true]);

  await assert.rejects(recorder.start({ output: outFile }), { code: 'already_recording' });

  const result = await recorder.stop();
  assert.equal(result.path, outFile);
  assert.equal(result.width, 854);
  assert.equal(result.frames, 42);
  assert.equal(result.bytes, 1024);
  assert.equal(await readFile(markerFile, 'utf8'), 'got-q');
  assert.deepEqual(renderCalls, [true, false]);
  assert.equal(recorder.status(), null);
});

test('VideoRecorder restores render state when ffmpeg exits immediately with an error', async (t) => {
  const dir = await tempDir(t, 'calcite-rec-fail-');
  const renderCalls = [];
  const recorder = new VideoRecorder({
    gameDir: dir,
    platform: 'linux',
    getDisplay: () => ':120',
    isHeadless: () => false,
    isRenderDisabled: async () => true,
    setRender: async (enabled) => renderCalls.push(enabled),
    findBinary: () => '/usr/bin/ffmpeg',
    detectRegion: async () => ({ x: 0, y: 0, width: 640, height: 480, fullScreen: true }),
    spawnProcess: (_cmd, _args, env) =>
      spawn(process.execPath, ['-e', 'process.stderr.write("cannot open display"); process.exit(1);'], {
        env,
        stdio: ['pipe', 'ignore', 'pipe'],
      }),
  });

  await assert.rejects(recorder.start({ output: join(dir, 'bad.mp4'), warmupMs: 0 }), (err) => {
    assert.equal(err.code, 'record_failed');
    assert.match(err.message, /cannot open display/);
    return true;
  });
  assert.deepEqual(renderCalls, [true, false]);
  assert.equal(recorder.status(), null);
});

test('VideoRecorder validates platform, headless mode, missing ffmpeg and options', async (t) => {
  const dir = await tempDir(t, 'calcite-rec-val-');
  const baseHost = {
    gameDir: dir,
    platform: 'linux',
    getDisplay: () => ':99',
    isHeadless: () => false,
    isRenderDisabled: async () => false,
    setRender: async () => undefined,
    findBinary: () => '/usr/bin/ffmpeg',
  };

  await assert.rejects(new VideoRecorder({ ...baseHost, isHeadless: () => true }).start(), { code: 'headless' });
  await assert.rejects(new VideoRecorder({ ...baseHost, platform: 'win32' }).start(), { code: 'unsupported_platform' });
  await assert.rejects(new VideoRecorder({ ...baseHost, findBinary: () => null }).start(), { code: 'missing_dependency' });
  await assert.rejects(new VideoRecorder({ ...baseHost, getDisplay: () => undefined }).start(), { code: 'no_display' });
  await assert.rejects(new VideoRecorder(baseHost).start({ fps: 999 }), { code: 'bad_request' });
  await assert.rejects(new VideoRecorder(baseHost).stop(), { code: 'not_recording' });
  await writeFile(join(dir, 'noop'), 'ok');
});
