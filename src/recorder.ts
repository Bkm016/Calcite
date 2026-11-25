import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { which } from './display.js';
import { logger } from './log.js';
import { CalciteError, type RecordOptions, type RecordingRegion, type RecordingResult, type RecordingStatus } from './types.js';

const execFileAsync = promisify(execFile);
const log = logger('recorder');

const DEFAULT_FPS = 30;
const DEFAULT_CRF = 20;
const DEFAULT_WARMUP_MS = 250;
const STARTUP_CHECK_MS = 200;
const STOP_GRACE_MS = 5_000;
const STOP_TERM_MS = 3_000;
const MAX_STDERR = 4096;

const MC_TITLE_RE = /Minecraft|GLFW|LWJGL|SDL/i;
const ROOT_GEOM_RE = /-geometry\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/;
const TREE_LINE_RE =
  /^\s*(0x[0-9a-fA-F]+)\s+(?:"([^"]*)"|\(has no name\)):\s*\([^)]*\)\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)\s+\+(-?\d+)\+(-?\d+)/;

/** Rounds {@code n} down to an even positive integer (at least 2), as required by libx264 yuv420p. */
export function evenDimension(n: number): number {
  const floored = Math.floor(n);
  if (floored < 2) return 2;
  return floored % 2 === 0 ? floored : floored - 1;
}

/** Clamps a capture region inside the root display bounds and ensures even width/height. */
export function clampRegion(
  region: { x: number; y: number; width: number; height: number; windowId?: string },
  root: { width: number; height: number },
  fullScreen = false,
): RecordingRegion {
  const x = Math.max(0, Math.min(Math.floor(region.x), Math.max(0, root.width - 2)));
  const y = Math.max(0, Math.min(Math.floor(region.y), Math.max(0, root.height - 2)));
  const width = evenDimension(Math.min(region.width, root.width - x));
  const height = evenDimension(Math.min(region.height, root.height - y));
  return { x, y, width, height, fullScreen, ...(region.windowId ? { windowId: region.windowId } : {}) };
}

/** Parses root screen dimensions from {@code xwininfo -root} output. */
export function parseRootGeometry(output: string): { width: number; height: number } | null {
  const m = ROOT_GEOM_RE.exec(output);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return null;
  return { width, height };
}

/**
 * Picks the Minecraft client window geometry from {@code xwininfo -root -tree} output.
 * Prefers windows whose title matches Minecraft/GLFW/LWJGL/SDL, falling back to the largest non-root window.
 */
export function parseWindowGeometry(treeOutput: string, root: { width: number; height: number }): RecordingRegion | null {
  interface Candidate {
    windowId: string;
    title: string;
    x: number;
    y: number;
    width: number;
    height: number;
    area: number;
    titledMatch: boolean;
  }
  const candidates: Candidate[] = [];
  for (const line of treeOutput.split(/\r?\n/)) {
    const m = TREE_LINE_RE.exec(line);
    if (!m) continue;
    const windowId = m[1];
    const title = m[2] || '';
    const width = Number(m[3]);
    const height = Number(m[4]);
    const absX = Number(m[7]);
    const absY = Number(m[8]);
    if (width < 100 || height < 100) continue;
    // Skip windows identical to the full root canvas unless they explicitly match Minecraft
    const titledMatch = MC_TITLE_RE.test(title);
    if (!titledMatch && width === root.width && height === root.height && absX === 0 && absY === 0) continue;
    candidates.push({ windowId, title, x: absX, y: absY, width, height, area: width * height, titledMatch });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.titledMatch !== b.titledMatch) return a.titledMatch ? -1 : 1;
    return b.area - a.area;
  });
  const best = candidates[0];
  return clampRegion(best, root, false);
}

/** Builds ffmpeg command-line arguments for Linux X11/Xvfb capture. */
export function buildFfmpegArgs(params: {
  display: string;
  region: RecordingRegion;
  output: string;
  fps: number;
  crf: number;
  cursor: boolean;
  preset?: string;
}): string[] {
  // Use ultrafast + capped threads at high frame rates so encoding does not starve llvmpipe software GL.
  const preset = params.preset ?? (params.fps >= 45 ? 'ultrafast' : 'veryfast');
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'warning',
    '-f',
    'x11grab',
    '-draw_mouse',
    params.cursor ? '1' : '0',
    '-framerate',
    String(params.fps),
    '-video_size',
    `${params.region.width}x${params.region.height}`,
    '-i',
    `${params.display}+${params.region.x},${params.region.y}`,
    '-c:v',
    'libx264',
    '-preset',
    preset,
    '-threads',
    '4',
    '-crf',
    String(params.crf),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    params.output,
  ];
}

