import { readFile, rm } from 'node:fs/promises';
import { ClientCore, sleep } from './client-core.js';
import { ProbeError } from './probe-server.js';
import {
  CalciteError,
  type BlockFace,
  type BlockInfo,
  type BlockPosition,
  type BlockSearch,
  type BlockSearchResult,
  type ChatLine,
  type ClickMode,
  type ContainerInfo,
  type CraftResult,
  type DigResult,
  type EntityInfo,
  type EntityQuery,
  type ExtensionCommand,
  type ExtensionInfo,
  type GameEvent,
  type GameState,
  type HitTarget,
  type InventoryInfo,
  type ItemInfo,
  type LogLine,
  type MoveControls,
  type Phase,
  type Surroundings,
  type TaskStatus,
  type TransferResult,
  type WalkOptions,
  type WalkResult,
} from './types.js';

export * from './types.js';
export { installVersion, type InstallOptions } from './install.js';

/**
 * One Minecraft client controlled by Calcite.
 *
 * Events: 'phase' (Phase), 'log' (LogLine), 'chat' (ChatLine), 'state' (GameState), 'event' (GameEvent),
 * 'exit' (code).
 *
 * Long actions ({@link walkTo}, {@link dig}, {@link craft}) run one at a time: starting another, or
 * {@link stopActions}, cancels the running one, whose promise then rejects with code "cancelled".
 */
export class Client extends ClientCore {
  async state(): Promise<GameState> {
    const state = await this.requireProbe().request<GameState>('state');
    this.lastState = state;
    return state;
  }

