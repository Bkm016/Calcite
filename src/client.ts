import { randomBytes, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountsLock, listAccounts } from './accounts.js';
import { acquireDisplay, which, type DisplayLease } from './display.js';
import { ensureHmc, ensureHmcHome, killTree, runHmc, type HmcRun } from './hmc.js';
import { ensureJava, type JavaInstall } from './java.js';
import { acquireLock, withLock } from './lock.js';
import { logger } from './log.js';
import { ensureClientJar, getVersionJson, requiredJavaMajor, resolveNames, resolveVersion, supportsQuickPlay, type NameMode, type VersionJson } from './mojang.js';
import { defaultOptions, writeOptions } from './options.js';
import { resolvePaths, type CalcitePaths } from './paths.js';
import { ProbeError, ProbeServer } from './probe-server.js';

export type RenderMode = 'off' | 'on-demand' | 'always';

export type Account = { type: 'offline'; username: string } | { type: 'microsoft'; name?: string };

export type Phase = 'idle' | 'preparing' | 'waiting_for_server' | 'starting' | 'connecting' | 'in_game' | 'disconnected' | 'reconnecting' | 'stopping' | 'stopped' | 'crashed';

export interface ServerAddress {
  host: string;
  port: number;
}

export interface ClientOptions {
  /** Instance name; also the game directory name. Letters, digits, '-', '_' and '.' only. */
  name: string;
  /** Minecraft version id, "latest" or "snapshot". */
  version: string;
  /** Server to join ("host[:port]"). Without a server the client stays on the title screen. */
  server?: string | ServerAddress;
  /** Account: offline (any username, for online-mode=false servers) or a stored Microsoft account. */
  account?: Account;
  /**
   * World rendering: 'off' (no renderer, cheapest, no screenshots), 'on-demand' (renders only for screenshots,
   * default), 'always'. Rendering needs a display (Linux: DISPLAY or Xvfb) and, with an offline account, Linux.
   */
  render?: RenderMode;
  /** Explicit java executable for the game. */
  javaPath?: string;
  /** Download a Temurin runtime when the required Java is missing (default true). */
  allowJavaDownload?: boolean;
  /** Max heap, e.g. "2G" (default "2G"). */
  memory?: string;
  /** Extra JVM / game arguments (must not contain spaces). */
  jvmArgs?: string[];
  gameArgs?: string[];
  renderDistance?: number;
  maxFps?: number;
  /** Reconnect (relaunch) after a disconnect or crash. Default: enabled, 10 attempts. */
  reconnect?: boolean | { maxAttempts?: number };
  /** How long to wait for the server port before launching (default 120 s). */
  waitForServerMs?: number;
  /** Overall start timeout including downloads (default 15 min). */
  startTimeoutMs?: number;
  paths?: CalcitePaths;
}

export interface LogLine {
  seq: number;
  time: number;
  source: 'game' | 'calcite';
  line: string;
}

export interface ChatLine {
  seq: number;
  time: number;
  message: string;
}

export interface PlayerState {
  id?: number;
  uuid?: string;
  name?: string;
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
  health?: number;
  dimension?: string;
}

export interface GameState {
  ready: boolean;
  headless: boolean;
  inGame: boolean;
  screen?: string | null;
  /** A resource (re)load overlay is showing. */
  loading?: boolean;
  disconnectReason?: string | null;
  fps?: number;
  noRender?: boolean;
  player?: PlayerState;
}

export interface EntityInfo {
  id: number;
  uuid: string;
  type: string;
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
  name?: string;
  customName?: string;
  vehicleId?: number | null;
  invisible?: boolean;
  removed?: boolean;
}

export interface EntityQuery {
  /** Only entities within this distance of the player (blocks). */
  radius?: number;
  /** Entity type id, e.g. "minecraft:villager" (the "minecraft:" prefix is optional). */
  type?: string;
  uuid?: string;
  /** Substring match on name or custom name (case-insensitive). */
  name?: string;
  limit?: number;
  includeSelf?: boolean;
}

