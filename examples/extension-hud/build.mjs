// Builds calcite-hud.jar against the probe API (vendor/calcite-probe.jar; run `npm run build:probe` first).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jdkTool, listJava } from '../../scripts/build-probe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'build');
const api = join(here, '..', '..', 'vendor', 'calcite-probe.jar');
const jar = join(here, 'calcite-hud.jar');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'META-INF', 'services'), { recursive: true });
execFileSync(jdkTool('javac'), ['--release', '8', '-Xlint:-options', '-encoding', 'UTF-8', '-cp', api, '-d', out, ...listJava(join(here, 'src'))], { stdio: 'inherit' });
// tells the probe which class implements the extension
writeFileSync(join(out, 'META-INF', 'services', 'calcite.probe.api.CalciteExtension'), 'calcite.example.hud.HudExtension\n');
rmSync(jar, { force: true });
execFileSync(jdkTool('jar'), ['cf', jar, '-C', out, '.'], { stdio: 'inherit' });
console.log(`built ${jar}`);
