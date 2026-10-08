import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loaderGameArg, type InstalledLoader } from './loaders.js';
import type { VersionJson } from './mojang.js';
import { download } from './net.js';
import type { CalcitePaths } from './paths.js';
import { readZipEntry, zipContains } from './zip.js';

/** Probe name candidate meaning "the game runs with official (Mojang) names". */
export const OFFICIAL = 'official';

/**
 * How the probe finds game classes: candidate name tables (mapping files or {@link OFFICIAL}), tried in order by the
 * probe until one matches the running game; or unsupported (no names known for this game).
 */
export type NameMode = { kind: 'probe'; candidates: string[] } | { kind: 'unsupported'; reason: string };

/** Bumped when the composed mapping format changes, so cached files are rebuilt. */
const COMPOSE_FORMAT = 1;

// releases where the loaders changed the runtime names of Minecraft
const FORGE_MOJANG_CLASSES = Date.parse('2021-06-08T00:00:00Z'); // 1.17: Mojang class names + SRG members
const NEOFORGE_MOJMAP = Date.parse('2024-04-23T00:00:00Z'); // 1.20.5: NeoForge runs on Mojang names
const FORGE_MOJMAP = Date.parse('2024-04-29T00:00:00Z'); // 1.20.6: Forge runs on Mojang names

/**
 * Name candidates for the probe. Vanilla and loaders running on Mojang names use Mojang's mappings (or official
 * names on unobfuscated releases such as 26.1+); Fabric uses intermediary names and Forge/NeoForge before 1.20.5/6
 * use SRG member names, both composed with Mojang's mappings.
 */
export async function resolveNames(paths: CalcitePaths, json: VersionJson, clientJar: string, loader?: InstalledLoader): Promise<NameMode> {
  if (!json.downloads.client_mappings) {
    if (await zipContains(clientJar, 'net/minecraft/client/Minecraft.class')) return { kind: 'probe', candidates: [OFFICIAL] };
    return { kind: 'unsupported', reason: `Minecraft ${json.id} is obfuscated and Mojang published no mappings for it (needs 1.14.4+)` };
  }
  const mojang = join(paths.mappings, `${json.id}-client.txt`);
  await download(json.downloads.client_mappings.url, mojang, { sha1: json.downloads.client_mappings.sha1 });
  if (!loader) return { kind: 'probe', candidates: [mojang] };
  const released = Date.parse(json.releaseTime);
  if (loader.kind === 'fabric') {
    return { kind: 'probe', candidates: [await composeFabric(paths, json.id, mojang, loader)] };
  }
  if ((loader.kind === 'forge' && released >= FORGE_MOJMAP) || (loader.kind === 'neoforge' && released >= NEOFORGE_MOJMAP)) {
    return { kind: 'probe', candidates: [OFFICIAL] };
  }
  if (loader.kind === 'forge' && released < FORGE_MOJANG_CLASSES) {
    return { kind: 'unsupported', reason: `Forge for Minecraft ${json.id} runs on MCP names, which the probe does not support (needs 1.17+)` };
  }
  // the exact switch to Mojang names is not tied to a version number for every build: let the probe check both
  const srg = await composeSrg(paths, json.id, mojang, loader);
  return { kind: 'probe', candidates: srg ? [srg, OFFICIAL] : [OFFICIAL] };
}

// ---------------------------------------------------------------- target name tables

/** Names of obfuscated members in some namespace, keyed by obfuscated owner (internal name), name and descriptor. */
export interface TargetNames {
  classes: Map<string, string>;
  /** "owner.name:desc" and "owner.name" */
  fields: Map<string, string>;
  /** "owner.name(desc)" */
  methods: Map<string, string>;
}

function emptyTarget(): TargetNames {
  return { classes: new Map(), fields: new Map(), methods: new Map() };
}

function addField(t: TargetNames, owner: string, name: string, desc: string | undefined, value: string): void {
  if (desc) t.fields.set(`${owner}.${name}:${desc}`, value);
  const plain = `${owner}.${name}`;
  // obfuscated field names repeat with different types; a bare key is only usable when unique
  if (t.fields.has(plain) && t.fields.get(plain) !== value) t.fields.set(plain, '');
  else t.fields.set(plain, value);
}