export interface ClientStatus {
  name: string;
  version: string;
  phase: Phase;
  render: RenderMode;
  headless: boolean;
  account: Account;
  server?: ServerAddress;
  gameDir: string;
  pid?: number;
  java?: string;
  startedAt?: number;
  reconnects: number;
  lastError?: string;
  probeConnected: boolean;
  game?: GameState;
}

export class CalciteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CalciteError';
  }
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_LOG = 5000;
const MAX_CHAT = 1000;

export function parseServer(server: string | ServerAddress): ServerAddress {
  if (typeof server !== 'string') return { host: server.host, port: server.port || 25565 };
  const s = server.trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : 25565 };
  const idx = s.lastIndexOf(':');
  if (idx > 0 && s.indexOf(':') === idx) return { host: s.slice(0, idx), port: Number(s.slice(idx + 1)) };
  return { host: s, port: 25565 };
}

function probeJarSource(): string {
  return process.env.CALCITE_PROBE_JAR || fileURLToPath(new URL('../vendor/calcite-probe.jar', import.meta.url));
}

/** Copies the probe jar to the space-free probe directory (content-addressed). */
async function installProbe(paths: CalcitePaths): Promise<string> {
  const source = await readFile(probeJarSource());
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const target = join(paths.probe, `calcite-probe-${hash}.jar`);
  try {
    await stat(target);
  } catch {
    await mkdir(paths.probe, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, source);
    await copyFile(tmp, target);
    await rm(tmp, { force: true });
  }
  return target;
}

async function tcpReachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
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

/** Screens shown while joining or changing dimension; the player is not playable yet. */
const LOADING_SCREEN = /LevelLoading|ReceivingLevel|ProgressScreen|ConnectScreen|GenericMessage|DownloadingTerrain/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Offline username derived from a client name (3-16 chars of [A-Za-z0-9_]). */
export function defaultUsername(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16).padEnd(3, '_');
}

export interface InstallOptions {
  paths?: CalcitePaths;
  javaPath?: string;
  allowJavaDownload?: boolean;
  onLine?: (line: string) => void;
}

/**
 * Downloads everything a version needs (client, libraries, natives, assets, mappings, Java, HeadlessMC) without
 * starting the game, so later launches start fast and work offline.
 */
export async function installVersion(spec: string, opts: InstallOptions = {}): Promise<{ id: string; java: string; probe: string }> {
  const paths = opts.paths ?? resolvePaths();
  const version = await resolveVersion(paths, spec);
  const json = await getVersionJson(paths, version);
  const clientJar = await ensureClientJar(paths, json);
  const names = await resolveNames(paths, json, clientJar);
  const java = await ensureJava(paths, requiredJavaMajor(json), { javaPath: opts.javaPath, allowDownload: opts.allowJavaDownload });
  const hmcJar = await ensureHmc(paths);
  await ensureHmcHome(paths);
  await installProbe(paths);
  const run = runHmc({
    javaPath: java.path,
    hmcJar,
    paths,
    props: { 'hmc.mcdir': paths.minecraft, 'hmc.java.versions': java.path, 'hmc.offline': 'true' },
    command: ['launch', json.id, '-prepare', '-lwjgl'],
    onLine: opts.onLine,
  });
  const code = await run.exited;
  if (code !== 0) throw new CalciteError('install_failed', `HeadlessMC exited with code ${code} while downloading ${json.id}`);
  return { id: json.id, java: java.version, probe: names.kind === 'unsupported' ? names.reason : 'supported' };
}

/**
 * One Minecraft client controlled by Calcite.
 *
 * Events: 'phase' (Phase), 'log' (LogLine), 'chat' (ChatLine), 'state' (GameState), 'exit' (code).
 */
