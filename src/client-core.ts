import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { prepareAccount, syncAccount } from './accounts.js';
import { acquireDisplay, which, type DisplayLease } from './display.js';
import { hmcListEntry, hmcQuote, hmcVersionArgs, killTree, runHmc, writeHmcProfile, type HmcRun } from './hmc.js';
import { installProbe, prepareGame, type PreparedGame } from './install.js';
import { parseLoader } from './loaders.js';
import { acquireLock } from './lock.js';
import { logger } from './log.js';
import { resolveExtensions, resolveMods, syncMods, type ModFile } from './mods.js';
import { javaProxyProps } from './net.js';
import { supportsQuickPlay } from './mojang.js';
import { defaultOptions, writeOptions } from './options.js';
import { resolvePaths, type CalcitePaths } from './paths.js';
import { ProbeError, ProbeServer } from './probe-server.js';
import {
  CalciteError,
  defaultUsername,
  parseServer,
  type Account,
  type ChatLine,
  type ClientOptions,
  type ClientStatus,
  type ExtensionEvent,
  type GameState,
  type LogLine,
  type Phase,
  type RenderMode,
  type ServerAddress,
} from './types.js';

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_LOG = 5000;
const MAX_CHAT = 1000;
const MAX_EVENTS = 1000;

/** Escapes a value for a java.util.Properties file. */
function propValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/[:=]/g, (c) => `\\${c}`);
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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Process lifecycle of a client: preparing, launching, the probe connection, reconnects and shutdown. */
export abstract class ClientCore extends EventEmitter {
  readonly options: Required<Pick<ClientOptions, 'name' | 'version'>> & ClientOptions;
  readonly paths: CalcitePaths;
  readonly gameDir: string;
  readonly render: RenderMode;
  readonly account: Account;
  readonly server?: ServerAddress;

