import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHmc, hmcJavaHome, hmcListEntry, hmcQuote, hmcVersionArgs, runHmc, writeHmcProfile } from './hmc.js';
import { ensureJava, ensureLauncherJava, type JavaInstall } from './java.js';
import { findLoader, formatLoader, parseLoader, type InstalledLoader, type LoaderSpec } from './loaders.js';
import { withLock } from './lock.js';
import { ensureClientJar, getVersionJson, requiredJavaMajor, resolveVersion, type VersionJson } from './mojang.js';
import { resolveNames, type NameMode } from './names.js';
import { resolvePaths, type CalcitePaths } from './paths.js';
import { CalciteError } from './types.js';

/** HeadlessMC 3's LWJGL stubs need Java 9+; the Java 8 versions (up to 1.16.5) run headless on Java 17 instead. */
const HEADLESS_MIN_JAVA = 17;

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

export interface PrepareOptions {
  /** Minecraft version id, "release" or "snapshot". */
  version: string;
  /** Mod loader: "fabric", "forge", "neoforge", optionally "@<loader version>". */
  loader?: string;
  javaPath?: string;
  allowJavaDownload?: boolean;
  /** Whether the game will run without a renderer (picks Java 17 for the Java 8 versions). */
  headless?: boolean;
  /** HeadlessMC output while installing a loader. */
  onLine?: (line: string) => void;
}

export interface PreparedGame {
  json: VersionJson;
  clientJar: string;
  loader?: InstalledLoader;
  names: NameMode;
  java: JavaInstall;
  launcherJava: JavaInstall;
  hmcJar: string;
}

/** Downloads and verifies what launching needs: version files, Java, HeadlessMC, the mod loader and name tables. */
export async function prepareGame(paths: CalcitePaths, opts: PrepareOptions): Promise<PreparedGame> {
  const spec = parseLoader(opts.loader);
  const json = await getVersionJson(paths, await resolveVersion(paths, opts.version));
  const clientJar = await ensureClientJar(paths, json);
  const required = requiredJavaMajor(json);
  const modded = !!spec && spec.kind !== 'fabric';
  if (modded && opts.headless && required < 9) {
    throw new CalciteError('unsupported_loader', `${spec.kind} for Minecraft ${json.id} needs Java ${required}, which cannot run headless; use render "on-demand"`);
  }
  const java = await ensureJava(paths, opts.headless && required < 9 ? HEADLESS_MIN_JAVA : required, {
    javaPath: opts.javaPath,
    allowDownload: opts.allowJavaDownload,
    exact: modded,
  });
  const launcherJava = await ensureLauncherJava(paths, { allowDownload: opts.allowJavaDownload });
  const hmcJar = await ensureHmc(paths);
  const loader = spec ? await ensureLoader(paths, json, spec, { java, launcherJava, hmcJar, onLine: opts.onLine }) : undefined;
  const names = await resolveNames(paths, json, clientJar, loader);
  return { json, clientJar, loader, names, java, launcherJava, hmcJar };
}

interface HmcRuntime {
  java: JavaInstall;
  launcherJava: JavaInstall;
  hmcJar: string;
  onLine?: (line: string) => void;
}

/**
 * Lets HeadlessMC prepare a version without playing it: it downloads the game files (and installs a mod loader)
 * when launching; `-version` makes the game JVM exit right away.
 */
async function hmcDryLaunch(paths: CalcitePaths, json: VersionJson, loader: LoaderSpec | undefined, rt: HmcRuntime): Promise<void> {
  const location = join(paths.hmcHome, 'install', randomBytes(6).toString('hex'));
  try {
    await writeHmcProfile(location, json.id, join(location, 'game'), rt.java.major, loader);
    const run = runHmc({
      javaPath: rt.launcherJava.path,
      hmcJar: rt.hmcJar,
      location,
      props: {
        'hmc.files.mc': paths.minecraft,
        'hmc.files.game': join(location, 'game'),
        'hmc.java.versions': hmcListEntry(hmcJavaHome(rt.java.path)),
        'hmc.java.download': 'false',
      },
      command: ['launch', ...hmcVersionArgs(json.id, loader), '--offline', '--headless', `--jvm=${hmcQuote('-version')}`],
      onLine: rt.onLine,
    });
    const code = await run.exited;
    const what = loader ? `${formatLoader(loader)} for ${json.id}` : json.id;
    if (code !== 0) throw new CalciteError('install_failed', `HeadlessMC exited with code ${code} while installing ${what}`);
  } finally {
    await rm(location, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The installed loader matching {@code spec}, installing it through HeadlessMC first when missing. */
async function ensureLoader(paths: CalcitePaths, json: VersionJson, spec: LoaderSpec, rt: HmcRuntime): Promise<InstalledLoader> {
  const found = await findLoader(paths, json.id, spec);
  if (found) return found;
  return withLock(join(paths.minecraft, 'versions', `.calcite-${spec.kind}-${json.id}.lock`), async () => {
    const again = await findLoader(paths, json.id, spec);
    if (again) return again;
    await hmcDryLaunch(paths, json, spec, rt);
    const installed = await findLoader(paths, json.id, spec);
    if (!installed) {
      throw new CalciteError('install_failed', `HeadlessMC did not install ${formatLoader(spec)} for Minecraft ${json.id} (is there a build for this version?)`);
    }
    return installed;
  });
}

export interface InstallOptions {
  paths?: CalcitePaths;
  /** Mod loader to install as well: "fabric", "forge", "neoforge", optionally "@<loader version>". */
  loader?: string;
  javaPath?: string;
  allowJavaDownload?: boolean;
  onLine?: (line: string) => void;
}

/**
 * Downloads everything a version needs (client, libraries, natives, assets, mappings, Java, HeadlessMC, the mod
 * loader) without starting the game, so later launches start fast and work offline.
 */
export async function installVersion(
  spec: string,
  opts: InstallOptions = {},
): Promise<{ id: string; loader?: string; java: string; probe: string }> {
  const paths = opts.paths ?? resolvePaths();
  const game = await prepareGame(paths, { version: spec, loader: opts.loader, javaPath: opts.javaPath, allowJavaDownload: opts.allowJavaDownload, onLine: opts.onLine });
  await installProbe(paths);
  await hmcDryLaunch(paths, game.json, game.loader, game);
  return {
    id: game.json.id,
    loader: game.loader ? `${game.loader.kind}@${game.loader.build}` : undefined,
    java: game.java.version,
    probe: game.names.kind === 'unsupported' ? game.names.reason : 'supported',
  };
}
