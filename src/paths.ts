import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

/** Directory layout under CALCITE_HOME (default ~/.calcite). */
export interface CalcitePaths {
  /** Root of all Calcite data. */
  home: string;
  /** HeadlessMC files location of `calcite login`: Microsoft sessions (.auth/default/.accounts.json). */
  hmcHome: string;
  /** HeadlessMC jars. */
  hmcJars: string;
  /** Shared Minecraft directory: versions, libraries, assets. */
  minecraft: string;
  /** Java runtimes downloaded by Calcite. */
  java: string;
  /** Mojang client mappings. */
  mappings: string;
  /** Cached Mojang metadata. */
  meta: string;
  /** Per-client game directories. */
  instances: string;
  /** Directory for the probe jar and its config files; guaranteed free of spaces and commas. */
  probe: string;
}

const UNSAFE_FOR_JVM_ARGS = /[\s,=;"']/;

/**
 * Picks a directory whose path can be passed through HeadlessMC's space-separated hmc.jvmargs and the
 * -javaagent option (no spaces, commas, equals signs or quotes).
 */
export function safeProbeDir(home: string): string {
  const candidates: string[] = [join(home, 'probe')];
  if (process.platform === 'win32') {
    candidates.push(join(process.env.PUBLIC || 'C:\\Users\\Public', 'calcite', 'probe'));
    candidates.push(join(process.env.SystemDrive || 'C:', 'calcite-probe'));
  } else {
    let user = 'user';
    try {
      user = String(userInfo().uid);
    } catch {
      // keep default
    }
    candidates.push(join(tmpdir(), `calcite-${user}`, 'probe'));
    candidates.push(join('/tmp', `calcite-${user}`, 'probe'));
  }
  const found = candidates.find((dir) => !UNSAFE_FOR_JVM_ARGS.test(dir));
  if (!found) {
    throw new Error(`Cannot find a directory without spaces for the probe; set CALCITE_PROBE_DIR. Tried: ${candidates.join(', ')}`);
  }
  return found;
}

export function resolvePaths(home = process.env.CALCITE_HOME || join(homedir(), '.calcite')): CalcitePaths {
  const probe = process.env.CALCITE_PROBE_DIR || safeProbeDir(home);
  if (UNSAFE_FOR_JVM_ARGS.test(probe)) {
    throw new Error(`CALCITE_PROBE_DIR must not contain spaces, commas, '=' or quotes: ${probe}`);
  }
  return {
    home,
    hmcHome: join(home, 'hmc-home'),
    hmcJars: join(home, 'hmc'),
    minecraft: join(home, 'minecraft'),
    java: join(home, 'java'),
    mappings: join(home, 'mappings'),
    meta: join(home, 'meta'),
    instances: join(home, 'instances'),
    probe,
  };
}