export class Client extends EventEmitter {
  readonly options: Required<Pick<ClientOptions, 'name' | 'version'>> & ClientOptions;
  readonly paths: CalcitePaths;
  readonly gameDir: string;
  readonly render: RenderMode;
  readonly account: Account;
  readonly server?: ServerAddress;

  private phaseValue: Phase = 'idle';
  private logs: LogLine[] = [];
  private chats: ChatLine[] = [];
  private seq = 0;
  private probe: ProbeServer | null = null;
  private run: HmcRun | null = null;
  private display: DisplayLease | null = null;
  private releaseInstance: (() => Promise<void>) | null = null;
  private probeConfig: string | null = null;
  private java: JavaInstall | null = null;
  private versionJson: VersionJson | null = null;
  private names: NameMode | null = null;
  private headlessValue = false;
  private lastState: GameState | undefined;
  private lastError: string | undefined;
  /** Error code of a failure that relaunching cannot fix (reported by start() instead of "crashed"). */
  private fatalCode: string | undefined;
  private startedAt: number | undefined;
  private reconnects = 0;
  private stopping = false;
  private poller: NodeJS.Timeout | null = null;
  private inGameSince = 0;
  private relaunching = false;
  private everInGame = false;
  private joinRequested = false;
  private readonly log;

  constructor(options: ClientOptions) {
    super();
    if (!NAME_RE.test(options.name)) {
      throw new CalciteError('bad_name', `Invalid client name "${options.name}" (allowed: letters, digits, - _ .)`);
    }
    this.options = options;
    this.paths = options.paths ?? resolvePaths();
    this.gameDir = join(this.paths.instances, options.name);
    this.render = options.render ?? 'on-demand';
    this.account = options.account ?? { type: 'offline', username: defaultUsername(options.name) };
    if (this.account.type === 'offline' && !/^[A-Za-z0-9_]{3,16}$/.test(this.account.username)) {
      throw new CalciteError('bad_username', `Offline username must be 3-16 letters, digits or underscores: "${this.account.username}"`);
    }
    this.server = options.server ? parseServer(options.server) : undefined;
    this.log = logger(`client:${options.name}`);
    this.on('error', () => undefined); // never crash the host process on an unhandled 'error' event
  }

  get phase(): Phase {
    return this.phaseValue;
  }

  get headless(): boolean {
    return this.headlessValue;
  }

  private setPhase(phase: Phase): void {
    if (phase === this.phaseValue) return;
    this.phaseValue = phase;
    this.note(`phase → ${phase}`);
    this.emit('phase', phase);
  }

  private note(line: string): void {
    this.pushLog('calcite', line);
    this.log.debug(line);
  }

