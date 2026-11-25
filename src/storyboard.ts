import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  CalciteError,
  type KeyPressOptions,
  type MouseClickOptions,
  type MouseMoveOptions,
  type PanLookOptions,
  type RecordOptions,
  type RecordingResult,
  type RecordingStatus,
  type Storyboard,
  type StoryboardResult,
  type StoryboardRunOptions,
  type StoryboardStep,
} from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StoryboardDriver {
  executeLine(line: string): Promise<string | undefined>;
  startRecording(opts?: RecordOptions): Promise<RecordingStatus>;
  stopRecording(): Promise<RecordingResult>;
  recording(): RecordingStatus | null;
  focusWindow(): Promise<void>;
  mouseMove(x: number, y: number, opts?: MouseMoveOptions): Promise<void>;
  mouseClick(opts?: MouseClickOptions): Promise<void>;
  keyPress(key: string, opts?: KeyPressOptions): Promise<void>;
  panLook(opts: PanLookOptions): Promise<{ yaw: number; pitch: number }>;
  screenshot(): Promise<{ png: Buffer }>;
}

/** Validates a storyboard object loaded from JSON or passed programmatically. */
export function validateStoryboard(raw: unknown): Storyboard {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CalciteError('bad_request', 'Storyboard must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.steps)) {
    throw new CalciteError('bad_request', 'Storyboard must contain a "steps" array');
  }
  const validateStepList = (list: unknown, field: string) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) throw new CalciteError('bad_request', `Storyboard "${field}" must be an array`);
    for (let i = 0; i < list.length; i++) {
      const item: unknown = list[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new CalciteError('bad_request', `Storyboard ${field}[${i}] must be an object`);
      }
    }
  };
  validateStepList(obj.setup, 'setup');
  validateStepList(obj.steps, 'steps');
  validateStepList(obj.teardown, 'teardown');
  return obj as unknown as Storyboard;
}

