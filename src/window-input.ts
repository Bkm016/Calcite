import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { which } from './display.js';
import { detectCaptureRegion } from './recorder.js';
import {
  CalciteError,
  type KeyPressOptions,
  type MouseClickOptions,
  type MouseMoveOptions,
  type MouseSpace,
  type PanLookOptions,
  type RecordingRegion,
} from './types.js';

const execFileAsync = promisify(execFile);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Smoothstep cubic easing on [0, 1]. */
export function easeInOut(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return 3 * c * c - 2 * c * c * c;
}

/** Shortest signed angle delta in degrees from {@code fromYaw} to {@code toYaw}, in [-180, 180). */
export function shortestYawDelta(fromYaw: number, toYaw: number): number {
  return ((((toYaw - fromYaw + 180) % 360) + 360) % 360) - 180;
}

/** Maps a point from {@code space} ("window" | "norm" | "root") into integer X11 root coordinates. */
export function toRootPoint(x: number, y: number, region: RecordingRegion, space: MouseSpace = 'window'): { x: number; y: number } {
  if (space === 'root') return { x: Math.round(x), y: Math.round(y) };
  if (space === 'norm') {
    return {
      x: Math.round(region.x + x * region.width),
      y: Math.round(region.y + y * region.height),
    };
  }
  return { x: Math.round(region.x + x), y: Math.round(region.y + y) };
}

/** Parses X/Y from {@code xdotool getmouselocation --shell}. */
export function parseMouseLocation(output: string): { x: number; y: number } | null {
  let x: number | undefined;
  let y: number | undefined;
  for (const line of output.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = Number(line.slice(idx + 1).trim());
    if (!Number.isFinite(val)) continue;
    if (key === 'X') x = val;
    else if (key === 'Y') y = val;
  }
  return x !== undefined && y !== undefined ? { x, y } : null;
}

export interface WindowInputHost {
  readonly platform?: NodeJS.Platform;
  getDisplay(): string | undefined;
  isHeadless(): boolean;
  /** Optional active recording region to reuse without re-querying xwininfo. */
  getCachedRegion?: () => RecordingRegion | undefined;
  getRotation(): Promise<{ yaw: number; pitch: number }>;
  setRotation(rot: { yaw: number; pitch: number }): Promise<{ yaw: number; pitch: number }>;
  /** Overridable hooks for deterministic unit tests. */
  findBinary?: (name: string) => string | null;
  detectRegion?: (display: string, fullScreen: boolean) => Promise<RecordingRegion>;
  runCommand?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
}

/** Drives X11 window focus, mouse movement/clicks, key presses, and smooth camera pans. */
export class WindowInput {
  private focusedDisplay: string | null = null;
  private cachedRegion: RecordingRegion | null = null;

  constructor(private readonly host: WindowInputHost) {}

  /** Clears cached window geometry and focus state (e.g. after client restart). */
  reset(): void {
    this.focusedDisplay = null;
    this.cachedRegion = null;
  }

  private requireX11(): { display: string; xdotool: string; env: NodeJS.ProcessEnv } {
    if (this.host.isHeadless()) {
      throw new CalciteError('headless', 'Window input needs a display; start the client with render "on-demand" or "always"');
    }
    const platform = this.host.platform ?? process.platform;
    if (platform !== 'linux') {
      throw new CalciteError('unsupported_platform', `Window input currently uses Linux X11 (xdotool) and is not supported on ${platform}`);
    }
    const display = this.host.getDisplay();
    if (!display) {
      throw new CalciteError('no_display', 'No X11 DISPLAY is attached to this client');
    }
    const findBin = this.host.findBinary ?? which;
    const xdotool = findBin('xdotool');
    if (!xdotool) {
      throw new CalciteError('missing_dependency', 'xdotool is not installed or not on PATH');
    }
    return { display, xdotool, env: { ...process.env, DISPLAY: display } };
  }

  private async runXdo(args: string[]): Promise<string> {
    const { xdotool, env } = this.requireX11();
    const runner =
      this.host.runCommand ??
      (async (cmd, cmdArgs, cmdEnv) => {
        const { stdout } = await execFileAsync(cmd, cmdArgs, { env: cmdEnv, timeout: 10_000 });
        return stdout;
      });
    try {
      return await runner(xdotool, args, env);
    } catch (err) {
      throw new CalciteError('input_failed', `xdotool ${args[0] ?? ''} failed: ${(err as Error).message}`);
    }
  }

  private async resolveRegion(refresh = false): Promise<RecordingRegion> {
    const fromRecorder = this.host.getCachedRegion?.();
    if (fromRecorder && !refresh) {
      this.cachedRegion = fromRecorder;
      return fromRecorder;
    }
    if (this.cachedRegion && !refresh) return this.cachedRegion;
    const { display } = this.requireX11();
    const detect = this.host.detectRegion ?? detectCaptureRegion;
    const region = await detect(display, false);
    this.cachedRegion = region;
    return region;
  }

  private async ensureFocused(): Promise<RecordingRegion> {
    const { display } = this.requireX11();
    const region = await this.resolveRegion(this.focusedDisplay !== display);
    if (this.focusedDisplay !== display) {
      if (region.windowId) {
        await this.runXdo(['windowfocus', '--sync', region.windowId]);
      }
      this.focusedDisplay = display;
    }
    return region;
  }

  /** Explicitly focuses the client window on its X11 display. */
  async focus(): Promise<void> {
    const { display } = this.requireX11();
    const region = await this.resolveRegion(true);
    if (region.windowId) {
      await this.runXdo(['windowfocus', '--sync', region.windowId]);
    }
    this.focusedDisplay = display;
  }

