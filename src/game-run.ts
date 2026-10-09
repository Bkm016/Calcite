import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireDisplay, type DisplayLease } from './display.js';
import { killTree, type HmcRun } from './hmc.js';
import { probeConfig, type ProbeSettings } from './launch.js';
import { ProbeServer } from './probe-server.js';

export interface GameRunSetup {
  /** Directory for the probe's settings file. */
  dir: string;
  /** Prefix of the settings file name (the client name). */
  name: string;
  probe: Omit<ProbeSettings, 'port' | 'token'>;
  /** Display to acquire for a rendering client; absent when headless. */
  display?: { forceVirtual: boolean };
}

/** What one launch of the game holds: the probe endpoint and its settings file, the display, the process and the poller. */
export class GameRun {
  /** The HeadlessMC process, once spawned. */
  hmc: HmcRun | null = null;
  private poller: NodeJS.Timeout | undefined;

  private constructor(
    readonly probe: ProbeServer,
    readonly configFile: string,
    readonly display: DisplayLease | null,
  ) {}

  /** Opens the probe endpoint, writes its settings and acquires a display; nothing is left behind when this fails. */
  static async open(setup: GameRunSetup): Promise<GameRun> {
    const probe = new ProbeServer();
    await probe.listen();
    const configFile = join(setup.dir, `${setup.name}-${randomBytes(6).toString('hex')}.properties`);
    try {
      await mkdir(setup.dir, { recursive: true });
      await writeFile(configFile, probeConfig({ port: probe.port, token: probe.token, ...setup.probe }), { mode: 0o600 });
      const display = setup.display ? await acquireDisplay(setup.display) : null;
      return new GameRun(probe, configFile, display);
    } catch (err) {
      await probe.close();
      await rm(configFile, { force: true });
      throw err;
    }
  }

  /** Runs {@code task} every {@code intervalMs} until disposed; later calls keep the first poller. */
  poll(task: () => void, intervalMs: number): void {
    this.poller ??= setInterval(task, intervalMs);
  }

  async dispose(): Promise<void> {
    clearInterval(this.poller);
    if (this.hmc) await killTree(this.hmc.child);
    await this.probe.close();
    await rm(this.configFile, { force: true });
    this.display?.release();
  }
}
