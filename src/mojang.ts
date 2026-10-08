import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { download, httpJson } from './net.js';
import type { CalcitePaths } from './paths.js';

export const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

export interface ManifestVersion {
  id: string;
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha' | string;
  url: string;
  sha1: string;
  releaseTime: string;
}

export interface Manifest {
  latest: { release: string; snapshot: string };
  versions: ManifestVersion[];
}

interface Download {
  url: string;
  sha1: string;
  size: number;
}

export interface VersionJson {
  id: string;
  type: string;
  releaseTime: string;
  javaVersion?: { majorVersion: number; component?: string };
  downloads: { client: Download; client_mappings?: Download; server?: Download };
  arguments?: { game?: unknown[]; jvm?: unknown[] };
  minecraftArguments?: string;
}

const MANIFEST_TTL_MS = 10 * 60_000;

export async function getManifest(paths: CalcitePaths, { refresh = false } = {}): Promise<Manifest> {
  const file = join(paths.meta, 'version_manifest_v2.json');
  if (!refresh) {
    try {
      const info = await stat(file);
      if (Date.now() - info.mtimeMs < MANIFEST_TTL_MS) {
        return JSON.parse(await readFile(file, 'utf8')) as Manifest;
      }
    } catch {
      // fetch below
    }
  }
  try {
    const manifest = await httpJson<Manifest>(MANIFEST_URL);
    await mkdir(paths.meta, { recursive: true });
    await writeFile(file, JSON.stringify(manifest));
    return manifest;
  } catch (err) {
    // offline: fall back to a stale cache
    try {
      return JSON.parse(await readFile(file, 'utf8')) as Manifest;
    } catch {
      throw err;
    }
  }
}

/** Resolves "latest"/"release", "snapshot"/"latest-snapshot" or an exact id. */
export async function resolveVersion(paths: CalcitePaths, spec: string): Promise<ManifestVersion> {
  const manifest = await getManifest(paths);
  let id = spec;
  if (spec === 'latest' || spec === 'release' || spec === 'latest-release') id = manifest.latest.release;
  if (spec === 'snapshot' || spec === 'latest-snapshot') id = manifest.latest.snapshot;
  const found = manifest.versions.find((v) => v.id === id);
  if (!found) {
    const refreshed = await getManifest(paths, { refresh: true });
    const again = refreshed.versions.find((v) => v.id === id);
    if (!again) throw new Error(`Unknown Minecraft version "${spec}"`);
    return again;
  }
  return found;
}

/** Version JSON, stored where HeadlessMC expects it (minecraft/versions/<id>/<id>.json). */
export async function getVersionJson(paths: CalcitePaths, version: ManifestVersion): Promise<VersionJson> {
  const file = join(paths.minecraft, 'versions', version.id, `${version.id}.json`);
  await download(version.url, file, { sha1: version.sha1 });
  return JSON.parse(await readFile(file, 'utf8')) as VersionJson;
}

/** Downloads the client jar where HeadlessMC expects it. */
export async function ensureClientJar(paths: CalcitePaths, json: VersionJson): Promise<string> {
  const file = join(paths.minecraft, 'versions', json.id, `${json.id}.jar`);
  await download(json.downloads.client.url, file, { sha1: json.downloads.client.sha1 });
  return file;
}

/** Java major version required by the game (versions before 1.17 default to 8). */
export function requiredJavaMajor(json: VersionJson): number {
  return json.javaVersion?.majorVersion ?? 8;
}

/** Whether the game understands --quickPlayMultiplayer (1.20+); older versions use --server/--port. */
export function supportsQuickPlay(json: VersionJson): boolean {
  return JSON.stringify(json.arguments?.game ?? []).includes('quickPlayMultiplayer');
}

export type NameMode =
  | { kind: 'mappings'; file: string }
  | { kind: 'official' }
  | { kind: 'unsupported'; reason: string };

/**
 * How the probe can find game classes: Mojang mappings (obfuscated 1.14.4+), official names (unobfuscated
 * releases such as 26.1+), or unsupported (obfuscated versions without published mappings, before 1.14.4).
 */
export async function resolveNames(paths: CalcitePaths, json: VersionJson, clientJar: string): Promise<NameMode> {
  if (json.downloads.client_mappings) {
    const file = join(paths.mappings, `${json.id}-client.txt`);
    await download(json.downloads.client_mappings.url, file, { sha1: json.downloads.client_mappings.sha1 });
    return { kind: 'mappings', file };
  }
  if (await zipContains(clientJar, 'net/minecraft/client/Minecraft.class')) {
    return { kind: 'official' };
  }
  return { kind: 'unsupported', reason: `Minecraft ${json.id} is obfuscated and Mojang published no mappings for it (needs 1.14.4+)` };
}

/** Checks the zip central directory for an entry name (no full extraction). */
export async function zipContains(file: string, entry: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const tailSize = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error(`Not a zip file: ${file}`);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    await handle.read(cd, 0, cdSize, cdOffset);
    return cd.includes(Buffer.from(entry, 'utf8'));
  } finally {
    await handle.close();
  }
}

