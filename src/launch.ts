import { Socket } from 'node:net';
import { hmcJavaHome, hmcListEntry, hmcQuote, hmcVersionArgs, UTF8_CONSOLE_PROPS } from './hmc.js';
import { javaProxyProps } from './net.js';
import { CalciteError, type ClientOptions, type RenderMode, type ServerAddress } from './types.js';

/** Escapes a value for a java.util.Properties file. */
export function propValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/[:=]/g, (c) => `\\${c}`);
}

export interface ProbeSettings {
  port: number;
  token: string;
  /** Name tables the probe tries in order (a mapping file or "official"). */
  mappings: string[];
  version: string;
  extensions: string[];
  headless: boolean;
  render: RenderMode;
}

/** The probe's settings file: the agent argument only names it, since its paths may contain spaces. */
export function probeConfig(s: ProbeSettings): string {
  return [
    `port=${s.port}`,
    `token=${s.token}`,
    ...s.mappings.map((m, i) => `mappings.${i + 1}=${propValue(m)}`),
    `version=${propValue(s.version)}`,
    ...s.extensions.map((jar, i) => `extensions.${i + 1}=${propValue(jar)}`),
    `headless=${s.headless}`,
    `render=${s.render === 'always' ? 'on' : 'off'}`,
    'exitOnDisconnect=true',
    '',
  ].join('\n');
}

export interface GameLaunch {
  versionId: string;
  loader?: { kind: string; build?: string };
  offline: boolean;
  headless: boolean;
  jvmArgs: string[];
  gameArgs: string[];
}

/** HeadlessMC's command line for launching the game. */
export function hmcLaunchCommand(l: GameLaunch): string[] {
  return [
    'launch',
    ...hmcVersionArgs(l.versionId, l.loader),
    ...(l.offline ? ['--offline'] : []),
    ...(l.headless ? ['--headless'] : []),
    `--jvm=${l.jvmArgs.map(hmcQuote).join(' ')}`,
    ...(l.gameArgs.length ? [`--game=${l.gameArgs.map(hmcQuote).join(' ')}`] : []),
  ];
}

export interface JvmSettings {
  /** The probe's -javaagent value ("jar=config"); absent when the version is unsupported. */
  agent?: string;
  headless: boolean;
  memory?: string;
  extra?: string[];
}

/** JVM arguments for the game: the probe agent, heap size, UTF-8 console, proxy settings and the caller's own arguments. */
export function gameJvmArgs(s: JvmSettings): string[] {
  return [
    // HeadlessMC's stubbed LWJGL buffers have no native address; JOML's Unsafe path writes to it and crashes the JVM
    ...(s.headless ? ['-Djoml.nounsafe=true'] : []),
    ...(s.agent ? [`-javaagent:${s.agent}`] : []),
    `-Xmx${s.memory ?? '2G'}`,
    ...Object.entries({ ...UTF8_CONSOLE_PROPS, ...javaProxyProps() }).map(([k, v]) => `-D${k}=${v}`),
    ...(s.extra ?? []),
  ];
}

export interface HmcSettings {
  minecraftDir: string;
  gameDir: string;
  javaPath: string;
  virtualDisplay: boolean;
  assetsVerified: boolean;
}

/** HeadlessMC system properties for one client. */
export function hmcProperties(s: HmcSettings): Record<string, string> {
  return {
    'hmc.files.mc': s.minecraftDir,
    'hmc.files.game': s.gameDir,
    'hmc.java.versions': hmcListEntry(hmcJavaHome(s.javaPath)),
    'hmc.java.download': 'false',
    // HeadlessMC only lets offline accounts render when it sees Xvfb running
    'hmc.xvfb.check': String(s.virtualDisplay),
    // "dummy" assets skip the hashing of existing asset files; a missing one would become a placeholder, so this is
    // only set once a launch got through the full download and verification
    'hmc.assets.dummy': String(s.assetsVerified),
  };
}

/** Game arguments that join {@code server} right after startup (Quick Play from 1.20, --server before). */
export function joinArgs(server: ServerAddress, quickPlay: boolean): string[] {
  return quickPlay ? ['--quickPlayMultiplayer', `${server.host}:${server.port}`] : ['--server', server.host, '--port', String(server.port)];
}

export async function tcpReachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host, () => done(true));
  });
}

/** What to do when no graphics backend could be created. */
export function noBackendHint(platform: NodeJS.Platform): string {
  return platform === 'linux'
    ? 'On Linux without a GPU install Mesa EGL (apt install libegl1 libegl-mesa0) or Vulkan (apt install mesa-vulkan-drivers), or use render "off".'
    : 'Update the graphics drivers, or use render "off".';
}

export interface ServerWait {
  timeoutMs: number;
  /** Ends the wait early (with a "stopped" error) when it returns true. */
  stopped: () => boolean;
  /** Progress, about every {@code reportMs}. */
  onWaiting: (message: string) => void;
  retryMs?: number;
  reportMs?: number;
}

/** Resolves once {@code server} accepts TCP connections; fails after {@code timeoutMs}. */
export async function waitForServer(server: ServerAddress, w: ServerWait): Promise<void> {
  const { retryMs = 2000, reportMs = 10_000 } = w;
  const since = Date.now();
  let reported = since;
  while (!(await tcpReachable(server.host, server.port))) {
    if (w.stopped()) throw new CalciteError('stopped', 'Stopped while waiting for the server');
    const waited = Date.now() - since;
    if (waited > w.timeoutMs) {
      throw new CalciteError(
        'server_unreachable',
        `Server ${server.host}:${server.port} is not reachable (waited ${Math.round(waited / 1000)}s)`,
      );
    }
    if (Date.now() - reported >= reportMs) {
      reported = Date.now();
      w.onWaiting(`still waiting for ${server.host}:${server.port} (${Math.round(waited / 1000)}s of ${Math.round(w.timeoutMs / 1000)}s)`);
    }
    await new Promise((r) => setTimeout(r, retryMs));
  }
}

/** How many reconnects the {@code reconnect} option allows in a row. */
export function reconnectLimit(option: ClientOptions['reconnect']): number {
  if (option === false) return 0;
  if (typeof option === 'object') return option.maxAttempts ?? 10;
  return 10;
}

/** Delay before reconnect attempt {@code attempt} (from 1): 5 s, doubling, at most a minute. */
export function reconnectDelay(attempt: number): number {
  return Math.min(5000 * 2 ** (attempt - 1), 60_000);
}

/**
 * Minecraft 26.x opens a modal error box and blocks forever when no graphics backend can be created. Watches the
 * game output and reports the backend errors when none came up within {@code graceMs} of the last failure.
 */
export class BackendWatch {
  private readonly errors: string[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly onStuck: (errors: string[]) => void,
    private readonly graceMs = 20_000,
  ) {}

  line(line: string): void {
    const failure = /BackendCreationException: (.*)/.exec(line);
    if (failure) {
      this.errors.push(failure[1].trim());
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.onStuck(this.errors);
      }, this.graceMs);
    } else if (line.includes('Using graphics backend')) {
      clearTimeout(this.timer);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
