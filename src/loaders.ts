import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CalcitePaths } from './paths.js';
import { CalciteError } from './types.js';

export const LOADERS = ['fabric', 'forge', 'neoforge'] as const;
export type LoaderKind = (typeof LOADERS)[number];

/** A requested mod loader: "fabric", "neoforge@21.11.45", ... */
export interface LoaderSpec {
  kind: LoaderKind;
  /** Loader version; the newest installed (or HeadlessMC's default) when omitted. */
  build?: string;
}

export interface LoaderVersionJson {
  id: string;
  inheritsFrom?: string;
  mainClass?: string;
  libraries?: { name: string }[];
  arguments?: { game?: unknown[] };
}

/** A loader version installed in the shared minecraft/versions directory. */
export interface InstalledLoader {
  kind: LoaderKind;
  build: string;
  /** Version id of the loader profile, e.g. "fabric-loader-0.19.5-1.21.11". */
  id: string;
  json: LoaderVersionJson;
}

/** Parses "fabric", "fabric@0.19.5", "neoforge@21.11.45", "forge@47.4.26"; "vanilla"/"none"/"" mean no loader. */
export function parseLoader(spec: string | undefined): LoaderSpec | undefined {
  const s = spec?.trim().toLowerCase();
  if (!s || s === 'vanilla' || s === 'none') return undefined;
  const at = s.indexOf('@');
  const kind = (at < 0 ? s : s.slice(0, at)) as LoaderKind;
  const build = at < 0 ? undefined : s.slice(at + 1);
  if (!LOADERS.includes(kind)) {
    throw new CalciteError('bad_loader', `Unknown mod loader "${spec}" (supported: ${LOADERS.join(', ')}, optionally with @version)`);
  }
  if (build !== undefined && !/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(build)) {
    throw new CalciteError('bad_loader', `Invalid ${kind} version "${build}"`);
  }
  return { kind, build };
}

export function formatLoader(spec: LoaderSpec): string {
  return spec.build ? `${spec.kind}@${spec.build}` : spec.kind;
}

/** The loader build encoded in a version id of {@code kind} for Minecraft {@code mc}, if it is one. */
export function loaderBuild(kind: LoaderKind, id: string, mc: string): string | undefined {
  const escaped = mc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = {
    fabric: new RegExp(`^fabric-loader-(.+)-${escaped}$`),
    forge: new RegExp(`^${escaped}-forge-(.+)$`),
    neoforge: /^neoforge-(.+)$/,
  }[kind];
  return pattern.exec(id)?.[1];
}

/** Orders loader builds numerically ("0.19.10" > "0.19.5", "21.11.45" > "21.11.9"). */
export function compareBuilds(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    const d = !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : x.localeCompare(y);
    if (d !== 0) return d;
  }
  return 0;
}

/** Loader versions of {@code kind} installed for Minecraft {@code mc}, newest first. */
export async function installedLoaders(paths: CalcitePaths, mc: string, kind: LoaderKind): Promise<InstalledLoader[]> {
  const dir = join(paths.minecraft, 'versions');
  let ids: string[];
  try {
    ids = await readdir(dir);
  } catch {
    return [];
  }
  const found: InstalledLoader[] = [];
  for (const id of ids) {
    const build = loaderBuild(kind, id, mc);
    if (!build) continue;
    try {
      const json = JSON.parse(await readFile(join(dir, id, `${id}.json`), 'utf8')) as LoaderVersionJson;
      if (json.inheritsFrom === mc) found.push({ kind, build, id, json });
    } catch {
      // incomplete install
    }
  }
  return found.sort((a, b) => compareBuilds(b.build, a.build));
}

/** The installed loader matching {@code spec} (exact build, or the newest one when no build is given). */
export async function findLoader(paths: CalcitePaths, mc: string, spec: LoaderSpec): Promise<InstalledLoader | undefined> {
  const all = await installedLoaders(paths, mc, spec.kind);
  return spec.build ? all.find((l) => l.build === spec.build) : all[0];
}

/** Value of a game argument such as "--fml.mcpVersion" in a loader profile. */
export function loaderGameArg(json: LoaderVersionJson, name: string): string | undefined {
  const args = json.arguments?.game ?? [];
  const i = args.indexOf(name);
  return i >= 0 && typeof args[i + 1] === 'string' ? (args[i + 1] as string) : undefined;
}
