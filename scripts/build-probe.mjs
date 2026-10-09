// Builds vendor/calcite-probe.jar (Java 8 bytecode) from probe/src/main/java.
// Requires a JDK 9+ (javac --release 8). Uses JAVA_HOME when set, otherwise javac/jar from PATH.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'probe', 'src', 'main', 'java');
const out = join(root, 'probe', 'build', 'classes');
const jarFile = join(root, 'vendor', 'calcite-probe.jar');

/** javac options shared by the probe and its tests: Java 8 bytecode, every lint as an error. */
export const JAVAC_OPTIONS = ['--release', '8', '-encoding', 'UTF-8', '-Xlint:all,-options', '-Werror'];

export function jdkTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  if (process.env.JAVA_HOME) {
    const candidate = join(process.env.JAVA_HOME, 'bin', exe);
    if (existsSync(candidate)) return candidate;
  }
  return exe;
}

export function listJava(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) files.push(...listJava(p));
    else if (p.endsWith('.java')) files.push(p);
  }
  return files;
}

function main() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  mkdirSync(dirname(jarFile), { recursive: true });
  execFileSync(jdkTool('javac'), [...JAVAC_OPTIONS, '-d', out, ...listJava(src)], {
    stdio: 'inherit',
  });
  const manifest = join(root, 'probe', 'build', 'MANIFEST.MF');
  writeFileSync(
    manifest,
    [
      'Manifest-Version: 1.0',
      'Premain-Class: calcite.probe.Probe',
      'Agent-Class: calcite.probe.Probe',
      'Implementation-Title: calcite-probe',
      '',
    ].join('\n'),
  );
  rmSync(jarFile, { force: true });
  execFileSync(jdkTool('jar'), ['cfm', jarFile, manifest, '-C', out, '.'], { stdio: 'inherit' });
  console.log(`built ${jarFile}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