  private pushLog(source: LogLine['source'], line: string): void {
    const entry: LogLine = { seq: ++this.seq, time: Date.now(), source, line };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG);
    this.emit('log', entry);
    if (source === 'game') {
      const chat = /\[CHAT\] (.*)$/.exec(line);
      if (chat) {
        const c: ChatLine = { seq: entry.seq, time: entry.time, message: chat[1] };
        this.chats.push(c);
        if (this.chats.length > MAX_CHAT) this.chats.splice(0, this.chats.length - MAX_CHAT);
        this.emit('chat', c);
      }
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Prepares everything (Java, game files, mappings), launches the client and resolves once it is in a world
   * (or on the title screen when no server is configured).
   */
  async start(): Promise<ClientStatus> {
    if (!['idle', 'stopped', 'crashed'].includes(this.phaseValue)) {
      throw new CalciteError('already_running', `Client "${this.options.name}" is already ${this.phaseValue}`);
    }
    this.stopping = false;
    this.everInGame = false;
    this.reconnects = 0;
    this.lastError = undefined;
    this.fatalCode = undefined;
    const timeout = this.options.startTimeoutMs ?? 15 * 60_000;
    try {
      this.releaseInstance = await acquireLock(join(this.gameDir, '.calcite.lock'), { timeoutMs: 0 });
    } catch {
      throw new CalciteError('instance_busy', `Client "${this.options.name}" is already running in another process`);
    }
    try {
      await this.prepare();
      await this.launch();
      await this.waitUntilStarted(timeout);
      return this.status();
    } catch (err) {
      this.lastError = (err as Error).message;
      await this.shutdown('crashed');
      throw err;
    }
  }

  /** Downloads and verifies everything needed to launch (idempotent). */
  async prepare(): Promise<void> {
    this.setPhase('preparing');
    const version = await resolveVersion(this.paths, this.options.version);
    this.versionJson = await getVersionJson(this.paths, version);
    const clientJar = await ensureClientJar(this.paths, this.versionJson);
    this.names = await resolveNames(this.paths, this.versionJson, clientJar);
    if (this.names.kind === 'unsupported') this.note(`probe disabled: ${this.names.reason}`);
    this.java = await ensureJava(this.paths, requiredJavaMajor(this.versionJson), {
      javaPath: this.options.javaPath,
      allowDownload: this.options.allowJavaDownload,
    });
    this.note(`java ${this.java.version} (${this.java.path}) for Minecraft ${this.versionJson.id}`);
  }

  private resolveHeadless(): boolean {
    if (this.render === 'off') return true;
    if (this.account.type === 'offline' && process.platform !== 'linux') {
      this.note('offline accounts can only render on Linux (HeadlessMC policy); running headless — use a Microsoft account for screenshots');
      return true;
    }
    return false;
  }

  private async launch(): Promise<void> {
    const json = this.versionJson!;
    const java = this.java!;
    const hmcJar = await ensureHmc(this.paths);
    await ensureHmcHome(this.paths);
    const probeJar = await installProbe(this.paths);
    this.headlessValue = this.resolveHeadless();

    if (this.server) {
      this.setPhase('waiting_for_server');
      const deadline = Date.now() + (this.options.waitForServerMs ?? 120_000);
      while (!(await tcpReachable(this.server.host, this.server.port))) {
        if (this.stopping) throw new CalciteError('stopped', 'Stopped while waiting for the server');
        if (Date.now() > deadline) throw new CalciteError('server_unreachable', `Server ${this.server.host}:${this.server.port} is not reachable`);
        await sleep(2000);
      }
    }

    // probe endpoint + config (paths inside may contain spaces; the config file itself lives in a safe dir)
    this.probe = new ProbeServer();
    await this.probe.listen();
    this.probe.on('connected', () => this.onProbeConnected());
    this.probe.on('disconnected', () => this.note('probe disconnected'));
    this.probeConfig = join(this.paths.probe, `${this.options.name}-${randomBytes(6).toString('hex')}.properties`);
    const cfg = [
      `port=${this.probe.port}`,
      `token=${this.probe.token}`,
      `mappings=${this.names?.kind === 'mappings' ? this.names.file.replace(/\\/g, '\\\\').replace(/:/g, '\\:') : ''}`,
      `headless=${this.headlessValue}`,
      `render=${this.render === 'always' ? 'on' : 'off'}`,
      'exitOnDisconnect=true',
      '',
    ].join('\n');
    await mkdir(this.paths.probe, { recursive: true });
    await writeFile(this.probeConfig, cfg, { mode: 0o600 });

    await writeOptions(this.gameDir, defaultOptions({ renderDistance: this.options.renderDistance, maxFps: this.options.maxFps }));

    let displayEnv: Record<string, string> = {};
    let virtualDisplay = false;
    if (!this.headlessValue) {
      // offline accounts may only render on a virtual display (HeadlessMC); on-demand clients stay invisible when Xvfb exists
      this.display = await acquireDisplay({ forceVirtual: this.account.type === 'offline' || (this.render === 'on-demand' && which('Xvfb') !== null) });
      displayEnv = this.display.env;
      virtualDisplay = this.display.virtual;
    }

    const jvmArgs = [`-Xmx${this.options.memory ?? '2G'}`, ...(this.options.jvmArgs ?? [])];
    if (this.names?.kind !== 'unsupported') jvmArgs.unshift(`-javaagent:${probeJar}=${this.probeConfig}`);
    const gameArgs = [...(this.options.gameArgs ?? [])];
    if (this.server) {
      if (supportsQuickPlay(json)) gameArgs.unshift('--quickPlayMultiplayer', `${this.server.host}:${this.server.port}`);
      else gameArgs.unshift('--server', this.server.host, '--port', String(this.server.port));
    }
    for (const arg of [...jvmArgs, ...gameArgs]) {
      if (/\s/.test(arg)) throw new CalciteError('bad_argument', `JVM/game arguments must not contain spaces: "${arg}"`);
    }
    const offline = this.account.type === 'offline';
    const props: Record<string, string> = {
      'hmc.gamedir': this.gameDir,
      'hmc.mcdir': this.paths.minecraft,
      'hmc.java.versions': java.path,
      'hmc.offline': String(offline),
      'hmc.always.lwjgl.flag': String(this.headlessValue),
      'hmc.check.xvfb': String(virtualDisplay),
      'hmc.jvmargs': jvmArgs.join(' '),
      'hmc.gameargs': gameArgs.join(' '),
      'hmc.exit.on.failed.command': 'true',
    };
    if (this.account.type === 'offline') props['hmc.offline.username'] = this.account.username;

    const command = ['launch', json.id, '-jndi', '-lookup', ...(this.headlessValue ? ['-lwjgl', '-paulscode'] : [])];
    const env = { ...process.env, ...displayEnv };

    this.setPhase('starting');
    this.joinRequested = false;
    this.startedAt = Date.now();
    const spawnGame = async () => {
      let launched!: () => void;
      const launchedPromise = new Promise<void>((r) => (launched = r));
      // 26.x+: when no graphics backend can be created the game opens a modal error box and blocks forever
      const backendErrors: string[] = [];
      let backendTimer: NodeJS.Timeout | undefined;
      const noBackend = () => {
        if (run !== this.run || this.stopping) return;
        const hint =
          process.platform === 'linux'
            ? ' On Linux without a GPU install Mesa EGL (apt install libegl1 libegl-mesa0) or Vulkan (apt install mesa-vulkan-drivers), or use render "off".'
            : ' Update the graphics drivers, or use render "off".';
        this.fatalCode = 'renderer_unavailable';
        this.lastError = `No graphics backend could be created: ${backendErrors.join('; ')}.${hint}`;
        this.note(this.lastError);
        this.setPhase('crashed');
        void killTree(run.child);
      };
      this.run = runHmc({
        javaPath: java.path,
        hmcJar,
        paths: this.paths,
        props,
        command,
        env,
        onLine: (line) => {
          this.pushLog('game', line);
          if (/Launching version|Minecraft exited|LWJGL Version|Backend library/i.test(line)) launched();
          const failure = /BackendCreationException: (.*)/.exec(line);
          if (failure) {
            backendErrors.push(failure[1].trim());
            clearTimeout(backendTimer);
            backendTimer = setTimeout(noBackend, 20_000);
          } else if (/Using graphics backend/.test(line)) clearTimeout(backendTimer);
        },
      });
      const run = this.run;
      void run.exited.then(() => clearTimeout(backendTimer));
      void run.exited.then((code) => this.onGameExit(run, code));
      // give HeadlessMC time to read the primary account before another launch may switch it
      await Promise.race([launchedPromise, run.exited, sleep(60_000)]);
    };

    if (this.account.type === 'microsoft') {
      const wanted = this.account.name;
      await withLock(accountsLock(this.paths), async () => {
        const accounts = await listAccounts(this.paths);
        if (!accounts.length) throw new CalciteError('not_logged_in', 'No Microsoft account is stored; run `calcite login` first');
        const match = wanted ? accounts.find((a) => a.name.toLowerCase() === wanted.toLowerCase()) : accounts[0];
        if (!match) throw new CalciteError('unknown_account', `No stored Microsoft account named "${wanted}" (have: ${accounts.map((a) => a.name).join(', ')})`);
        if (!match.primary) {
          const select = runHmc({ javaPath: java.path, hmcJar, paths: this.paths, props: {}, command: ['account', match.name] });
          await select.exited;
        }
        await spawnGame();
      });
    } else {
      await spawnGame();
    }
  }

  private async onProbeConnected(): Promise<void> {
    this.note('probe connected');
    if (this.phaseValue === 'starting' || this.phaseValue === 'reconnecting') this.setPhase('connecting');
    if (!this.poller) {
      this.poller = setInterval(() => void this.poll(), 1000);
    }
  }

  private async poll(): Promise<void> {
    if (!this.probe?.connected) return;
    let state: GameState;
    try {
      state = await this.probe.request<GameState>('state', {}, 10_000);
    } catch (err) {
      if (err instanceof ProbeError && err.code === 'not_ready') return;
      return;
    }
    const prev = this.lastState;
    this.lastState = state;
    if (JSON.stringify(prev) !== JSON.stringify(state)) this.emit('state', state);
    if (state.inGame && !state.loading && !LOADING_SCREEN.test(state.screen ?? '')) {
      if (this.phaseValue !== 'in_game') {
        this.inGameSince = Date.now();
        this.everInGame = true;
        this.setPhase('in_game');
      } else if (this.reconnects > 0 && Date.now() - this.inGameSince > 60_000) {
        this.reconnects = 0; // stable again
      }
    } else if (
      this.server &&
      !this.joinRequested &&
      this.phaseValue === 'connecting' &&
      state.screen === 'TitleScreen' &&
      !state.loading
    ) {
      // Pre-1.20 versions may ignore --server (e.g. 1.16.4+ when multiplayer privileges cannot be checked)
      this.joinRequested = true;
      this.note(`joining ${this.server.host}:${this.server.port} from the title screen`);
      this.probe.request('connect', { host: this.server.host, port: this.server.port }).catch((err) => this.note(`join failed: ${(err as Error).message}`));
    } else if (state.screen === 'DisconnectedScreen' && this.phaseValue !== 'disconnected' && this.phaseValue !== 'reconnecting') {
      this.lastError = `Disconnected: ${state.disconnectReason ?? 'unknown reason'}`;
      this.setPhase('disconnected');
      void this.maybeReconnect();
    }
  }

  private reconnectLimit(): number {
    const r = this.options.reconnect;
    if (r === false) return 0;
    if (typeof r === 'object') return r.maxAttempts ?? 10;
    return 10;
  }

  private async maybeReconnect(): Promise<void> {
    if (this.stopping || this.relaunching || !this.server) return;
    if (this.reconnects >= this.reconnectLimit()) {
      this.note(`not reconnecting: ${this.reconnects} attempts used`);
      return;
    }
    this.relaunching = true;
    try {
      this.reconnects++;
      const delay = Math.min(5000 * 2 ** (this.reconnects - 1), 60_000);
      this.setPhase('reconnecting');
      this.note(`reconnecting in ${delay}ms (attempt ${this.reconnects})`);
      if (this.run) await killTree(this.run.child);
      await sleep(delay);
      if (this.stopping) return;
      await this.cleanupRun();
      await this.launch();
    } catch (err) {
      this.lastError = (err as Error).message;
      this.setPhase('crashed');
    } finally {
      this.relaunching = false;
    }
  }

  private onGameExit(run: HmcRun, code: number | null): void {
    if (run !== this.run) return; // an older run
    this.emit('exit', code);
    this.note(`game process exited with code ${code}`);
    if (this.stopping || this.relaunching || this.fatalCode) return;
    const tail = this.logs.filter((l) => l.source === 'game').slice(-15).map((l) => l.line).join('\n');
    this.lastError = `Game exited with code ${code}${tail ? `:\n${tail}` : ''}`;
    this.setPhase('crashed');
    // a crash during the very first start is reported to start(); later crashes are retried
    if (this.everInGame) void this.maybeReconnect();
  }

  private async waitUntilStarted(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const phase = this.phaseValue;
      if (phase === 'in_game') return;
      if (!this.server && this.lastState?.ready && this.lastState.loading === false && phase === 'connecting') return;
      if (phase === 'crashed') throw new CalciteError(this.fatalCode ?? 'crashed',this.lastError ?? 'The game crashed during startup');
      if (phase === 'disconnected' && this.reconnectLimit() === 0) throw new CalciteError('disconnected', this.lastError ?? 'Disconnected');
      if (Date.now() > deadline) throw new CalciteError('start_timeout', `Client did not start within ${timeoutMs}ms (phase ${phase})`);
      await sleep(250);
    }
  }

