import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { withLock } from './lock.js';
import { logger } from './log.js';
import { download, httpJson } from './net.js';
import type { CalcitePaths } from './paths.js';

const execFileAsync = promisify(execFile);
const log = logger('java');

export interface JavaInstall {
  /** Path of the java executable. */
  path: string;
  /** Major version (8, 17, 21, ...). */
  major: number;
  /** Full version string. */
  version: string;
}

const EXE = process.platform === 'win32' ? 'java.exe' : 'java';

/** Parses "java.specification.version = 1.8" / "= 21" from -XshowSettings output. */
export function parseJavaSettings(output: string): { major: number; version: string } | null {
  const spec = /java\.specification\.version = (\S+)/.exec(output);
  const version = /java\.version = (\S+)/.exec(output);
  if (!spec) return null;
  const raw = spec[1];
  const major = raw.startsWith('1.') ? Number(raw.slice(2)) : Number(raw);
  if (!Number.isFinite(major)) return null;
  return { major, version: version ? version[1] : raw };
}

async function probeJava(path: string): Promise<JavaInstall | null> {
  try {
    const env = { ...process.env };
    delete env.JAVA_TOOL_OPTIONS;
    delete env._JAVA_OPTIONS;
    const { stdout, stderr } = await execFileAsync(path, ['-XshowSettings:properties', '-version'], { timeout: 20_000, env });
    const parsed = parseJavaSettings(`${stdout}\n${stderr}`);
    return parsed ? { path, ...parsed } : null;
  } catch {
    return null;
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** Java homes to look at: env, PATH, well-known install locations and Calcite-managed runtimes. */
async function candidateExecutables(paths: CalcitePaths): Promise<string[]> {
  const homes: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value && (key === 'JAVA_HOME' || /^JAVA_HOME_\d+/.test(key) || /^CALCITE_JAVA_\d+$/.test(key))) homes.push(value);
  }
  const roots: string[] = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]) {
      if (!base) continue;
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru']) {
        roots.push(join(base, vendor));
      }
    }
    if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium'));
  } else if (process.platform === 'darwin') {
    roots.push('/Library/Java/JavaVirtualMachines', join(process.env.HOME || '', 'Library/Java/JavaVirtualMachines'));
  } else {
    roots.push('/usr/lib/jvm', '/usr/java', '/opt/java', '/opt/jdk', join(process.env.HOME || '', '.sdkman/candidates/java'));
  }
  for (const root of roots) homes.push(...(await subdirs(root)));
  // runtimes downloaded by Calcite: java/temurin-<major>-<os>-<arch>/<archive root>/
  for (const managed of await subdirs(paths.java)) homes.push(managed, ...(await subdirs(managed)));

  const exes = new Set<string>();
  for (const home of homes) {
    for (const bin of [join(home, 'bin', EXE), join(home, 'Contents', 'Home', 'bin', EXE)]) {
      if (existsSync(bin)) exes.add(bin);
    }
  }
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    const bin = join(dir, EXE);
    if (dir && existsSync(bin)) exes.add(bin);
  }
  return [...exes];
}

