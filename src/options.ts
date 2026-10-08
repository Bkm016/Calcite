import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Game options Calcite enforces so an unattended client never blocks on first-run screens and stays cheap.
 * Unknown keys are ignored by versions that do not have them.
 */
export function defaultOptions(opts: { renderDistance?: number; maxFps?: number; muted?: boolean } = {}): Record<string, string> {
  return {
    onboardAccessibility: 'false',
    skipMultiplayerWarning: 'true',
    joinedFirstServer: 'true',
    tutorialStep: 'none',
    pauseOnLostFocus: 'false',
    narrator: '0',
    fullscreen: 'false',
    renderDistance: String(opts.renderDistance ?? 8),
    simulationDistance: String(Math.min(opts.renderDistance ?? 8, 8)),
    maxFps: String(opts.maxFps ?? 30),
    ...(opts.muted === false ? {} : { soundCategory_master: '0.0' }),
  };
}

/** Parses options.txt ("key:value" lines). */
export function parseOptions(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) map.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return map;
}

export function serializeOptions(map: Map<string, string>): string {
  return [...map].map(([k, v]) => `${k}:${v}`).join('\n') + '\n';
}

/** Merges {@code overrides} into gameDir/options.txt, keeping every other existing option. */
export async function writeOptions(gameDir: string, overrides: Record<string, string>): Promise<void> {
  await mkdir(gameDir, { recursive: true });
  const file = join(gameDir, 'options.txt');
  let current = new Map<string, string>();
  try {
    current = parseOptions(await readFile(file, 'utf8'));
  } catch {
    // first launch
  }
  for (const [k, v] of Object.entries(overrides)) current.set(k, v);
  await writeFile(file, serializeOptions(current));
}
