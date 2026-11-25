// Compiles the probe tests (probe/src/test/java) against the probe sources and runs them with JUnit 5.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download } from '../dist/net.js';
import { JAVAC_OPTIONS, jdkTool, listJava } from './build-probe.mjs';

const JUNIT_VERSION = '1.14.4';
const JUNIT_SHA1 = '02deb74daae8c2187cfc9fe85392f8421eb004c6';
const JUNIT_PATH = `org/junit/platform/junit-platform-console-standalone/${JUNIT_VERSION}/junit-platform-console-standalone-${JUNIT_VERSION}.jar`;
const JUNIT_URLS = [
  `https://repo1.maven.org/maven2/${JUNIT_PATH}`,
  `https://maven-central.storage-download.googleapis.com/maven2/${JUNIT_PATH}`,
];

async function downloadJunit(dest) {
  let lastErr;
  for (const url of JUNIT_URLS) {
    try {
      return await download(url, dest, { sha1: JUNIT_SHA1 });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'probe', 'build');
const out = join(build, 'test-classes');
const junit = await downloadJunit(join(build, 'junit', `junit-platform-console-standalone-${JUNIT_VERSION}.jar`));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sources = [...listJava(join(root, 'probe', 'src', 'main', 'java')), ...listJava(join(root, 'probe', 'src', 'test', 'java'))];
execFileSync(jdkTool('javac'), [...JAVAC_OPTIONS, '-cp', junit, '-d', out, ...sources], { stdio: 'inherit' });
execFileSync(
  jdkTool('java'),
  [
    '-jar',
    junit,
    'execute',
    '--disable-banner',
    '--details=tree',
    '--fail-if-no-tests',
    '--class-path',
    [out].join(delimiter),
    '--scan-class-path',
  ],
  { stdio: 'inherit' },
);
