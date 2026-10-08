import type { CalcitePaths } from './paths.js';

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
  /**
   * Mod loader: "fabric", "forge" or "neoforge", optionally with a loader version ("fabric@0.19.5"). Installed on
   * first use; without a version the newest installed one (or the loader's current release) is used.
   */
  loader?: string;
  /**
   * Mods to put in the game's mods folder (needs a loader): local jars or folders of jars, http(s) URLs, or
   * "modrinth:<project>[@<version>]" (resolved for this Minecraft version and loader, with required dependencies).
   * Mods Calcite placed earlier and no longer listed are removed; other files in the folder are kept.
   */
  mods?: string[];
  /**
   * Probe extensions: jars implementing {@code calcite.probe.api.CalciteExtension} (local files or http(s) URLs).
   * They add commands ({@link ExtensionCommand}) and events to the bot; see the README.
   */
  extensions?: string[];
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

/** A command added by a probe extension or a mod (through the mod bridge). */
export interface ExtensionCommand {
  /** Full name, e.g. "hud.bossbars". */
  name: string;
  description?: string;
  /** JSON schema of the arguments, when the extension declares one. */
  schema?: Record<string, unknown>;
  /** Extension id, or "mod" for commands registered by a mod through the bridge. */
  source: string;
}

export interface ExtensionInfo {
  jar: string;
  ids: string[];
  /** Why the jar could not be loaded. */
  error?: string;
}

/**
 * An event from the game: built-in ones ("world.join", "player.hurt", "inventory.change", ... — see the README)
 * and those sent by extensions and mods.
 */
export interface GameEvent {
  seq: number;
  time: number;
  name: string;
  data: unknown;
}

/** @deprecated Renamed to {@link GameEvent}. */
export type ExtensionEvent = GameEvent;

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
  food?: number;
  /** survival, creative, adventure or spectator. */
  gameMode?: string;
  dimension?: string;
}

export interface MoveControls {
  forward?: boolean;
  back?: boolean;
  left?: boolean;
  right?: boolean;
  jump?: boolean;
  sneak?: boolean;
  sprint?: boolean;
}

export interface BlockPosition {
  x: number;
  y: number;
  z: number;
}

export type BlockFace = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';

export type ClickMode = 'pickup' | 'quick_move' | 'swap' | 'clone' | 'throw' | 'quick_craft' | 'pickup_all';

export interface WalkOptions {
  /** Target height; without it any height at x/z counts. */
  y?: number;
  /** Stop within this many blocks (default 0.5). */
  range?: number;
  sprint?: boolean;
  /** Walk in a straight line instead of planning a path. */
  direct?: boolean;
  /** Stop with reason "damaged" when the player is hurt. */
  stopOnDamage?: boolean;
  timeoutMs?: number;
}

export interface WalkResult {
  arrived: boolean;
  /**
   * Why it stopped early: "no_path" (unreachable through the loaded terrain; the player still gets as close as
   * it can), "stuck", "off_path" (pushed away and re-planning failed), "timeout" or "damaged".
   */
  reason?: string;
  /** Remaining distance. */
  distance: number;
  x: number;
  y: number;
  z: number;
  /** How often the path was planned again after the player was pushed off it. */
  replans?: number;
}

export interface DigResult {
  broken: boolean;
  reason?: string;
  block?: string;
  ticks?: number;
}

export interface BlockMatch extends BlockPosition {
  id: string;
  /** Distance from the player's feet. */
  distance: number;
}

export interface BlockSearch {
  /** Block ids or patterns: "oak_log", "minecraft:*_ore", "*planks" ("minecraft:" is implied). */
  blocks: string | string[];
  /** Horizontal search radius in blocks (default 32, at most 128). */
  radius?: number;
  /** Most matches to return, nearest first (default 16). */
  limit?: number;
}

export interface BlockSearchResult {
  count: number;
  /** The search ran out of time before covering the whole radius. */
  truncated?: boolean;
  blocks: BlockMatch[];
}

export interface NearbyEntity {
  id: number;
  type: string;
  name?: string;
  /** Position relative to the player: [dx, dy, dz]. */
  offset: [number, number, number];
  distance: number;
  health?: number;
}