/** Fabric tiny v1 or v2 mappings, "official" → "intermediary". */
export function parseTiny(text: string): TargetNames {
  const t = emptyTarget();
  const lines = text.split(/\r?\n/);
  const header = lines[0]?.split('\t') ?? [];
  if (header[0] === 'v1') {
    const from = header.indexOf('official') - 1;
    const to = header.indexOf('intermediary') - 1;
    if (from < 0 || to < 0) throw new Error('tiny v1 mappings without official/intermediary namespaces');
    for (const line of lines.slice(1)) {
      const p = line.split('\t');
      if (p[0] === 'CLASS') t.classes.set(p[1 + from], p[1 + to]);
      else if (p[0] === 'FIELD') addField(t, p[1], p[3 + from], p[2], p[3 + to]);
      else if (p[0] === 'METHOD') t.methods.set(`${p[1]}.${p[3 + from]}${p[2]}`, p[3 + to]);
    }
    return t;
  }
  if (header[0] === 'tiny' && header[1] === '2') {
    const ns = header.slice(3);
    const from = ns.indexOf('official');
    const to = ns.indexOf('intermediary');
    if (from < 0 || to < 0) throw new Error('tiny v2 mappings without official/intermediary namespaces');
    let owner = '';
    for (const line of lines.slice(1)) {
      if (line.startsWith('c\t')) {
        const p = line.split('\t').slice(1);
        owner = p[from];
        t.classes.set(owner, p[to]);
      } else if (line.startsWith('\tf\t') || line.startsWith('\tm\t')) {
        const p = line.split('\t').slice(2);
        const desc = p[0]; // descriptors use the first namespace
        const names = p.slice(1);
        if (from !== 0) continue; // descriptors would need remapping; Fabric's files always start with official
        if (line[1] === 'f') addField(t, owner, names[from], desc, names[to]);
        else t.methods.set(`${owner}.${names[from]}${desc}`, names[to]);
      }
    }
    return t;
  }
  throw new Error(`Unknown tiny mappings header: ${lines[0]}`);
}

/** MCPConfig/NeoForm tsrg (v1) or tsrg2 mappings, obfuscated → SRG. */
export function parseTsrg(text: string): TargetNames {
  const t = emptyTarget();
  let owner = '';
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('tsrg2 ') || line.startsWith('\t\t')) continue;
    const p = line.trim().split(' ');
    if (line[0] !== '\t') {
      owner = p[0];
      t.classes.set(owner, p[1]);
    } else if (p[1]?.startsWith('(')) {
      t.methods.set(`${owner}.${p[0]}${p[1]}`, p[2]);
    } else if (p.length >= 2) {
      addField(t, owner, p[0], undefined, p[1]);
    }
  }
  return t;
}

// ---------------------------------------------------------------- composition

const PRIMITIVES: Record<string, string> = { boolean: 'Z', byte: 'B', char: 'C', short: 'S', int: 'I', long: 'J', float: 'F', double: 'D', void: 'V' };

interface MojangClass {
  named: string;
  obf: string;
  members: { text: string; name: string; type: string; params?: string[]; obf: string }[];
}

export function parseMojang(text: string): MojangClass[] {
  const classes: MojangClass[] = [];
  let current: MojangClass | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line[0] === '#') continue;
    if (line[0] !== ' ') {
      const m = /^(\S+) -> (\S+):$/.exec(line);
      current = m ? { named: m[1], obf: m[2], members: [] } : undefined;
      if (current) classes.push(current);
      continue;
    }
    const m = /^\s+(?:\d+:\d+:)?(\S+) ([^\s(]+)(?:\((.*)\))?(?::\d+:\d+)? -> (\S+)$/.exec(line);
    if (!current || !m) continue;
    const [, type, name, params, obf] = m;
    current.members.push({
      text: params === undefined ? `${type} ${name}` : `${type} ${name}(${params})`,
      name,
      type,
      params: params === undefined ? undefined : params ? params.split(',') : [],
      obf,
    });
  }
  return classes;
}

/**
 * Composes Mojang's mappings (named → obfuscated) with {@code target} (obfuscated → runtime) into a ProGuard style
 * file named → runtime, which the probe reads like Mojang's own. Members the target does not rename keep their
 * name when it is not obfuscated; other unmapped members are left out.
 */
