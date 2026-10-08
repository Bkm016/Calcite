// Compiles and runs the dependency-free probe tests (probe/src/test/java) against the probe sources.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jdkTool, listJava } from './build-probe.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'probe', 'build', 'test-classes');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sources = [...listJava(join(root, 'probe', 'src', 'main', 'java')), ...listJava(join(root, 'probe', 'src', 'test', 'java'))];
execFileSync(jdkTool('javac'), ['--release', '8', '-Xlint:-options', '-encoding', 'UTF-8', '-d', out, ...sources], { stdio: 'inherit' });
execFileSync(jdkTool('java'), ['-cp', [out].join(delimiter), 'calcite.probe.ProbeTests'], { stdio: 'inherit' });
