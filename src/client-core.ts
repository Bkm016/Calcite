import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { prepareAccount, syncAccount } from './accounts.js';
import { which } from './display.js';
import { Feed } from './feed.js';
import { GameRun } from './game-run.js';
import { killTree, runHmc, writeHmcProfile, type HmcRunOptions } from './hmc.js';
import { assetsVerified, installProbe, markAssetsVerified, prepareGame, type PreparedGame } from './install.js';
import {
  BackendWatch,
  gameJvmArgs,
  hmcLaunchCommand,
  hmcProperties,
  joinArgs,
  noBackendHint,
  reconnectDelay,
  reconnectLimit,
  waitForServer,
} from './launch.js';
import { parseLoader } from './loaders.js';
import { acquireLock } from './lock.js';
import { logger } from './log.js';
import { resolveExtensions, resolveMods, syncMods, type ModFile } from './mods.js';
import { supportsQuickPlay } from './mojang.js';
import { defaultOptions, writeOptions } from './options.js';
import { resolvePaths, type CalcitePaths } from './paths.js';
import type { ProbeServer } from './probe-server.js';
import { MOD_ERROR_LINE, gameStage } from './stage.js';
import {
  CalciteError,
  defaultUsername,
  parseServer,
  parseWorld,
  type Account,
  type ChatLine,
  type ClientEvents,
  type ClientOptions,
  type ClientStatus,
  type GameEvent,
  type GameState,
  type LogLine,
  type Phase,
  type RenderMode,
  type ServerAddress,
  type WorldOptions,
} from './types.js';

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_LOG = 5000;
const MAX_CHAT = 1000;
const MAX_EVENTS = 1000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Process lifecycle of a client: preparing, launching, the probe connection, reconnects and shutdown. */
export abstract class ClientCore extends EventEmitter<ClientEvents> {
  readonly options: Required<Pick<ClientOptions, 'name' | 'version'>> & ClientOptions;
  readonly paths: CalcitePaths;
  readonly gameDir: string;
  readonly render: RenderMode;
  readonly account: Account;
  readonly server?: ServerAddress;
  readonly world?: WorldOptions;