/** Parses rational frame rates like "60/1" or "30000/1001". */
export function parseFrameRate(rate: unknown): number | undefined {
  if (typeof rate !== 'string' || !rate.trim()) return undefined;
  const parts = rate.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return Math.round((num / den) * 100) / 100;
    return undefined;
  }
  const n = Number(rate);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Resolves the capture region on {@code display} via xwininfo, falling back to 1280x720 when unavailable. */
export async function detectCaptureRegion(display: string, fullScreen: boolean): Promise<RecordingRegion> {
  const fallbackRoot = { width: 1280, height: 720 };
  const xwininfo = which('xwininfo');
  if (!xwininfo) {
    return clampRegion({ x: 0, y: 0, ...fallbackRoot }, fallbackRoot, true);
  }
  const env = { ...process.env, DISPLAY: display };
  let root: { width: number; height: number };
  try {
    const { stdout } = await execFileAsync(xwininfo, ['-root'], { env, timeout: 5_000 });
    root = parseRootGeometry(stdout) ?? fallbackRoot;
  } catch {
    return clampRegion({ x: 0, y: 0, ...fallbackRoot }, fallbackRoot, true);
  }
  if (fullScreen) {
    return clampRegion({ x: 0, y: 0, ...root }, root, true);
  }
  try {
    const { stdout } = await execFileAsync(xwininfo, ['-root', '-tree'], { env, timeout: 5_000 });
    const win = parseWindowGeometry(stdout, root);
    if (win) return win;
  } catch {
    // Fall back to full root screen
  }
  return clampRegion({ x: 0, y: 0, ...root }, root, true);
}

/** Reads container/stream metadata via ffprobe when available. */
export async function probeVideoFile(
  filePath: string,
  ffprobeBin = which('ffprobe'),
): Promise<Omit<RecordingResult, 'path' | 'durationMs'> & { durationMs?: number }> {
  const result: Omit<RecordingResult, 'path' | 'durationMs'> & { durationMs?: number } = {};
  try {
    const info = await stat(filePath);
    result.bytes = info.size;
  } catch {
    return result;
  }
  if (!ffprobeBin) return result;
  try {
    const { stdout } = await execFileAsync(
      ffprobeBin,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,avg_frame_rate,nb_frames,duration',
        '-of',
        'json',
        filePath,
      ],
      { timeout: 10_000 },
    );
    const parsed = JSON.parse(stdout) as { streams?: Record<string, unknown>[] };
    const stream = parsed.streams?.[0];
    if (stream) {
      if (typeof stream.width === 'number') result.width = stream.width;
      if (typeof stream.height === 'number') result.height = stream.height;
      result.fps = parseFrameRate(stream.avg_frame_rate);
      const frames = Number(stream.nb_frames);
      if (Number.isFinite(frames) && frames > 0) result.frames = frames;
      const dur = Number(stream.duration);
      if (Number.isFinite(dur) && dur > 0) result.durationMs = Math.round(dur * 1000);
    }
  } catch {
    // ffprobe metadata is best-effort
  }
  return result;
}

export interface RecorderHost {
  readonly gameDir: string;
  readonly platform?: NodeJS.Platform;
  getDisplay(): string | undefined;
  isHeadless(): boolean;
  isRenderDisabled(): Promise<boolean>;
  setRender(enabled: boolean): Promise<void>;
  /** Overridable hooks for deterministic unit tests. */
  findBinary?: (name: string) => string | null;
  detectRegion?: (display: string, fullScreen: boolean) => Promise<RecordingRegion>;
  spawnProcess?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  probeFile?: (filePath: string) => Promise<Omit<RecordingResult, 'path' | 'durationMs'> & { durationMs?: number }>;
}

interface ActiveSession {
  child: ChildProcess;
  output: string;
  fps: number;
  crf: number;
  cursor: boolean;
  display: string;
  region: RecordingRegion;
  startedAt: number;
  restoreRender: boolean;
  stderr: string;
  exited: boolean;
  exitCode: number | null;
  exitPromise: Promise<number | null>;
}