  async entities(query: EntityQuery = {}): Promise<EntityInfo[]> {
    const list = await this.requireProbe().request<EntityInfo[]>(
      'entities',
      {
        radius: query.radius ?? 0,
        limit: query.type || query.uuid || query.name ? 0 : (query.limit ?? 0),
        includeSelf: !!query.includeSelf,
      },
      20_000,
    );
    const type = query.type ? (query.type.includes(':') ? query.type : `minecraft:${query.type}`).toLowerCase() : undefined;
    const name = query.name?.toLowerCase();
    let result = list.filter(
      (e) =>
        (!type || e.type.toLowerCase() === type) &&
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

  // ------------------------------------------------------------------ actions

  /** Turns the player to an absolute rotation (degrees; yaw 0 = south, pitch -90 = up) or towards a point. */
  async look(to: { yaw?: number; pitch?: number } | { x: number; y: number; z: number }): Promise<{ yaw: number; pitch: number }> {
    return this.requireProbe().request('look', to);
  }

  /**
   * Holds movement controls until changed (or for {@code ticks} game ticks, 20 per second). Pass false to release
   * a control; {@link stop} releases all of them.
   */
  async move(controls: MoveControls, opts: { ticks?: number } = {}): Promise<MoveControls & { releaseInTicks?: number }> {
    return this.requireProbe().request('move', { ...controls, ticks: opts.ticks ?? 0 });
  }

  /** Releases every control and cancels the running action (walkTo, dig, craft, held use). */
  async stopActions(): Promise<void> {
    await this.requireProbe().request('stop');
  }

  /** The running action and its progress. */
  async task(): Promise<TaskStatus> {
    return this.requireProbe().request('task');
  }

  /**
   * Walks to (x, z), finding a path through the loaded terrain: around walls, up steps and slabs, down drops
   * of up to three blocks, across water, never into lava or fire. The path is planned again when the player
   * is pushed off it. Resolves when within {@code range}, or with {@code arrived: false} and a reason.
   */
  async walkTo(x: number, z: number, opts: WalkOptions = {}): Promise<WalkResult> {
    const { timeoutMs = 60_000, ...rest } = opts;
    return this.requireProbe().request('walk_to', { x, z, ...rest, timeoutMs }, timeoutMs + 15_000);
  }

  /** Left click: attacks the entity (facing it first) or whatever the crosshair points at. */
  async attack(entityId?: number): Promise<HitTarget> {
    return this.requireProbe().request('attack', entityId === undefined ? {} : { entityId });
  }

  /**
   * Right click: interacts with an entity, a block (opening chests, pressing buttons, placing the held block
   * against that face) or, with no target, whatever the crosshair points at / the held item in the air.
   * {@code holdTicks} keeps the button pressed afterwards (eating, drinking, drawing a bow, shields).
   */
  async use(target: { entityId?: number; block?: BlockPosition & { face?: BlockFace }; holdTicks?: number } = {}): Promise<HitTarget> {
    const { block, ...rest } = target;
    return this.requireProbe().request('use', { ...rest, ...(block ?? {}) });
  }

  /** Mines a block like a player (holding left click, taking the real break time). */
  async dig(block: BlockPosition & { face?: BlockFace }, opts: { stopOnDamage?: boolean; timeoutMs?: number } = {}): Promise<DigResult> {
    const { timeoutMs = 30_000, stopOnDamage } = opts;
    return this.requireProbe().request('dig', { ...block, stopOnDamage, timeoutMs }, timeoutMs + 15_000);
  }

  /** Loaded blocks matching ids or patterns around the player, nearest first. */
  async findBlocks(search: BlockSearch): Promise<BlockSearchResult> {
    return this.requireProbe().request('find_blocks', { ...search }, 20_000);
  }

  /** A top-down terrain map, nearby blocks and entities, biome, time and weather. */
  async surroundings(opts: { radius?: number } = {}): Promise<Surroundings> {
    return this.requireProbe().request('surroundings', { ...opts }, 20_000);
  }

  /**
   * Crafts at least {@code count} of an item through the recipe book, from ingredients in the inventory (a recipe
   * making four planks may overshoot). Recipes larger than 2×2 need a crafting table: an open one, or one within
   * reach that is opened and closed again. Only recipes the player has unlocked are known.
   */
  async craft(item: string, opts: { count?: number; timeoutMs?: number } = {}): Promise<CraftResult> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    return this.requireProbe().request('craft', { item, count: opts.count ?? 1, timeoutMs }, timeoutMs + 15_000);
  }

  /** The block at a position as the client sees it. */
  async block(pos: BlockPosition): Promise<BlockInfo> {
    return this.requireProbe().request('block', { ...pos });
  }

  /** What the crosshair points at. */
  async target(): Promise<HitTarget> {
    return this.requireProbe().request('target');
  }

  async inventory(): Promise<InventoryInfo> {
    return this.requireProbe().request('inventory');
  }

  /** Selects hotbar slot 0-8. */
  async selectSlot(slot: number): Promise<{ selected: number; item: ItemInfo | null }> {
    return this.requireProbe().request('select_slot', { slot });
  }

  /** The open container (chest, furnace, villager trade, ...) or the inventory; {@code waitMs} waits for one to open. */
  async container(opts: { waitMs?: number } = {}): Promise<ContainerInfo> {
    const waitMs = opts.waitMs ?? 0;
    return this.requireProbe().request('container', { waitMs }, waitMs + 15_000);
  }

  /**
   * Clicks a slot of the open container (or the inventory). Modes: pickup (default; button 0 left, 1 right),
   * quick_move (shift click), swap (button = hotbar slot 0-8 or 40 for the offhand), clone, throw (button 1 =
   * whole stack), quick_craft, pickup_all. Slot -999 is outside the window.
   */
  async click(slot: number, opts: { button?: number; mode?: ClickMode } = {}): Promise<ContainerInfo> {
    return this.requireProbe().request('click', { slot, button: opts.button ?? 0, mode: opts.mode ?? 'pickup' });
  }

  /**
   * Moves items between the open container and the inventory. Without count or slot whole stacks are
   * shift-clicked, so the game picks the slots (fuel goes into a furnace's fuel slot); otherwise up to
   * {@code count} items go into {@code slot} or the first slots that take them.
   */
  async transfer(item: string, opts: { to?: 'container' | 'inventory'; count?: number; slot?: number } = {}): Promise<TransferResult> {
    return this.requireProbe().request('transfer', { item, ...opts });
  }

  async closeContainer(): Promise<void> {
    await this.requireProbe().request('close_container');
  }

  /** Drops one item (or the whole stack) from the selected hotbar slot. */
  async drop(opts: { all?: boolean } = {}): Promise<ItemInfo> {
    return this.requireProbe().request('drop', { all: !!opts.all });
  }

  async setRender(enabled: boolean): Promise<void> {
    if (this.headless) throw new CalciteError('headless', 'This client runs without a renderer');
    await this.requireProbe().request('render', { enabled });
  }

  /** Takes a screenshot and returns the PNG. With {@code keep} the file stays in the game's screenshots folder. */
  async screenshot({ keep = false } = {}): Promise<{ path?: string; png: Buffer }> {
    if (this.headless) {
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
    return this.logs.since(
      opts.since,
      (l) => (!opts.source || l.source === opts.source) && (!contains || l.line.toLowerCase().includes(contains)),
      opts.limit,
    );
  }

  chatSince(since = 0, limit?: number): ChatLine[] {
    return this.chats.since(since, undefined, limit);
  }

  /** The newest sequence number; pass it as {@code since} later to get only what arrived after now. */
  get lastSeq(): number {
    return this.seq;
  }

  /** Game events received after {@code since}, optionally only those whose name matches {@code name} (regex). */
  eventsSince(opts: { since?: number; name?: string; limit?: number } = {}): GameEvent[] {
    const re = opts.name ? new RegExp(opts.name) : undefined;
    return this.events.since(opts.since, re && ((e) => re.test(e.name)), opts.limit);
  }

  /** Commands registered by extensions and mods, and the extension jars the probe loaded. */
  async extensions(): Promise<{ commands: ExtensionCommand[]; extensions: ExtensionInfo[] }> {
    return this.requireProbe().request('ext.list');
  }

  /** Calls an extension command, e.g. {@code call('hud.bossbars')}. */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
    return this.requireProbe().request<T>('ext.call', { name, args }, opts.timeoutMs ?? 30_000);
  }

  /**
   * Waits for a condition: a chat line matching {@code chat} (regex), a game event whose name matches
   * {@code event} (regex), an entity appearing/disappearing, or a phase. Resolves with a description of what matched.
   */
  async waitFor(
    cond: { chat?: string; event?: string; entity?: EntityQuery & { present?: boolean }; phase?: Phase },
    timeoutMs = 30_000,
  ): Promise<{ matched: string; chat?: ChatLine; event?: GameEvent; entities?: EntityInfo[] }> {
    const deadline = Date.now() + timeoutMs;
    const chatRe = cond.chat ? new RegExp(cond.chat, 'i') : undefined;
    const eventRe = cond.event ? new RegExp(cond.event) : undefined;
    const startSeq = this.seq;
    for (;;) {
      if (chatRe) {
        const hit = this.chats.find(startSeq, (c) => chatRe.test(c.message));
        if (hit) return { matched: 'chat', chat: hit };
      }
      if (eventRe) {
        const hit = this.events.find(startSeq, (e) => eventRe.test(e.name));
        if (hit) return { matched: 'event', event: hit };
      }
      if (cond.phase && this.phase === cond.phase) return { matched: 'phase' };
      if (cond.entity && this.probe?.connected) {
        const { present = true, ...query } = cond.entity;
        try {
          const found = await this.entities(query);
          if (present ? found.length > 0 : found.length === 0)
            return { matched: present ? 'entity_present' : 'entity_absent', entities: found };
        } catch (err) {
          if (!(err instanceof ProbeError) || !['not_ready', 'not_in_game'].includes(err.code)) throw err;
        }
      }
      if (Date.now() > deadline) throw new CalciteError('timeout', `Condition not met within ${timeoutMs}ms`);
      if (['stopped', 'crashed'].includes(this.phase)) throw new CalciteError('not_running', `Client stopped (phase ${this.phase})`);
      await sleep(300);
    }
  }
}