  protected phaseValue: Phase = 'idle';
  protected readonly logs = new Feed<LogLine>(MAX_LOG);
  protected readonly chats = new Feed<ChatLine>(MAX_CHAT);
  protected readonly events = new Feed<GameEvent>(MAX_EVENTS);
  private extensionJars: string[] = [];
  protected seq = 0;
  private current: GameRun | null = null;
  private releaseInstance: (() => Promise<void>) | null = null;
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
    if (options.server && options.world) throw new CalciteError('bad_option', 'Pass either a server or a world, not both');
    this.server = options.server ? parseServer(options.server) : undefined;
    this.world = options.world ? parseWorld(options.world) : undefined;
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
    this.emit('log', entry);
    if (source === 'game') {
      const chat = /\[CHAT\] (.*)$/.exec(line);
      if (chat) {
        const c: ChatLine = { seq: entry.seq, time: entry.time, message: chat[1] };
        this.chats.push(c);
        this.emit('chat', c);
      }
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Prepares everything (Java, game files, mappings), launches the client and resolves once it is in a world
   * (or on the title screen when neither a server nor a world is configured).
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
      this.note(
        'offline accounts can only render on Linux with Xvfb (HeadlessMC policy); running headless — use a Microsoft account for screenshots',
      );
      return true;
    }
    return false;
  }

  private requireGame(): PreparedGame {
    if (!this.game) throw new CalciteError('not_prepared', 'prepare() has not completed');
    return this.game;
  }

  private async launch(): Promise<void> {
    const game = this.requireGame();
    const { json, java, loader, names } = game;
    const probeJar = await installProbe(this.paths);
    if (this.server) await this.waitForServer(this.server);

    // offline accounts may only render on a virtual display (HeadlessMC); on-demand clients stay invisible when Xvfb exists
    const forceVirtual = this.account.type === 'offline' || (this.render === 'on-demand' && which('Xvfb') !== null);
    const run = await GameRun.open({
      dir: this.paths.probe,
      name: this.options.name,
      probe: {
        mappings: names.kind === 'probe' ? names.candidates : [],
        version: json.id,
        extensions: this.extensionJars,
        headless: this.headlessValue,
        render: this.render,
      },
      display: this.headlessValue ? undefined : { forceVirtual },
    });
    this.current = run;
    run.probe.on('connected', () => this.onProbeConnected(run));
    run.probe.on('disconnected', () => this.note('probe disconnected'));
    run.probe.on('event', (e) => {
      const event: GameEvent = { seq: ++this.seq, time: e.time, name: e.name, data: e.data };
      this.events.push(event);
      this.emit('event', event);
    });
    await writeOptions(this.gameDir, defaultOptions({ renderDistance: this.options.renderDistance, maxFps: this.options.maxFps }));

    const jvmArgs = gameJvmArgs({
      agent: names.kind === 'unsupported' ? undefined : `${probeJar}=${run.configFile}`,
      headless: this.headlessValue,
      memory: this.options.memory,
      extra: this.options.jvmArgs,
    });
    const gameArgs = [...(this.server ? joinArgs(this.server, supportsQuickPlay(json)) : []), ...(this.options.gameArgs ?? [])];
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
    const props = hmcProperties({
      minecraftDir: this.paths.minecraft,
      gameDir: this.gameDir,
      javaPath: java.path,
      virtualDisplay: run.display?.virtual ?? false,
      assetsVerified: await assetsVerified(this.paths, json),
    });
    // the session HeadlessMC refreshed before launching goes back to the shared store
    const syncSession = () => {
      if (offline) return;
      syncAccount(this.paths, location, accountName).catch((err: unknown) => {
        this.note(`account sync failed: ${(err as Error).message}`);
      });
    };

    this.setPhase('starting');
    this.joinRequested = false;
    this.startedAt = Date.now();
    this.spawn(run, {
      javaPath: game.launcherJava.path,
      hmcJar: game.hmcJar,
      location,
      props,
      command: hmcLaunchCommand({ versionId: json.id, loader, offline, headless: this.headlessValue, jvmArgs, gameArgs }),
      env: { ...process.env, ...run.display?.env },
      onLaunched: syncSession,
      onExit: syncSession,
    });
  }

  private async waitForServer(server: ServerAddress): Promise<void> {
    this.setPhase('waiting_for_server');
    await waitForServer(server, {
      timeoutMs: this.options.waitForServerMs ?? 120_000,
      stopped: () => this.stopping,
      onWaiting: (message) => {
        this.note(message);
        this.log.info(message);
      },
    });
  }

  /** Starts HeadlessMC and follows the game's output until it exits. */
  private spawn(run: GameRun, opts: HmcRunOptions & { onLaunched: () => void; onExit: () => void }): void {
    let launched = false;
    const backend = new BackendWatch((errors) => {
      if (run !== this.current || this.stopping) return;
      this.fail('renderer_unavailable', `No graphics backend could be created: ${errors.join('; ')}. ${noBackendHint(process.platform)}`);
    });
    const hmc = runHmc({
      ...opts,
      onLine: (line) => {
        this.pushLog('game', line);
        backend.line(line);
        if (!launched && /Setting user:|Minecraft exited|LWJGL Version|Backend library/i.test(line)) {
          launched = true;
          opts.onLaunched();
        }
      },
    });
    run.hmc = hmc;
    void hmc.exited.then((code) => {
      backend.dispose();
      opts.onExit();
      this.onGameExit(run, code);
    });
  }

  private onProbeConnected(run: GameRun): void {
    this.note('probe connected');
    // the game JVM only starts once HeadlessMC has downloaded and verified every asset
    if (this.game) void markAssetsVerified(this.paths, this.game.json).catch(() => undefined);
    if (this.phaseValue === 'starting' || this.phaseValue === 'reconnecting') this.setPhase('connecting');
    run.poll(() => void this.poll(run), 1000);
  }

  private async poll(run: GameRun): Promise<void> {
    if (run !== this.current || !run.probe.connected) return;
    let state: GameState;
    try {
      state = await run.probe.request<GameState>('state', {}, 10_000);
    } catch {
      return; // not ready yet, or the connection is going away: the next poll tells
    }
    const prev = this.lastState;
    this.lastState = state;
    if (JSON.stringify(prev) !== JSON.stringify(state)) this.emit('state', state);
    switch (gameStage(state)) {
      case 'mod_error':
        if (!this.fatalCode) this.failModLoading(state.screen ?? '?');
        break;
      case 'playing':
        if (this.phaseValue !== 'in_game') {
          this.inGameSince = Date.now();
          this.everInGame = true;
          this.setPhase('in_game');
        } else if (this.reconnects > 0 && Date.now() - this.inGameSince > 60_000) {
          this.reconnects = 0; // stable again
        }
        break;
      case 'title':
        if (this.joinRequested || this.phaseValue !== 'connecting') break;
        // Pre-1.20 versions may ignore --server (e.g. 1.16.4+ when multiplayer privileges cannot be checked)
        if (this.server) this.joinFromTitle(run.probe, 'connect', { host: this.server.host, port: this.server.port });
        else if (this.world) this.joinFromTitle(run.probe, 'open_world', { ...this.world });
        break;
      case 'disconnected':
        if (this.phaseValue !== 'disconnected' && this.phaseValue !== 'reconnecting') {
          this.lastError = `Disconnected: ${state.disconnectReason ?? 'unknown reason'}`;
          this.setPhase('disconnected');
          void this.maybeReconnect();
        }
        break;
      case 'loading':
        break;
    }
  }

  /** Forge/NeoForge stay on an error screen when mods fail to load; relaunching would not help. */
  private failModLoading(screen: string): void {
    const errors = this.logs.since(0, (l) => l.source === 'game' && MOD_ERROR_LINE.test(l.line), 12);
    this.fail(
      'mod_loading_failed',
      `Mod loading failed (${screen}); check the mods and the loader version:\n${errors.map((l) => l.line).join('\n')}`,
    );
  }

  /** A failure relaunching cannot fix: start() reports {@code code} and the game is killed. */
  private fail(code: string, message: string): void {
    this.fatalCode = code;
    this.lastError = message;
    this.note(message);
    this.setPhase('crashed');
    if (this.current?.hmc) void killTree(this.current.hmc.child);
  }

  private joinFromTitle(probe: ProbeServer, op: 'connect' | 'open_world', args: Record<string, unknown>): void {
    this.joinRequested = true;
    this.note(`${op} ${JSON.stringify(args)} from the title screen`);
    probe.request(op, args, 90_000).catch((err: unknown) => {
      const e = err as { code?: string; message: string };
      this.note(`join failed: ${e.message}`);
      if (e.code === 'unknown_world') this.fail(e.code, e.message);
    });
  }

  private async maybeReconnect(): Promise<void> {
    if (this.stopping || this.relaunching || !(this.server ?? this.world)) return;
    if (this.reconnects >= reconnectLimit(this.options.reconnect)) {
      this.note(`not reconnecting: ${this.reconnects} attempts used`);
      return;
    }
    this.relaunching = true;
    try {
      this.reconnects++;
      const delay = reconnectDelay(this.reconnects);
      this.setPhase('reconnecting');
      this.note(`reconnecting in ${delay}ms (attempt ${this.reconnects})`);
      if (this.current?.hmc) await killTree(this.current.hmc.child);
      await sleep(delay);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop() may run while sleeping
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

  private onGameExit(run: GameRun, code: number | null): void {
    if (run !== this.current) return; // an older run
    this.emit('exit', code);
    this.note(`game process exited with code ${code}`);
    if (this.stopping || this.relaunching || this.fatalCode) return;
    const tail = this.logs
      .since(0, (l) => l.source === 'game', 15)
      .map((l) => l.line)
      .join('\n');
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
      if (!this.server && !this.world && this.lastState?.ready && this.lastState.loading === false && phase === 'connecting') return;
      if (phase === 'crashed') throw new CalciteError(this.fatalCode ?? 'crashed', this.lastError ?? 'The game crashed during startup');
      if (phase === 'disconnected' && reconnectLimit(this.options.reconnect) === 0)
        throw new CalciteError('disconnected', this.lastError ?? 'Disconnected');
      if (Date.now() > deadline) throw new CalciteError('start_timeout', `Client did not start within ${timeoutMs}ms (phase ${phase})`);
      await sleep(250);
    }
  }

  private async cleanupRun(): Promise<void> {
    const run = this.current;
    this.current = null;
    this.lastState = undefined;
    await run?.dispose();
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
    const saveWorld = this.world && this.phaseValue === 'in_game' && this.probeConnected;
    this.setPhase('stopping');
    if (saveWorld) await this.closeWorld();
    await this.shutdown('stopped');
  }

  /** Lets the integrated server save and stop before the game is killed. */
  private async closeWorld(): Promise<void> {
    try {
      await this.requireProbe().request('close_world', {}, 60_000);
      this.note('world saved');
    } catch (err) {
      this.note(`saving the world failed: ${(err as Error).message}`);
    }
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
      world: this.world,
      gameDir: this.gameDir,
      pid: this.current?.hmc?.child.pid,
      java: this.game?.java.version,
      startedAt: this.startedAt,
      reconnects: this.reconnects,
      lastError: this.lastError,
      probeConnected: this.probeConnected,
      game: this.lastState,
    };
  }

  // ------------------------------------------------------------------ operations

  protected get probeConnected(): boolean {
    return !!this.current?.probe.connected;
  }

  protected requireProbe(): ProbeServer {
    if (this.game?.names.kind === 'unsupported') {
      throw new CalciteError('unsupported_version', this.game.names.reason);
    }
    const probe = this.current?.probe;
    if (!probe?.connected)
      throw new CalciteError('not_connected', `Client "${this.options.name}" is not running (phase ${this.phaseValue})`);
    return probe;
  }
}
