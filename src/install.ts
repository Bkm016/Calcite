import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHmc, hmcListEntry, hmcQuote, runHmc, writeHmcProfile } from './hmc.js';
import { ensureJava, ensureLauncherJava } from './java.js';
import { ensureClientJar, getVersionJson, requiredJavaMajor, resolveNames, resolveVersion } from './mojang.js';
import { resolvePaths, type CalcitePaths } from './paths.js';
import { CalciteError } from './types.js';

function probeJarSource(): string {
  return process.env.CALCITE_PROBE_JAR || fileURLToPath(new URL('../vendor/calcite-probe.jar', import.meta.url));
}

/** Copies the probe jar to the space-free probe directory (content-addressed). */
export async function installProbe(paths: CalcitePaths): Promise<string> {
  const source = await readFile(probeJarSource());
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const target = join(paths.probe, `calcite-probe-${hash}.jar`);
  try {
    await stat(target);
  } catch {
    await mkdir(paths.probe, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, source);
    await copyFile(tmp, target);
    await rm(tmp, { force: true });
  }
  return target;
}

export interface InstallOptions {
  paths?: CalcitePaths;
  javaPath?: string;
  allowJavaDownload?: boolean;
  onLine?: (line: string) => void;
}

/**
 * Downloads everything a version needs (client, libraries, natives, assets, mappings, Java, HeadlessMC) without
 * starting the game, so later launches start fast and work offline.
 */
export async function installVersion(spec: string, opts: InstallOptions = {}): Promise<{ id: string; java: string; probe: string }> {
  const paths = opts.paths ?? resolvePaths();
  const version = await resolveVersion(paths, spec);
  const json = await getVersionJson(paths, version);
  const clientJar = await ensureClientJar(paths, json);
  const names = await resolveNames(paths, json, clientJar);
  const java = await ensureJava(paths, requiredJavaMajor(json), { javaPath: opts.javaPath, allowDownload: opts.allowJavaDownload });
  const launcherJava = await ensureLauncherJava(paths, { allowDownload: opts.allowJavaDownload });
  const hmcJar = await ensureHmc(paths);
  await installProbe(paths);
  // HeadlessMC downloads the game files when launching; `-version` makes the game JVM exit right away.
  const location = join(paths.hmcHome, 'install', randomBytes(6).toString('hex'));
  try {
    await writeHmcProfile(location, json.id, join(location, 'game'), java.major);
    const run = runHmc({
      javaPath: launcherJava.path,
      hmcJar,
      location,
      props: {
        'hmc.files.mc': paths.minecraft,
        'hmc.files.game': join(location, 'game'),
        'hmc.java.versions': hmcListEntry(java.path),
        'hmc.java.download': 'false',
      },
      command: ['launch', json.id, '--offline', '--headless', `--jvm=${hmcQuote('-version')}`],
      onLine: opts.onLine,
    });
    const code = await run.exited;
    if (code !== 0) throw new CalciteError('install_failed', `HeadlessMC exited with code ${code} while downloading ${json.id}`);
  } finally {
    await rm(location, { recursive: true, force: true }).catch(() => undefined);
  }
  return { id: json.id, java: java.version, probe: names.kind === 'unsupported' ? names.reason : 'supported' };
}