function validateRecordOptions(opts: RecordOptions): {
  fps: number;
  crf: number;
  cursor: boolean;
  fullScreen: boolean;
  preset?: string;
  warmupMs: number;
} {
  const fps = opts.fps ?? DEFAULT_FPS;
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) {
    throw new CalciteError('bad_request', `fps must be an integer between 1 and 120 (got ${fps})`);
  }
  const crf = opts.crf ?? DEFAULT_CRF;
  if (!Number.isInteger(crf) || crf < 0 || crf > 51) {
    throw new CalciteError('bad_request', `crf must be an integer between 0 and 51 (got ${crf})`);
  }
  const warmupMs = opts.warmupMs ?? DEFAULT_WARMUP_MS;
  if (!Number.isFinite(warmupMs) || warmupMs < 0 || warmupMs > 10_000) {
    throw new CalciteError('bad_request', `warmupMs must be between 0 and 10000 (got ${warmupMs})`);
  }
  return {
    fps,
    crf,
    cursor: opts.cursor ?? true,
    fullScreen: opts.fullScreen ?? false,
    preset: opts.preset,
    warmupMs,
  };
}

/** Manages one active video recording attached to a Calcite client's display and render lifecycle. */
export class VideoRecorder {
  private active: ActiveSession | null = null;
  private stopping: Promise<RecordingResult> | null = null;

  constructor(private readonly host: RecorderHost) {}

  status(): RecordingStatus | null {
    const s = this.active;
    if (!s || s.exited) return null;
    return {
      output: s.output,
      pid: s.child.pid ?? 0,
      fps: s.fps,
      crf: s.crf,
      cursor: s.cursor,
      display: s.display,
      region: s.region,
      startedAt: s.startedAt,
      elapsedMs: Math.max(0, Date.now() - s.startedAt),
    };
  }