  private async cleanupRun(): Promise<void> {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
    if (this.run) {
      await killTree(this.run.child);
      this.run = null;
    }
    if (this.probe) {
      await this.probe.close();
      this.probe = null;
    }
    if (this.probeConfig) {
      await rm(this.probeConfig, { force: true });
      this.probeConfig = null;
    }
    this.display?.release();
    this.display = null;
    this.lastState = undefined;
  }

  private async shutdown(final: Phase): Promise<void> {
    this.stopping = true;
    await this.cleanupRun();
    if (this.releaseInstance) {
      await this.releaseInstance();
      this.releaseInstance = null;
    }
    this.setPhase(final);
  }

  /** Stops the game and releases all resources. */
  async stop(): Promise<void> {
    if (this.phaseValue === 'stopped' || this.phaseValue === 'idle') return;
    this.setPhase('stopping');
    await this.shutdown('stopped');
  }

  status(): ClientStatus {
    return {
      name: this.options.name,
      version: this.versionJson?.id ?? this.options.version,
      phase: this.phaseValue,
      render: this.render,
      headless: this.headlessValue,
      account: this.account,
      server: this.server,
      gameDir: this.gameDir,
      pid: this.run?.child.pid,
      java: this.java?.version,
      startedAt: this.startedAt,
      reconnects: this.reconnects,
      lastError: this.lastError,
      probeConnected: !!this.probe?.connected,
      game: this.lastState,
    };
  }