export async function findJavaInstalls(paths: CalcitePaths): Promise<JavaInstall[]> {
  const results = await Promise.all((await candidateExecutables(paths)).map(probeJava));
  const seen = new Set<string>();
  return results.filter((j): j is JavaInstall => {
    if (!j) return false;
    const key = `${j.major}:${j.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Picks a runtime for {@code major}: exact major first; Minecraft 1.17+ (Java 16/17/21/25) also runs on newer
 * runtimes, legacy versions (Java 8) need exactly 8.
 */
export function pickJava(installs: JavaInstall[], major: number): JavaInstall | undefined {
  const exact = installs.filter((j) => j.major === major);
  if (exact.length) return exact[0];
  if (major <= 8) return undefined;
  return installs.filter((j) => j.major > major).sort((a, b) => a.major - b.major)[0];
}

function adoptiumOs(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'mac';
    case 'linux':
      return 'linux';
    default:
      throw new Error(`Automatic Java download is not supported on ${process.platform}`);
  }
}

function adoptiumArch(): string {
  switch (process.arch) {
    case 'x64':
      return 'x64';
    case 'arm64':
      return 'aarch64';
    case 'ia32':
      return 'x32';
    default:
      throw new Error(`Automatic Java download is not supported on ${process.arch}`);
  }
}

interface AdoptiumAsset {
  binary: { package: { link: string; checksum: string; name: string } };
  version: { semver: string };
}

/** Downloads an Eclipse Temurin runtime for {@code major} into CALCITE_HOME/java. */
export async function downloadJava(paths: CalcitePaths, major: number): Promise<JavaInstall> {
  const os = adoptiumOs();
  const arch = adoptiumArch();
  const target = join(paths.java, `temurin-${major}-${os}-${arch}`);
  return withLock(`${target}.lock`, async () => {
    const existing = await findInDir(target);
    if (existing) return existing;
    let asset: AdoptiumAsset | undefined;
    for (const image of ['jre', 'jdk']) {
      const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${arch}&image_type=${image}&os=${os}&vendor=eclipse`;
      const assets = await httpJson<AdoptiumAsset[]>(url).catch(() => []);
      asset = assets[0];
      if (asset) break;
    }
    if (!asset) throw new Error(`No Temurin ${major} build for ${os}/${arch}`);
    const pkg = asset.binary.package;
    log.info(`downloading Temurin ${asset.version.semver} (${pkg.name})`);
    const archive = join(paths.java, pkg.name);
    await download(pkg.link, archive, { sha256: pkg.checksum });
    const staging = `${target}.extract`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    // tar handles .tar.gz everywhere and .zip on Windows 10+ (bsdtar)
    await execFileAsync('tar', ['-xf', archive, '-C', staging], { timeout: 10 * 60_000 });
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    await rm(archive, { force: true });
    const installed = await findInDir(target);
    if (!installed) throw new Error(`Extracted Java ${major} but found no java executable in ${target}`);
    return installed;
  });
}

async function findInDir(dir: string): Promise<JavaInstall | null> {
  try {
    await stat(dir);
  } catch {
    return null;
  }
  for (const home of [dir, ...(await subdirs(dir))]) {
    for (const bin of [join(home, 'bin', EXE), join(home, 'Contents', 'Home', 'bin', EXE)]) {
      if (existsSync(bin)) {
        const j = await probeJava(bin);
        if (j) return j;
      }
    }
  }
  return null;
}

export interface EnsureJavaOptions {
  /** Explicit java executable; skips detection. */
  javaPath?: string;
  /** Download a runtime when none is installed (default true). */
  allowDownload?: boolean;
  /** Only accept exactly {@code major} (Forge and NeoForge refuse newer runtimes). */
  exact?: boolean;
}

export async function ensureJava(paths: CalcitePaths, major: number, opts: EnsureJavaOptions = {}): Promise<JavaInstall> {
  if (opts.javaPath) {
    const j = await probeJava(opts.javaPath);
    if (!j) throw new Error(`Not a working java executable: ${opts.javaPath}`);
    return j;
  }
  const installs = await findJavaInstalls(paths);
  const picked = opts.exact ? installs.find((j) => j.major === major) : pickJava(installs, major);
  if (picked) return picked;
  if (opts.allowDownload === false) {
    throw new Error(`Java ${major}${opts.exact ? '' : ' or newer'} is required but not installed (automatic download disabled)`);
  }
  return downloadJava(paths, major);
}

/** Java release HeadlessMC 3 itself runs on (the game may use another runtime). */
export const LAUNCHER_JAVA_MAJOR = 25;

/** A runtime for HeadlessMC itself (Java 25+); prefers an installed one, downloads Java 25 otherwise. */
export async function ensureLauncherJava(paths: CalcitePaths, opts: { allowDownload?: boolean } = {}): Promise<JavaInstall> {
  const picked = pickJava(await findJavaInstalls(paths), LAUNCHER_JAVA_MAJOR);
  if (picked) return picked;
  if (opts.allowDownload === false) {
    throw new Error(`HeadlessMC needs Java ${LAUNCHER_JAVA_MAJOR} or newer, which is not installed (automatic download disabled)`);
  }
  return downloadJava(paths, LAUNCHER_JAVA_MAJOR);
}