  async start(opts: RecordOptions = {}): Promise<RecordingStatus> {
    if (this.active && !this.active.exited) {
      throw new CalciteError('already_recording', `Already recording to ${this.active.output}`);
    }
    this.active = null;

    if (this.host.isHeadless()) {
      throw new CalciteError('headless', 'Recording needs a display; start the client with render "on-demand" or "always"');
    }
    const platform = this.host.platform ?? process.platform;
    if (platform !== 'linux') {
      throw new CalciteError(
        'unsupported_platform',
        `Video recording currently uses Linux X11 capture (x11grab) and is not supported on ${platform}`,
      );
    }

    const parsed = validateRecordOptions(opts);
    const findBin = this.host.findBinary ?? which;
    const ffmpeg = findBin('ffmpeg');
    if (!ffmpeg) {
      throw new CalciteError('missing_dependency', 'ffmpeg is not installed or not on PATH');
    }

    const display = this.host.getDisplay();
    if (!display) {
      throw new CalciteError('no_display', 'No X11 DISPLAY is attached to this client');
    }

    const output = resolve(opts.output || join(this.host.gameDir, 'recordings', `calcite-${Date.now()}.mp4`));
    await mkdir(dirname(output), { recursive: true });

    const detect = this.host.detectRegion ?? detectCaptureRegion;
    const region = await detect(display, parsed.fullScreen);

    let restoreRender = false;
    if (await this.host.isRenderDisabled()) {
      await this.host.setRender(true);
      restoreRender = true;
      if (parsed.warmupMs > 0) await new Promise((r) => setTimeout(r, parsed.warmupMs));
    }

    const args = buildFfmpegArgs({
      display,
      region,
      output,
      fps: parsed.fps,
      crf: parsed.crf,
      cursor: parsed.cursor,
      preset: parsed.preset,
    });
    const env = { ...process.env, DISPLAY: display };
    const spawnFn =
      this.host.spawnProcess ?? ((cmd, spawnArgs, spawnEnv) => spawn(cmd, spawnArgs, { env: spawnEnv, stdio: ['pipe', 'ignore', 'pipe'] }));

    let child: ChildProcess;
    try {
      child = spawnFn(ffmpeg, args, env);
    } catch (err) {
      if (restoreRender) await this.host.setRender(false).catch(() => undefined);
      throw new CalciteError('record_failed', `Failed to start ffmpeg: ${(err as Error).message}`);
    }

    const session: ActiveSession = {
      child,
      output,
      fps: parsed.fps,
      crf: parsed.crf,
      cursor: parsed.cursor,
      display,
      region,
      startedAt: Date.now(),
      restoreRender,
      stderr: '',
      exited: false,
      exitCode: null,
      exitPromise: Promise.resolve(null),
    };

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      session.stderr = (session.stderr + chunk).slice(-MAX_STDERR);
    });

    session.exitPromise = new Promise<number | null>((resolveExit) => {
      const done = (code: number | null) => {
        if (session.exited) return;
        session.exited = true;
        session.exitCode = code;
        resolveExit(code);
      };
      child.once('exit', (code) => done(code));
      child.once('error', (err) => {
        session.stderr = (session.stderr + `\n${err.message}`).slice(-MAX_STDERR);
        done(1);
      });
    });

    // Catch immediate startup failures (bad display, missing encoder, permission denied).
    await Promise.race([session.exitPromise, new Promise((r) => setTimeout(r, STARTUP_CHECK_MS))]);

    if (session.exited) {
      if (restoreRender) await this.host.setRender(false).catch(() => undefined);
      const detail = session.stderr.trim();
      throw new CalciteError('record_failed', `ffmpeg exited immediately (code ${session.exitCode ?? '?'})${detail ? `: ${detail}` : ''}`);
    }

    this.active = session;
    log.info(`recording started (${region.width}x${region.height}@${parsed.fps}fps on ${display} -> ${output})`);
    return {
      output: session.output,
      pid: session.child.pid ?? 0,
      fps: session.fps,
      crf: session.crf,
      cursor: session.cursor,
      display: session.display,
      region: session.region,
      startedAt: session.startedAt,
      elapsedMs: Math.max(0, Date.now() - session.startedAt),
    };
  }

  async stop(): Promise<RecordingResult> {
    if (this.stopping) return this.stopping;
    const session = this.active;
    if (!session) {
      throw new CalciteError('not_recording', 'No video recording is currently running');
    }
    this.stopping = this.finish(session);
    try {
      return await this.stopping;
    } finally {
      this.stopping = null;
    }
  }

  /** Stops an active recording silently if one is running (used during client shutdown/reconnect). */
  async stopIfActive(): Promise<void> {
    if (!this.active && !this.stopping) return;
    try {
      await this.stop();
    } catch (err) {
      log.warn(`failed to stop active recording during cleanup: ${(err as Error).message}`);
    }
  }

  private async finish(session: ActiveSession): Promise<RecordingResult> {
    try {
      if (!session.exited) {
        // Sending 'q' to ffmpeg stdin flushes buffered frames and finalizes the MP4 moov atom cleanly.
        try {
          session.child.stdin?.write('q\n');
          session.child.stdin?.end();
        } catch {
          // fall through to signal
        }
        const exitedAfterQ = await waitExit(session.exitPromise, STOP_GRACE_MS);
        if (!exitedAfterQ) {
          session.child.kill('SIGINT');
          const exitedAfterInt = await waitExit(session.exitPromise, STOP_TERM_MS);
          if (!exitedAfterInt) {
            session.child.kill('SIGTERM');
            const exitedAfterTerm = await waitExit(session.exitPromise, STOP_TERM_MS);
            if (!exitedAfterTerm) {
              session.child.kill('SIGKILL');
              await waitExit(session.exitPromise, 2_000);
            }
          }
        }
      }

      const wallDurationMs = Math.max(0, Date.now() - session.startedAt);
      const probe = this.host.probeFile ?? ((p: string) => probeVideoFile(p));
      const meta = await probe(session.output);
      const result: RecordingResult = {
        path: session.output,
        durationMs: meta.durationMs ?? wallDurationMs,
        ...(meta.fps !== undefined ? { fps: meta.fps } : {}),
        ...(meta.frames !== undefined ? { frames: meta.frames } : {}),
        ...(meta.width !== undefined ? { width: meta.width } : {}),
        ...(meta.height !== undefined ? { height: meta.height } : {}),
        ...(meta.bytes !== undefined ? { bytes: meta.bytes } : {}),
      };
      log.info(`recording stopped (${result.path}, ${result.durationMs}ms, ${result.bytes ?? 0} bytes)`);
      return result;
    } finally {
      if (this.active === session) this.active = null;
      if (session.restoreRender) {
        await this.host.setRender(false).catch(() => undefined);
      }
    }
  }
}

async function waitExit(promise: Promise<number | null>, timeoutMs: number): Promise<boolean> {
  let done = false;
  await Promise.race([
    promise.then(() => {
      done = true;
    }),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
  return done;
}