export function compose(mojang: MojangClass[], target: TargetNames, classRuntime: (cls: MojangClass) => string | undefined): string {
  const obfOf = new Map(mojang.map((c) => [c.named, c.obf]));
  const desc = (type: string): string => {
    let dims = 0;
    while (type.endsWith('[]')) {
      dims++;
      type = type.slice(0, -2);
    }
    const base = PRIMITIVES[type] ?? `L${(obfOf.get(type) ?? type).replace(/\./g, '/')};`;
    return '['.repeat(dims) + base;
  };
  const out: string[] = [];
  for (const cls of mojang) {
    const runtime = classRuntime(cls);
    if (!runtime) continue;
    out.push(`${cls.named} -> ${runtime}:`);
    const owner = cls.obf.replace(/\./g, '/');
    for (const m of cls.members) {
      if (m.name === '<init>' || m.name === '<clinit>') continue;
      let mapped: string | undefined;
      if (m.params === undefined) {
        mapped = target.fields.get(`${owner}.${m.obf}:${desc(m.type)}`) || target.fields.get(`${owner}.${m.obf}`) || undefined;
      } else {
        mapped = target.methods.get(`${owner}.${m.obf}(${m.params.map(desc).join('')})${desc(m.type)}`);
      }
      if (!mapped && m.obf === m.name) mapped = m.name;
      if (mapped) out.push(`    ${m.text} -> ${mapped}`);
    }
  }
  return `${out.join('\n')}\n`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function writeComposed(file: string, build: () => Promise<string>): Promise<string> {
  if (await exists(file)) return file;
  const text = await build();
  await mkdir(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file).catch(async (err) => {
    await rm(tmp, { force: true });
    if (!(await exists(file))) throw err;
  });
  return file;
}

function mavenPath(group: string, artifact: string, version: string, ext = 'jar'): string {
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.${ext}`;
}

/** A library from the shared libraries directory, downloaded from {@code repo} when HeadlessMC did not fetch it. */
async function library(paths: CalcitePaths, repo: string, relative: string): Promise<string> {
  const file = join(paths.minecraft, 'libraries', ...relative.split('/'));
  if (!(await exists(file))) await download(`${repo}/${relative}`, file);
  return file;
}

async function composeFabric(paths: CalcitePaths, mc: string, mojangFile: string, loader: InstalledLoader): Promise<string> {
  const lib = loader.json.libraries?.find((l) => l.name.startsWith('net.fabricmc:intermediary:'));
  const version = lib?.name.split(':')[2] ?? mc;
  const file = join(paths.mappings, `${mc}-intermediary-${version}-c${COMPOSE_FORMAT}.txt`);
  return writeComposed(file, async () => {
    const jar = await library(paths, 'https://maven.fabricmc.net', mavenPath('net.fabricmc', 'intermediary', version));
    const tiny = await readZipEntry(jar, 'mappings/mappings.tiny');
    if (!tiny) throw new Error(`${jar} contains no mappings/mappings.tiny`);
    const target = parseTiny(tiny.toString('utf8'));
    return compose(parseMojang(await readFile(mojangFile, 'utf8')), target, (c) => target.classes.get(c.obf.replace(/\./g, '/'))?.replace(/\//g, '.') ?? (c.obf === c.named ? c.named : undefined));
  });
}

/** Mojang class names with SRG member names (Forge 1.17-1.20.5, NeoForge 1.20.1-1.20.4); null when unknown. */
async function composeSrg(paths: CalcitePaths, mc: string, mojangFile: string, loader: InstalledLoader): Promise<string | null> {
  const mcp = loaderGameArg(loader.json, '--fml.mcpVersion');
  const neoForm = loaderGameArg(loader.json, '--fml.neoFormVersion');
  const source = neoForm
    ? { repo: 'https://maven.neoforged.net/releases', path: mavenPath('net.neoforged', 'neoform', `${mc}-${neoForm}`, 'zip'), tag: `neoform-${neoForm}` }
    : mcp
      ? { repo: 'https://maven.minecraftforge.net', path: mavenPath('de.oceanlabs.mcp', 'mcp_config', `${mc}-${mcp}`, 'zip'), tag: `mcp-${mcp}` }
      : null;
  if (!source) return null;
  const file = join(paths.mappings, `${mc}-srg-${source.tag}-c${COMPOSE_FORMAT}.txt`);
  return writeComposed(file, async () => {
    const zip = await library(paths, source.repo, source.path);
    let entry = 'config/joined.tsrg';
    const config = await readZipEntry(zip, 'config.json');
    if (config) entry = (JSON.parse(config.toString('utf8')) as { data?: { mappings?: string } }).data?.mappings ?? entry;
    const tsrg = await readZipEntry(zip, entry);
    if (!tsrg) throw new Error(`${zip} contains no ${entry}`);
    return compose(parseMojang(await readFile(mojangFile, 'utf8')), parseTsrg(tsrg.toString('utf8')), (c) => c.named);
  });
}