/** Loads and validates a JSON storyboard file from disk. */
export async function loadStoryboardFile(filePath: string): Promise<Storyboard> {
  const abs = resolve(filePath);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch (err) {
    throw new CalciteError('bad_request', `Cannot read storyboard "${abs}": ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CalciteError('bad_request', `Invalid JSON in storyboard "${abs}": ${(err as Error).message}`);
  }
  return validateStoryboard(parsed);
}

async function runStep(
  driver: StoryboardDriver,
  step: StoryboardStep,
  phase: 'setup' | 'step' | 'teardown',
  tStart: number | null,
  dryRun: boolean,
  shots: string[],
  logLine: (line: string) => void,
): Promise<void> {
  const prefix = dryRun ? `[dry:${phase}]` : tStart !== null ? `[${((Date.now() - tStart) / 1000).toFixed(2).padStart(5)}s]` : `[${phase}]`;

  if (step.note) logLine(`${prefix} # ${step.note}`);

  if (step.wait !== undefined) {
    const sec = step.wait;
    if (!Number.isFinite(sec) || sec < 0) throw new CalciteError('bad_request', `Invalid wait seconds: ${step.wait}`);
    logLine(`${prefix} wait ${sec.toFixed(2)}s`);
    if (!dryRun && sec > 0) await sleep(Math.round(sec * 1000));
  }

  if (step.exec !== undefined) {
    const lines = Array.isArray(step.exec) ? step.exec : [step.exec];
    for (const line of lines) {
      logLine(`${prefix} exec ${line}`);
      if (!dryRun) await driver.executeLine(line);
    }
  }

  if (step.focus) {
    logLine(`${prefix} focus`);
    if (!dryRun) await driver.focusWindow();
  }

  if (step.move) {
    const m = step.move;
    logLine(`${prefix} move (${m.x}, ${m.y}) dur=${m.duration ?? 0}s`);
    if (!dryRun) {
      await driver.mouseMove(m.x, m.y, {
        durationMs: m.duration ? Math.round(m.duration * 1000) : 0,
        steps: m.steps,
        space: m.space,
      });
    }
  }

  if (step.click) {
    const c = typeof step.click === 'object' ? step.click : {};
    const pos = c.x !== undefined && c.y !== undefined ? `(${c.x}, ${c.y})` : 'current';
    logLine(`${prefix} click ${pos} btn=${c.button ?? 1}`);
    if (!dryRun) {
      await driver.mouseClick({
        x: c.x,
        y: c.y,
        button: c.button,
        durationMs: c.duration ? Math.round(c.duration * 1000) : 0,
        steps: c.steps,
        holdMs: c.hold !== undefined ? Math.round(c.hold * 1000) : undefined,
        space: c.space,
      });
    }
  }

  if (step.key !== undefined) {
    const k = typeof step.key === 'string' ? { key: step.key } : step.key;
    logLine(`${prefix} key ${k.key} x${k.repeat ?? 1}`);
    if (!dryRun) {
      await driver.keyPress(k.key, {
        repeat: k.repeat,
        delayMs: k.delay !== undefined ? Math.round(k.delay * 1000) : undefined,
      });
    }
  }

  if (step.pan) {
    const p = step.pan;
    logLine(`${prefix} pan ${JSON.stringify(p)}`);
    if (!dryRun) {
      await driver.panLook({
        yaw: p.yaw,
        pitch: p.pitch,
        dyaw: p.dyaw,
        dpitch: p.dpitch,
        durationMs: p.duration !== undefined ? Math.round(p.duration * 1000) : undefined,
        steps: p.steps,
      });
    }
  }

  if (step.shot) {
    const abs = resolve(step.shot);
    logLine(`${prefix} shot ${abs}`);
    if (!dryRun) {
      const { png } = await driver.screenshot();
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, png);
    }
    shots.push(abs);
  }
}

/**
 * Executes a declarative video storyboard:
 * setup -> startRecording -> preroll -> steps -> postroll -> stopRecording -> teardown.
 */
export async function executeStoryboard(
  driver: StoryboardDriver,
  source: Storyboard | string,
  opts: StoryboardRunOptions = {},
): Promise<StoryboardResult> {
  const sb = typeof source === 'string' ? await loadStoryboardFile(source) : validateStoryboard(source);
  const dryRun = opts.dryRun ?? false;
  const logLine = opts.onLog ?? (() => undefined);

  const recOpts: RecordOptions = {
    output: opts.output ?? sb.output,
    fps: opts.fps ?? sb.fps,
    crf: opts.crf ?? sb.crf,
    cursor: opts.cursor ?? sb.cursor,
    fullScreen: opts.fullScreen ?? sb.fullScreen,
  };
  const prerollMs = Math.max(0, Math.round((sb.preroll ?? 0.3) * 1000));
  const postrollMs = Math.max(0, Math.round((sb.postroll ?? 0.5) * 1000));

  const setup = sb.setup ?? [];
  const teardown = sb.teardown ?? [];
  const shots: string[] = [];
  let stepsExecuted = 0;

  if (sb.name) logLine(`[storyboard] ${sb.name}`);

  for (const step of setup) {
    await runStep(driver, step, 'setup', null, dryRun, shots, logLine);
  }

  if (dryRun) {
    for (const step of sb.steps) {
      await runStep(driver, step, 'step', null, true, shots, logLine);
      stepsExecuted++;
    }
    for (const step of teardown) {
      await runStep(driver, step, 'teardown', null, true, shots, logLine);
    }
    return { shots, stepsExecuted, dryRun: true };
  }

  let recording: RecordingResult | undefined;
  let started = false;
  try {
    await driver.startRecording(recOpts);
    started = true;
    const tStart = Date.now();
    if (prerollMs > 0) await sleep(prerollMs);
    for (const step of sb.steps) {
      await runStep(driver, step, 'step', tStart, false, shots, logLine);
      stepsExecuted++;
    }
    if (postrollMs > 0) await sleep(postrollMs);
    recording = await driver.stopRecording();
    started = false;
  } finally {
    if (started && driver.recording()) {
      await driver.stopRecording().catch(() => undefined);
    }
    for (const step of teardown) {
      await runStep(driver, step, 'teardown', null, false, shots, logLine).catch(() => undefined);
    }
  }

  return { recording, shots, stepsExecuted, dryRun: false };
}