  // ------------------------------------------------------------------ operations

  private requireProbe(): ProbeServer {
    if (this.names?.kind === 'unsupported') {
      throw new CalciteError('unsupported_version', this.names.reason);
    }
    if (!this.probe?.connected) throw new CalciteError('not_connected', `Client "${this.options.name}" is not running (phase ${this.phaseValue})`);
    return this.probe;
  }

  async state(): Promise<GameState> {
    const state = await this.requireProbe().request<GameState>('state');
    this.lastState = state;
    return state;
  }

  async entities(query: EntityQuery = {}): Promise<EntityInfo[]> {
    const list = await this.requireProbe().request<EntityInfo[]>(
      'entities',
      { radius: query.radius ?? 0, limit: query.type || query.uuid || query.name ? 0 : query.limit ?? 0, includeSelf: !!query.includeSelf },
      20_000,
    );
    const type = query.type ? (query.type.includes(':') ? query.type : `minecraft:${query.type}`).toLowerCase() : undefined;
    const name = query.name?.toLowerCase();
    let result = list.filter(
      (e) =>
        (!type || e.type?.toLowerCase() === type) &&
        (!query.uuid || e.uuid === query.uuid) &&
        (!name || (e.name ?? '').toLowerCase().includes(name) || (e.customName ?? '').toLowerCase().includes(name)),
    );
    if (query.limit && query.limit > 0) result = result.slice(0, query.limit);
    return result;
  }

