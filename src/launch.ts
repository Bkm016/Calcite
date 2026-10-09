import { Socket } from 'node:net';
import { hmcQuote, hmcVersionArgs } from './hmc.js';
import type { RenderMode, ServerAddress } from './types.js';

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