  /** Moves the cursor to (x, y), optionally interpolating smoothly over {@code durationMs}. */
  async mouseMove(x: number, y: number, opts: MouseMoveOptions = {}): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new CalciteError('bad_request', `mouseMove coordinates must be finite numbers (got ${x}, ${y})`);
    }
    const durationMs = opts.durationMs ?? 0;
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new CalciteError('bad_request', `durationMs must be >= 0 (got ${durationMs})`);
    }
    const region = await this.ensureFocused();
    const target = toRootPoint(x, y, region, opts.space ?? 'window');

    if (durationMs <= 20) {
      await this.runXdo(['mousemove', '--sync', String(target.x), String(target.y)]);
      return;
    }

    const locOut = await this.runXdo(['getmouselocation', '--shell']);
    const startPos = parseMouseLocation(locOut) ?? { x: region.x, y: region.y };
    const steps = Math.max(2, opts.steps ? Math.round(opts.steps) : Math.round((durationMs / 1000) * 45));
    const stepMs = durationMs / steps;
    const tStart = Date.now();

    for (let i = 1; i <= steps; i++) {
      const frac = i === steps ? 1 : Math.min(1, (Date.now() - tStart) / durationMs);
      const k = easeInOut(Math.max(frac, i / steps));
      const cx = Math.round(startPos.x + (target.x - startPos.x) * k);
      const cy = Math.round(startPos.y + (target.y - startPos.y) * k);
      await this.runXdo(['mousemove', String(cx), String(cy)]);
      if (i < steps) {
        const nextAt = tStart + i * stepMs;
        const wait = nextAt - Date.now();
        if (wait > 0) await sleep(wait);
      }
    }
  }

  /** Clicks a mouse button (1 = left, 2 = middle, 3 = right), optionally moving to (x, y) first. */
  async mouseClick(opts: MouseClickOptions = {}): Promise<void> {
    const button = opts.button ?? 1;
    if (!Number.isInteger(button) || button < 1 || button > 5) {
      throw new CalciteError('bad_request', `mouse button must be an integer 1-5 (got ${button})`);
    }
    const holdMs = opts.holdMs ?? 40;
    if (!Number.isFinite(holdMs) || holdMs < 0) {
      throw new CalciteError('bad_request', `holdMs must be >= 0 (got ${holdMs})`);
    }

    await this.ensureFocused();
    if (opts.x !== undefined || opts.y !== undefined) {
      if (opts.x === undefined || opts.y === undefined) {
        throw new CalciteError('bad_request', 'mouseClick requires both x and y when specifying coordinates');
      }
      await this.mouseMove(opts.x, opts.y, {
        durationMs: opts.durationMs,
        steps: opts.steps,
        space: opts.space,
      });
      await sleep(50);
    }

    await this.runXdo(['mousedown', String(button)]);
    if (holdMs > 0) await sleep(holdMs);
    await this.runXdo(['mouseup', String(button)]);
  }

  /** Sends one or more X11 key presses (e.g. "Escape", "Return", "e", "F3+t"). */
  async keyPress(key: string, opts: KeyPressOptions = {}): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) throw new CalciteError('bad_request', 'key must be a non-empty key name');
    const repeat = opts.repeat ?? 1;
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) {
      throw new CalciteError('bad_request', `repeat must be an integer between 1 and 100 (got ${repeat})`);
    }
    const delayMs = opts.delayMs ?? 100;
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new CalciteError('bad_request', `delayMs must be >= 0 (got ${delayMs})`);
    }

    await this.ensureFocused();
    for (let i = 0; i < repeat; i++) {
      await this.runXdo(['key', '--clearmodifiers', trimmed]);
      if (i + 1 < repeat && delayMs > 0) await sleep(delayMs);
    }
  }

  /** Smoothly pans the player camera using probe look calls with cubic ease-in-out. */
  async panLook(opts: PanLookOptions): Promise<{ yaw: number; pitch: number }> {
    const durationMs = opts.durationMs ?? 1000;
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new CalciteError('bad_request', `durationMs must be > 0 (got ${durationMs})`);
    }
    const current = await this.host.getRotation();
    const startYaw = current.yaw;
    const startPitch = current.pitch;

    let targetYaw = startYaw;
    if (opts.dyaw !== undefined) {
      targetYaw = startYaw + opts.dyaw;
    } else if (opts.yaw !== undefined) {
      targetYaw = startYaw + shortestYawDelta(startYaw, opts.yaw);
    }

    let targetPitch = startPitch;
    if (opts.dpitch !== undefined) {
      targetPitch = Math.max(-90, Math.min(90, startPitch + opts.dpitch));
    } else if (opts.pitch !== undefined) {
      targetPitch = Math.max(-90, Math.min(90, opts.pitch));
    }

    const steps = Math.max(1, opts.steps ? Math.round(opts.steps) : Math.round((durationMs / 1000) * 30));
    const stepMs = durationMs / steps;
    const tStart = Date.now();
    let last = { yaw: targetYaw, pitch: targetPitch };

    for (let i = 1; i <= steps; i++) {
      const k = easeInOut(i / steps);
      const yaw = Number((startYaw + (targetYaw - startYaw) * k).toFixed(2));
      const pitch = Number((startPitch + (targetPitch - startPitch) * k).toFixed(2));
      last = await this.host.setRotation({ yaw, pitch });
      if (i < steps) {
        const nextAt = tStart + i * stepMs;
        const wait = nextAt - Date.now();
        if (wait > 0) await sleep(wait);
      }
    }
    return last;
  }
}
