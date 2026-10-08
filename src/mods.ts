import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { LoaderKind } from './loaders.js';
import { download, httpJson } from './net.js';
import type { CalcitePaths } from './paths.js';
import { CalciteError } from './types.js';

const MODRINTH_API = 'https://api.modrinth.com/v2';
const MANIFEST = '.calcite-mods.json';

/** A mod jar ready to be placed in the game's mods folder. */
export interface ModFile {
  /** File name inside the mods folder. */
  name: string;
  /** Local source file. */
  file: string;
  /** Where it came from (the spec, or "<spec> → dependency"). */
  source: string;
}

interface ModrinthFile {
  url: string;
  filename: string;
  primary: boolean;
  hashes: { sha1: string };
}

interface ModrinthVersion {
  id: string;
  project_id: string;
  version_number: string;
  version_type: string;
  files: ModrinthFile[];
  dependencies: { project_id: string | null; version_id: string | null; dependency_type: string }[];
}

function safeName(name: string): string {
  const clean = basename(name.replace(/\\/g, '/'));
  if (!clean || clean.startsWith('.') || !clean.toLowerCase().endsWith('.jar')) {
    throw new CalciteError('bad_mod', `Not a mod jar: "${name}"`);
  }
  return clean;
}

async function modrinthVersion(project: string, version: string | undefined, mc: string, loader: LoaderKind): Promise<ModrinthVersion> {
  const query = `loaders=${encodeURIComponent(JSON.stringify([loader]))}&game_versions=${encodeURIComponent(JSON.stringify([mc]))}`;
  let versions: ModrinthVersion[];
  try {
    versions = await httpJson<ModrinthVersion[]>(`${MODRINTH_API}/project/${encodeURIComponent(project)}/version?${query}`);
  } catch (err) {
    if ((err as { status?: number }).status === 404) throw new CalciteError('mod_not_found', `Modrinth has no project "${project}"`);
    throw err;
  }
  const pick = version
    ? versions.find((v) => v.version_number === version || v.id === version)
    : (versions.find((v) => v.version_type === 'release') ?? versions[0]);
  if (!pick) {
    throw new CalciteError(
      'mod_not_found',
      `Modrinth project "${project}" has no ${version ? `version "${version}"` : 'version'} for ${loader} on Minecraft ${mc}`,
    );
  }
  return pick;
}

async function modrinthFile(paths: CalcitePaths, v: ModrinthVersion): Promise<{ name: string; file: string }> {
  const f = v.files.find((x) => x.primary) ?? v.files[0];
  if (!f) throw new CalciteError('mod_not_found', `Modrinth version ${v.id} has no files`);
  const name = safeName(f.filename);
  const file = join(paths.mods, 'modrinth', f.hashes.sha1, name);
  await download(f.url, file, { sha1: f.hashes.sha1 });
  return { name, file };
}

async function localJars(spec: string): Promise<string[]> {
  const path = resolve(spec);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new CalciteError('mod_not_found', `Mod file or folder not found: ${path}`);
  }
  if (!info.isDirectory()) return [path];
  return (await readdir(path)).filter((n) => n.toLowerCase().endsWith('.jar')).sort().map((n) => join(path, n));
}

/**
 * Resolves mod specs to local jars: a jar or folder of jars, an http(s) URL, or "modrinth:<project>[@<version>]"
 * (the newest release for this Minecraft version and loader, plus its required dependencies).
 */
export async function resolveMods(paths: CalcitePaths, specs: string[], mc: string, loader: LoaderKind): Promise<ModFile[]> {
  const mods: ModFile[] = [];
  const projects = new Set<string>();
  const pending: { project: string; version?: string; source: string }[] = [];
  for (const raw of specs) {
    const spec = raw.trim();
    if (!spec) continue;
    const modrinth = /^modrinth:([^@\s]+)(?:@(\S+))?$/i.exec(spec);
    if (modrinth) {
      pending.push({ project: modrinth[1], version: modrinth[2], source: spec });
    } else if (/^https?:\/\//i.test(spec)) {
      const url = new URL(spec);
      const name = safeName(decodeURIComponent(url.pathname));
      const file = join(paths.mods, 'url', createHash('sha256').update(spec).digest('hex').slice(0, 16), name);
      await download(spec, file);
      mods.push({ name, file, source: spec });
    } else {
      for (const file of await localJars(spec)) mods.push({ name: safeName(file), file, source: spec });
    }
  }
  // Modrinth projects and their required dependencies, breadth first
  while (pending.length) {
    const next = pending.shift()!;
    const v = await modrinthVersion(next.project, next.version, mc, loader);
    if (projects.has(v.project_id)) continue;
    projects.add(v.project_id);
    mods.push({ ...(await modrinthFile(paths, v)), source: next.source });
    for (const dep of v.dependencies) {
      if (dep.dependency_type !== 'required' || !dep.project_id || projects.has(dep.project_id)) continue;
      pending.push({ project: dep.project_id, source: `${next.source} → dependency` });
    }
  }
  const seen = new Map<string, string>();
  for (const m of mods) {
    const other = seen.get(m.name);
    if (other && other !== m.file) throw new CalciteError('bad_mod', `Two mods share the file name ${m.name}`);
    seen.set(m.name, m.file);
  }
  return mods.filter((m, i) => mods.findIndex((x) => x.name === m.name) === i);
}

/**
 * Makes {@code gameDir}/mods contain exactly the given Calcite-managed mods. Files Calcite did not place there are
 * left alone; managed files no longer requested are removed.
 */
export async function syncMods(gameDir: string, mods: ModFile[]): Promise<void> {
  const dir = join(gameDir, 'mods');
  const manifest = join(dir, MANIFEST);
  let previous: string[] = [];
  try {
    previous = (JSON.parse(await readFile(manifest, 'utf8')) as { files?: string[] }).files ?? [];
  } catch {
    // first sync
  }
  const wanted = new Set(mods.map((m) => m.name));
  for (const name of previous) {
    if (!wanted.has(name)) await rm(join(dir, basename(name)), { force: true });
  }
  if (!mods.length) {
    await rm(manifest, { force: true });
    return;
  }
  await mkdir(dir, { recursive: true });
  for (const m of mods) await copyFile(m.file, join(dir, m.name));
  await writeFile(manifest, JSON.stringify({ files: [...wanted] }, null, 2));
}