  protected phaseValue: Phase = 'idle';
  protected logs: LogLine[] = [];
  protected chats: ChatLine[] = [];
  protected events: ExtensionEvent[] = [];
  private extensionJars: string[] = [];
  protected seq = 0;
  protected probe: ProbeServer | null = null;
  private run: HmcRun | null = null;
  private display: DisplayLease | null = null;
  private releaseInstance: (() => Promise<void>) | null = null;
  private probeConfig: string | null = null;
  private game: PreparedGame | null = null;
  private mods: ModFile[] = [];
  protected headlessValue = false;
  protected lastState: GameState | undefined;
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
    if (!parseLoader(options.loader) && options.mods?.length) {
      throw new CalciteError('bad_mod', 'Mods need a mod loader (loader "fabric", "forge" or "neoforge")');
    }
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
    this.headlessValue = this.resolveHeadless();
    const game = await prepareGame(this.paths, {
      version: this.options.version,
      loader: this.options.loader,
      javaPath: this.options.javaPath,
      allowJavaDownload: this.options.allowJavaDownload,
      headless: this.headlessValue,
      onLine: (line) => this.note(`installer: ${line}`),
    });
    this.game = game;
    if (game.names.kind === 'unsupported') this.note(`probe disabled: ${game.names.reason}`);
    const loader = game.loader ? ` with ${game.loader.kind} ${game.loader.build}` : '';
    this.note(`java ${game.java.version} (${game.java.path}) for Minecraft ${game.json.id}${loader}`);
    this.mods = game.loader ? await resolveMods(this.paths, this.options.mods ?? [], game.json.id, game.loader.kind) : [];
    await syncMods(this.gameDir, this.mods);
    for (const m of this.mods) this.note(`mod ${m.name} (${m.source})`);
    this.extensionJars = await resolveExtensions(this.paths, this.options.extensions ?? []);
    for (const jar of this.extensionJars) this.note(`extension ${jar}`);
  }

  private resolveHeadless(): boolean {
    if (this.render === 'off') return true;
    if (this.account.type === 'offline' && process.platform !== 'linux') {
      this.note('offline accounts can only render on Linux with Xvfb (HeadlessMC policy); running headless — use a Microsoft account for screenshots');
      return true;
    }
    return false;
  }

  private async launch(): Promise<void> {
    const { json, java, loader, names, hmcJar } = this.game!;
    const probeJar = await installProbe(this.paths);

    if (this.server) {
      this.setPhase('waiting_for_server');
      const waitMs = this.options.waitForServerMs ?? 120_000;
      const since = Date.now();
      let reported = since;
      while (!(await tcpReachable(this.server.host, this.server.port))) {
        if (this.stopping) throw new CalciteError('stopped', 'Stopped while waiting for the server');
        const waited = Date.now() - since;
        if (waited > waitMs) {
          throw new CalciteError('server_unreachable', `Server ${this.server.host}:${this.server.port} is not reachable (waited ${Math.round(waited / 1000)}s)`);
        }
        if (Date.now() - reported >= 10_000) {
          reported = Date.now();
          const msg = `still waiting for ${this.server.host}:${this.server.port} (${Math.round(waited / 1000)}s of ${Math.round(waitMs / 1000)}s)`;
          this.note(msg);
          this.log.info(msg);
        }
        await sleep(2000);
      }
    }

    // probe endpoint + config (paths inside may contain spaces; the config file itself lives in a safe dir)
    this.probe = new ProbeServer();
    await this.probe.listen();
    this.probe.on('connected', () => this.onProbeConnected());
    this.probe.on('disconnected', () => this.note('probe disconnected'));
    this.probe.on('event', (e: { name: string; data: unknown; time: number }) => {
      const event: ExtensionEvent = { seq: ++this.seq, time: e.time, name: e.name, data: e.data };
      this.events.push(event);
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
      this.emit('extension', event);
    });
    this.probeConfig = join(this.paths.probe, `${this.options.name}-${randomBytes(6).toString('hex')}.properties`);
    const cfg = [
      `port=${this.probe.port}`,
      `token=${this.probe.token}`,
      // name tables the probe tries in order (a mapping file or "official")
      ...(names.kind === 'probe' ? names.candidates.map((c, i) => `mappings.${i + 1}=${propValue(c)}`) : []),
      `version=${propValue(json.id)}`,
      ...this.extensionJars.map((jar, i) => `extensions.${i + 1}=${propValue(jar)}`),
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

    const proxyArgs = Object.entries(javaProxyProps()).map(([k, v]) => `-D${k}=${v}`);
    const jvmArgs = [`-Xmx${this.options.memory ?? '2G'}`, ...proxyArgs, ...(this.options.jvmArgs ?? [])];
    if (names.kind !== 'unsupported') jvmArgs.unshift(`-javaagent:${probeJar}=${this.probeConfig}`);
    // HeadlessMC's stubbed LWJGL buffers have no native address; JOML's Unsafe path writes to it and crashes the JVM
    if (this.headlessValue) jvmArgs.unshift('-Djoml.nounsafe=true');
    const gameArgs = [...(this.options.gameArgs ?? [])];
    if (this.server) {
      if (supportsQuickPlay(json)) gameArgs.unshift('--quickPlayMultiplayer', `${this.server.host}:${this.server.port}`);
      else gameArgs.unshift('--server', this.server.host, '--port', String(this.server.port));
    }
    const offline = this.account.type === 'offline';
    // a private HeadlessMC location per client: its own account selection, config and caches
    const location = join(this.gameDir, '.headlessmc');
    let accountName: string;
    try {
      accountName = await prepareAccount(this.paths, location, this.account);
    } catch (err) {
      const code = (err as { code?: string }).code;
      throw code ? new CalciteError(code, (err as Error).message) : err;
    }
    await writeHmcProfile(location, json.id, this.gameDir, java.major, loader);
    const props: Record<string, string> = {
      'hmc.files.mc': this.paths.minecraft,
      'hmc.files.game': this.gameDir,
      'hmc.java.versions': hmcListEntry(java.path),
      'hmc.java.download': 'false',
      // HeadlessMC only lets offline accounts render when it sees Xvfb running
      'hmc.xvfb.check': String(virtualDisplay),
    };
    const command = [
      'launch',
      ...hmcVersionArgs(json.id, loader),
      ...(offline ? ['--offline'] : []),
      ...(this.headlessValue ? ['--headless'] : []),
      `--jvm=${jvmArgs.map(hmcQuote).join(' ')}`,
      ...(gameArgs.length ? [`--game=${gameArgs.map(hmcQuote).join(' ')}`] : []),
    ];
    const env = { ...process.env, ...displayEnv };
    const sync = () => {
      if (!offline) void syncAccount(this.paths, location, accountName).catch((err) => this.note(`account sync failed: ${(err as Error).message}`));
    };

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
        javaPath: this.game!.launcherJava.path,
        hmcJar,
        location,
        props,
        command,
        env,
        onLine: (line) => {
          this.pushLog('game', line);
          if (/Setting user:|Minecraft exited|LWJGL Version|Backend library/i.test(line)) launched();
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
      void run.exited.then((code) => {
        sync();
        this.onGameExit(run, code);
      });
      // the session HeadlessMC refreshed before launching goes back to the shared store
      void launchedPromise.then(sync);
    };

    await spawnGame();
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
    if (state.screen && /LoadingErrorScreen|ModLoadingError/.test(state.screen) && !this.fatalCode && this.run) {
      // Forge/NeoForge stay on an error screen when mods fail to load; relaunching would not help
      const errors = this.logs.filter((l) => l.source === 'game' && /\/(ERROR|FATAL)\]|Exception|[Mm]issing|requires/.test(l.line)).slice(-12);
      this.fatalCode = 'mod_loading_failed';
      this.lastError = `Mod loading failed (${state.screen}); check the mods and the loader version:\n${errors.map((l) => l.line).join('\n')}`;
      this.note(this.lastError);
      this.setPhase('crashed');
      void killTree(this.run.child);
      return;
    }
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
      version: this.game?.json.id ?? this.options.version,
      loader: this.game?.loader ? `${this.game.loader.kind}@${this.game.loader.build}` : this.options.loader,
      mods: this.mods.length ? this.mods.map((m) => m.name) : undefined,
      extensions: this.extensionJars.length ? this.extensionJars : undefined,
      phase: this.phaseValue,
      render: this.render,
      headless: this.headlessValue,
      account: this.account,
      server: this.server,
      gameDir: this.gameDir,
      pid: this.run?.child.pid,
      java: this.game?.java.version,
      startedAt: this.startedAt,
      reconnects: this.reconnects,
      lastError: this.lastError,
      probeConnected: !!this.probe?.connected,
      game: this.lastState,
    };
  }

  // ------------------------------------------------------------------ operations

  protected requireProbe(): ProbeServer {
    if (this.game?.names.kind === 'unsupported') {
      throw new CalciteError('unsupported_version', this.game.names.reason);
    }
    if (!this.probe?.connected) throw new CalciteError('not_connected', `Client "${this.options.name}" is not running (phase ${this.phaseValue})`);
    return this.probe;
  }
}