  async chat(message: string): Promise<void> {
    if (!message || message.length > 256) throw new CalciteError('bad_message', 'Chat message must be 1-256 characters');
    await this.requireProbe().request('chat', { message });
  }

  async command(command: string): Promise<void> {
    if (!command.trim()) throw new CalciteError('bad_command', 'Command is empty');
    await this.requireProbe().request('command', { command: command.trim() });
  }

  async respawn(): Promise<void> {
    await this.requireProbe().request('respawn');
  }

  async setRender(enabled: boolean): Promise<void> {
    if (this.headlessValue) throw new CalciteError('headless', 'This client runs without a renderer');
    await this.requireProbe().request('render', { enabled });
  }

  /** Takes a screenshot and returns the PNG. With {@code keep} the file stays in the game's screenshots folder. */
  async screenshot({ keep = false } = {}): Promise<{ path?: string; png: Buffer }> {
    if (this.headlessValue) {
      throw new CalciteError(
        'headless',
        this.render === 'off'
          ? 'This client was started with render "off"; start it with render "on-demand" to take screenshots'
          : 'Screenshots need a renderer: offline accounts can only render on Linux (Xvfb); use a Microsoft account on Windows/macOS',
      );
    }
    const name = `calcite-${Date.now()}.png`;
    const path = await this.requireProbe().request<string>('screenshot', { name, settleFrames: 3, timeoutMs: 30_000 }, 45_000);
    const png = await readFile(path);
    if (keep) return { path, png };
    await rm(path, { force: true });
    return { png };
  }