/** A compact description of the player's surroundings, sized for a language model. */
export interface Surroundings {
  x: number;
  y: number;
  z: number;
  facing: string;
  dimension?: string;
  biome?: string;
  /** 0-23999; 0 is sunrise, 6000 noon, 13000 night. */
  timeOfDay?: number;
  raining?: boolean;
  thundering?: boolean;
  /** The block under the player's feet. */
  standingOn?: string;
  /** The block the player stands in, when not air (water, tall grass, ...). */
  in?: string;
  /** Top-down map rows from north to south, west to east; the player is '@'. See {@link legend}. */
  map: string[];
  /** World [x, z] of the map's first character. */
  mapOrigin: [number, number];
  legend: Record<string, string>;
  /** Most common blocks around the player with the nearest position of each. */
  blocks: { id: string; count: number; nearest: [number, number, number] }[];
  entities: NearbyEntity[];
}

export interface CraftResult {
  item: string;
  /** Items made. */
  crafted: number;
  /** Items asked for. */
  count: number;
  /** Set when fewer than {@code count} were crafted: "missing_ingredients", "inventory_full", "timeout", ... */
  reason?: string;
}

export interface TransferResult {
  item: string;
  moved: number;
  container: ContainerInfo;
}

/** The action that is running (walk_to, dig, craft) and its progress. */
export interface TaskStatus {
  running: boolean;
  /** "walk_to", "dig" or "craft". */
  name?: string;
  ticks?: number;
  [progress: string]: unknown;
}

export interface HitTarget {
  type: 'block' | 'entity' | 'miss';
  x?: number;
  y?: number;
  z?: number;
  face?: BlockFace;
  block?: string;
  entity?: EntityInfo;
  holdTicks?: number;
}

export interface BlockInfo extends BlockPosition {
  /** false when the chunk is not loaded on the client. */
  loaded?: boolean;
  id?: string;
  air?: boolean;
  /** Block state properties, e.g. "facing=north,type=single,waterlogged=false". */
  properties?: string;
}

export interface ItemInfo {
  id: string;
  count: number;
  name: string;
  damage?: number;
  maxDamage?: number;
}

export interface InventoryInfo {
  /** Selected hotbar slot (0-8). */
  selected: number;
  /** Non-empty slots: 0-8 hotbar, 9-35 main, 36-39 armor, 40 offhand. */
  items: (ItemInfo & { slot: number })[];
}

export interface ContainerInfo {
  /** A container other than the player's own inventory is open. */
  open: boolean;
  containerId?: number;
  /** Menu type, e.g. "minecraft:generic_9x3" for a chest. */
  type?: string | null;
  title?: string;
  /** Total slots; slots 0..containerSlots-1 belong to the container, the rest to the player. */
  size?: number;
  containerSlots?: number;
  /** Non-empty slots (menu slot index; inventorySlot for the player's own slots). */
  items?: (ItemInfo & { slot: number; inventorySlot?: number })[];
  /** Stack held by the cursor. */
  carried?: ItemInfo;
  /** Smelting state of a furnace, smoker or blast furnace; progress and fuel are 0-1. */
  furnace?: { lit: boolean; progress?: number; fuel?: number };
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
  /** Mod loader and its version, e.g. "fabric@0.19.5". */
  loader?: string;
  /** File names of the mods Calcite placed in the mods folder. */
  mods?: string[];
  /** Extension jars passed to the probe. */
  extensions?: string[];
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

export function parseServer(server: string | ServerAddress): ServerAddress {
  if (typeof server !== 'string') return { host: server.host, port: server.port || 25565 };
  const s = server.trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : 25565 };
  const idx = s.lastIndexOf(':');
  if (idx > 0 && s.indexOf(':') === idx) return { host: s.slice(0, idx), port: Number(s.slice(idx + 1)) };
  return { host: s, port: 25565 };
}

/** Offline username derived from a client name (3-16 chars of [A-Za-z0-9_]). */
export function defaultUsername(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16).padEnd(3, '_');
}