  logsSince(opts: { since?: number; limit?: number; contains?: string; source?: LogLine['source'] } = {}): LogLine[] {
    const contains = opts.contains?.toLowerCase();
    const lines = this.logs.filter(
      (l) => l.seq > (opts.since ?? 0) && (!opts.source || l.source === opts.source) && (!contains || l.line.toLowerCase().includes(contains)),
    );
    return opts.limit ? lines.slice(-opts.limit) : lines;
  }

  chatSince(since = 0, limit?: number): ChatLine[] {
    const lines = this.chats.filter((c) => c.seq > since);
    return limit ? lines.slice(-limit) : lines;
  }

  /**
   * Waits for a condition: a chat line matching {@code chat} (regex), an entity appearing/disappearing, or a
   * phase. Resolves with a description of what matched.
   */
  async waitFor(
    cond: { chat?: string; entity?: EntityQuery & { present?: boolean }; phase?: Phase },
    timeoutMs = 30_000,
  ): Promise<{ matched: string; chat?: ChatLine; entities?: EntityInfo[] }> {
    const deadline = Date.now() + timeoutMs;
    const chatRe = cond.chat ? new RegExp(cond.chat, 'i') : undefined;
    const startSeq = this.seq;
    for (;;) {
      if (chatRe) {
        const hit = this.chats.find((c) => c.seq > startSeq && chatRe.test(c.message));
        if (hit) return { matched: 'chat', chat: hit };
      }
      if (cond.phase && this.phaseValue === cond.phase) return { matched: 'phase' };
      if (cond.entity && this.probe?.connected) {
        const { present = true, ...query } = cond.entity;
        try {
          const found = await this.entities(query);
          if (present ? found.length > 0 : found.length === 0) return { matched: present ? 'entity_present' : 'entity_absent', entities: found };
        } catch (err) {
          if (!(err instanceof ProbeError) || !['not_ready', 'not_in_game'].includes(err.code)) throw err;
        }
      }
      if (Date.now() > deadline) throw new CalciteError('timeout', `Condition not met within ${timeoutMs}ms`);
      if (['stopped', 'crashed'].includes(this.phaseValue)) throw new CalciteError('not_running', `Client stopped (phase ${this.phaseValue})`);
      await sleep(300);
    }
  }
}

