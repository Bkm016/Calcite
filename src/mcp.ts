import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { listAccounts, removeAccount, startLogin, type LoginHandle } from './accounts.js';
import { CalciteError, defaultUsername, installVersion, type Account, type ClientOptions } from './client.js';
import { getManifest } from './mojang.js';
import { ClientManager } from './manager.js';
import { resolvePaths } from './paths.js';
import { VERSION } from './version.js';

type Result = CallToolResult;

function text(value: unknown): Result {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function failure(err: unknown): Result {
  const code = err instanceof CalciteError ? err.code : (err as { code?: string })?.code;
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text: code ? `[${code}] ${message}` : message }] };
}

/** Wraps a handler so every failure becomes an MCP tool error instead of a protocol error. */
function safe<A>(fn: (args: A) => Promise<Result>): (args: A) => Promise<Result> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return failure(err);
    }
  };
}

const clientName = z.string().optional().describe('Client name; may be omitted when exactly one client is running');

const entityFilter = {
  radius: z.number().positive().optional().describe('Only entities within this many blocks of the player'),
  type: z.string().optional().describe('Entity type id, e.g. "minecraft:player" or "zombie"'),
  uuid: z.string().optional(),
  name: z.string().optional().describe('Case-insensitive substring of the name or custom name'),
  limit: z.number().int().positive().max(1000).optional(),
  includeSelf: z.boolean().optional(),
};

export interface McpOptions {
  /** Defaults applied to launch_client calls. */
  defaults?: Partial<ClientOptions>;
}

export function createMcpServer(opts: McpOptions = {}): { server: McpServer; manager: ClientManager } {
  const paths = resolvePaths();
  const manager = new ClientManager();
  const logins = new Map<number, { handle: LoginHandle; url?: string; result?: string; error?: string }>();
  let loginSeq = 0;

  const server = new McpServer(
    { name: 'calcite', version: VERSION },
    {
      instructions: [
        'Calcite drives real Minecraft Java Edition clients (any version 1.14.4+ fully, older versions launch without probe features).',
        'Typical flow: launch_client (first launch of a version downloads ~0.5-1 GB and can take minutes) → get_state / get_entities / send_chat / run_command / screenshot / wait_for → stop_client.',
        'Acting: look / walk_to / move to get around, attack and use (right click: chests, doors, placing blocks, eating) on entity ids from get_entities or block coordinates, dig to mine, get_inventory / select_slot for items, get_container / click_slot / close_container for chests and other containers. Check results with get_state, get_target, get_block or a screenshot.',
        'Offline accounts need no login. For premium servers call account_login_start, show the URL to the user, then poll account_login_status.',
        'Screenshots need render "on-demand" (default) or "always"; with "on-demand" frames are only rendered while a screenshot is taken, keeping CPU usage low.',
      ].join('\n'),
    },
  );

  server.registerTool(
    'launch_client',
    {
      title: 'Launch a Minecraft client',
      description:
        'Downloads (if needed) and starts a Minecraft client, optionally joining a server. Resolves once the player is in the world (or on the title screen without a server).',
      inputSchema: {
        name: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/).describe('Unique client name; also the instance directory'),
        version: z.string().default('release').describe('Minecraft version id, "release" (latest release) or "snapshot"'),
        server: z.string().optional().describe('host[:port] to join'),
        username: z.string().optional().describe('Offline username (3-16 chars). Ignored when microsoft is set'),
        microsoft: z.union([z.boolean(), z.string()]).optional().describe('Use a stored Microsoft account: true for the primary one or the profile name'),
        render: z.enum(['on-demand', 'always', 'off']).optional().describe('on-demand (default): render only for screenshots; always; off: no renderer at all'),
        memory: z.string().regex(/^\d+[MG]$/).optional().describe('Max heap, e.g. "2G"'),
        reconnect: z.boolean().optional().describe('Relaunch and rejoin after a disconnect/crash (default true)'),
        timeoutSeconds: z.number().int().positive().optional().describe('Startup timeout (default 900)'),
      },
    },
    safe(async (a) => {
      const account: Account = a.microsoft
        ? { type: 'microsoft', name: typeof a.microsoft === 'string' ? a.microsoft : undefined }
        : { type: 'offline', username: a.username ?? defaultUsername(a.name) };
      const client = await manager.launch({
        ...opts.defaults,
        name: a.name,
        version: a.version,
        server: a.server,
        account,
        render: a.render ?? opts.defaults?.render,
        memory: a.memory ?? opts.defaults?.memory,
        reconnect: a.reconnect ?? opts.defaults?.reconnect,
        startTimeoutMs: a.timeoutSeconds ? a.timeoutSeconds * 1000 : opts.defaults?.startTimeoutMs,
      });
      return text(client.status());
    }),
  );

  server.registerTool(
    'stop_client',
    { title: 'Stop a client', description: 'Stops the game and frees its resources.', inputSchema: { client: clientName } },
    safe(async ({ client }) => {
      const target = manager.resolve(client);
      await manager.stop(target.options.name);
      return text(`Stopped ${target.options.name}`);
    }),
  );

  server.registerTool(
    'list_clients',
    { title: 'List clients', description: 'Status of every client managed by this server.', inputSchema: {} },
    safe(async () => text(manager.list())),
  );

  server.registerTool(
    'get_state',
    {
      title: 'Client state',
      description: 'Lifecycle status plus live game state: screen, position, health, dimension, fps, disconnect reason.',
      inputSchema: { client: clientName },
    },
    safe(async ({ client }) => {
      const target = manager.resolve(client);
      const status = target.status();
      if (status.probeConnected) {
        try {
          status.game = await target.state();
        } catch {
          // keep the last polled state
        }
      }
      return text(status);
    }),
  );

  server.registerTool(
    'get_entities',
    {
      title: 'Entities the client sees',
      description: 'Entities currently known to the client (what the server actually sent), with position, type, names and vehicle.',
      inputSchema: { client: clientName, ...entityFilter },
    },
    safe(async ({ client, ...query }) => {
      const list = await manager.resolve(client).entities(query);
      return text({ count: list.length, entities: list });
    }),
  );

  server.registerTool(
    'send_chat',
    { title: 'Send chat', description: 'Sends a chat message as the player.', inputSchema: { client: clientName, message: z.string().min(1).max(256) } },
    safe(async ({ client, message }) => {
      await manager.resolve(client).chat(message);
      return text('sent');
    }),
  );

  server.registerTool(
    'run_command',
    {
      title: 'Run command',
      description: 'Runs a command as the player (leading "/" optional). Output arrives as chat; use get_chat or wait_for to read it.',
      inputSchema: { client: clientName, command: z.string().min(1).max(32_000) },
    },
    safe(async ({ client, command }) => {
      const target = manager.resolve(client);
      const before = target.chatSince(0).at(-1)?.seq ?? 0;
      await target.command(command.replace(/^\//, ''));
      await new Promise((r) => setTimeout(r, 750));
      return text({ sent: true, chatSince: target.chatSince(before) });
    }),
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot',
      description: 'Renders and returns the current view as a PNG image.',
      inputSchema: { client: clientName, keep: z.boolean().optional().describe('Also keep the file in the instance screenshots folder') },
    },
    safe(async ({ client, keep }) => {
      const shot = await manager.resolve(client).screenshot({ keep });
      const content: Result['content'] = [{ type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' }];
      if (shot.path) content.push({ type: 'text', text: shot.path });
      return { content };
    }),
  );

  server.registerTool(
    'wait_for',
    {
      title: 'Wait for a condition',
      description: 'Blocks until a chat line matches, an entity appears/disappears, or the client reaches a phase.',
      inputSchema: {
        client: clientName,
        chat: z.string().optional().describe('Case-insensitive regular expression matched against new chat lines'),
        entity: z.object({ ...entityFilter, present: z.boolean().optional().describe('false waits for it to disappear') }).optional(),
        phase: z.enum(['in_game', 'disconnected', 'reconnecting', 'crashed', 'stopped']).optional(),
        timeoutSeconds: z.number().positive().max(600).default(30),
      },
    },
    safe(async ({ client, timeoutSeconds, ...cond }) => {
      if (!cond.chat && !cond.entity && !cond.phase) throw new CalciteError('bad_condition', 'Give chat, entity or phase');
      return text(await manager.resolve(client).waitFor(cond, timeoutSeconds * 1000));
    }),
  );

  server.registerTool(
    'get_chat',
    {
      title: 'Chat history',
      description: 'Chat lines received by the client. Pass the last seen seq as "since" to get only new lines.',
      inputSchema: { client: clientName, since: z.number().int().nonnegative().optional(), limit: z.number().int().positive().max(1000).default(50) },
    },
    safe(async ({ client, since, limit }) => text(manager.resolve(client).chatSince(since ?? 0, limit))),
  );

  server.registerTool(
    'get_logs',
    {
      title: 'Client logs',
      description: 'Game and Calcite log lines (useful when a launch fails or the client crashed).',
      inputSchema: {
        client: clientName,
        since: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(2000).default(100),
        contains: z.string().optional(),
        source: z.enum(['game', 'calcite']).optional(),
      },
    },
    safe(async ({ client, ...q }) => text(manager.resolve(client).logsSince(q))),
  );

  server.registerTool(
    'set_render',
    {
      title: 'Toggle continuous rendering',
      description: 'Turns continuous rendering on (e.g. while watching) or off (saves CPU). Screenshots work either way.',
      inputSchema: { client: clientName, enabled: z.boolean() },
    },
    safe(async ({ client, enabled }) => {
      await manager.resolve(client).setRender(enabled);
      return text(`render ${enabled ? 'on' : 'off'}`);
    }),
  );

  server.registerTool(
    'respawn',
    { title: 'Respawn', description: 'Respawns the player after death.', inputSchema: { client: clientName } },
    safe(async ({ client }) => {
      await manager.resolve(client).respawn();
      return text('respawned');
    }),
  );

  const coord = z.number().describe('Block coordinate');
  const face = z.enum(['down', 'up', 'north', 'south', 'west', 'east']).optional().describe('Block face to target (default: the face nearest to the player)');

  server.registerTool(
    'look',
    {
      title: 'Look',
      description: 'Turns the player: either to yaw/pitch in degrees (yaw 0 = south, 90 = west, 180 = north, -90 = east; pitch -90 = up, 90 = down) or towards the point x/y/z.',
      inputSchema: {
        client: clientName,
        yaw: z.number().optional(),
        pitch: z.number().min(-90).max(90).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
      },
    },
    safe(async ({ client, yaw, pitch, x, y, z: zz }) => {
      const target = manager.resolve(client);
      if (x !== undefined || y !== undefined || zz !== undefined) {
        if (x === undefined || y === undefined || zz === undefined) throw new CalciteError('bad_request', 'Give all of x, y and z');
        return text(await target.look({ x, y, z: zz }));
      }
      return text(await target.look({ yaw, pitch }));
    }),
  );

  server.registerTool(
    'walk_to',
    {
      title: 'Walk to a position',
      description:
        'Walks in a straight line to x/z (jumps over single blocks, swims). Returns arrived=false with reason "stuck" or "timeout" when blocked; there is no path finding, so route around obstacles with intermediate points.',
      inputSchema: {
        client: clientName,
        x: z.number(),
        z: z.number(),
        range: z.number().positive().max(16).default(0.5).describe('Stop within this many blocks'),
        sprint: z.boolean().default(true),
        timeoutSeconds: z.number().positive().max(600).default(60),
      },
    },
    safe(async ({ client, x, z: zz, range, sprint, timeoutSeconds }) =>
      text(await manager.resolve(client).walkTo(x, zz, { range, sprint, timeoutMs: timeoutSeconds * 1000 })),
    ),
  );

  server.registerTool(
    'move',
    {
      title: 'Hold movement keys',
      description:
        'Presses (true) or releases (false) movement keys; omitted keys keep their state. With ticks (20 per second) they are released automatically, otherwise they stay held until changed or stop_actions.',
      inputSchema: {
        client: clientName,
        forward: z.boolean().optional(),
        back: z.boolean().optional(),
        left: z.boolean().optional(),
        right: z.boolean().optional(),
        jump: z.boolean().optional(),
        sneak: z.boolean().optional(),
        sprint: z.boolean().optional(),
        ticks: z.number().int().positive().max(12_000).optional(),
      },
    },
    safe(async ({ client, ticks, ...controls }) => text(await manager.resolve(client).move(controls, { ticks }))),
  );

  server.registerTool(
    'stop_actions',
    { title: 'Stop actions', description: 'Releases all keys and cancels a running walk_to, dig or held use.', inputSchema: { client: clientName } },
    safe(async ({ client }) => {
      await manager.resolve(client).stopActions();
      return text('stopped');
    }),
  );

  server.registerTool(
    'attack',
    {
      title: 'Attack (left click)',
      description: 'Attacks the entity with this id (from get_entities; the player turns to it, must be within reach) or, without an id, whatever the crosshair points at.',
      inputSchema: { client: clientName, entityId: z.number().int().optional() },
    },
    safe(async ({ client, entityId }) => text(await manager.resolve(client).attack(entityId))),
  );

  server.registerTool(
    'use',
    {
      title: 'Use / interact (right click)',
      description:
        'Right click on an entity (entityId: trade, ride, feed...), on a block (x/y/z: open chests and doors, press buttons, place the held block against that face) or, with neither, on whatever the crosshair points at / the held item in the air. holdTicks keeps the button held (eat, drink, draw a bow).',
      inputSchema: {
        client: clientName,
        entityId: z.number().int().optional(),
        x: coord.optional(),
        y: coord.optional(),
        z: coord.optional(),
        face,
        holdTicks: z.number().int().positive().max(1200).optional(),
      },
    },
    safe(async ({ client, entityId, x, y, z: zz, face: f, holdTicks }) => {
      const hasBlock = x !== undefined || y !== undefined || zz !== undefined;
      if (hasBlock && (x === undefined || y === undefined || zz === undefined)) throw new CalciteError('bad_request', 'Give all of x, y and z');
      const block = hasBlock ? { x: x!, y: y!, z: zz!, face: f } : undefined;
      return text(await manager.resolve(client).use({ entityId, block, holdTicks }));
    }),
  );

  server.registerTool(
    'dig',
    {
      title: 'Mine a block',
      description: 'Mines the block at x/y/z like a player holding left click (real break time in survival, instant in creative). The block must be within reach.',
      inputSchema: { client: clientName, x: coord, y: coord, z: coord, face, timeoutSeconds: z.number().positive().max(300).default(30) },
    },
    safe(async ({ client, timeoutSeconds, face: f, ...pos }) => text(await manager.resolve(client).dig({ ...pos, face: f }, { timeoutMs: timeoutSeconds * 1000 }))),
  );

  server.registerTool(
    'get_block',
    { title: 'Block at a position', description: 'Block id and state properties at x/y/z as the client sees them.', inputSchema: { client: clientName, x: coord, y: coord, z: coord } },
    safe(async ({ client, ...pos }) => text(await manager.resolve(client).block(pos))),
  );

  server.registerTool(
    'get_target',
    { title: 'Crosshair target', description: 'The block (with face) or entity the crosshair points at.', inputSchema: { client: clientName } },
    safe(async ({ client }) => text(await manager.resolve(client).target())),
  );

  server.registerTool(
    'get_inventory',
    {
      title: 'Inventory',
      description: 'Non-empty inventory slots (0-8 hotbar, 9-35 main, 36-39 armor, 40 offhand) and the selected hotbar slot.',
      inputSchema: { client: clientName },
    },
    safe(async ({ client }) => text(await manager.resolve(client).inventory())),
  );

  server.registerTool(
    'select_slot',
    { title: 'Select hotbar slot', description: 'Selects hotbar slot 0-8 (the held item).', inputSchema: { client: clientName, slot: z.number().int().min(0).max(8) } },
    safe(async ({ client, slot }) => text(await manager.resolve(client).selectSlot(slot))),
  );

  server.registerTool(
    'get_container',
    {
      title: 'Open container',
      description:
        'The open container (chest, barrel, furnace, villager trades...) with its non-empty slots; slots 0..containerSlots-1 are the container, the rest the player inventory. waitSeconds waits for one to open, e.g. right after use on a chest.',
      inputSchema: { client: clientName, waitSeconds: z.number().min(0).max(30).default(0) },
    },
    safe(async ({ client, waitSeconds }) => text(await manager.resolve(client).container({ waitMs: waitSeconds * 1000 }))),
  );

  server.registerTool(
    'click_slot',
    {
      title: 'Click a container slot',
      description:
        'Clicks a slot of the open container (or of the inventory when none is open) and returns the new contents. mode: pickup (button 0 left / 1 right), quick_move (shift click: move the stack between container and inventory), swap (button = hotbar slot 0-8, 40 offhand), throw (button 1 = whole stack), clone, quick_craft, pickup_all. Slot -999 clicks outside (drops the carried stack).',
      inputSchema: {
        client: clientName,
        slot: z.number().int().min(-999),
        button: z.number().int().min(0).max(40).default(0),
        mode: z.enum(['pickup', 'quick_move', 'swap', 'clone', 'throw', 'quick_craft', 'pickup_all']).default('pickup'),
      },
    },
    safe(async ({ client, slot, button, mode }) => text(await manager.resolve(client).click(slot, { button, mode }))),
  );

  server.registerTool(
    'close_container',
    { title: 'Close container', description: 'Closes the open container or screen.', inputSchema: { client: clientName } },
    safe(async ({ client }) => {
      await manager.resolve(client).closeContainer();
      return text('closed');
    }),
  );

  server.registerTool(
    'drop_item',
    { title: 'Drop item', description: 'Drops one item, or the whole stack, from the selected hotbar slot.', inputSchema: { client: clientName, all: z.boolean().default(false) } },
    safe(async ({ client, all }) => text(await manager.resolve(client).drop({ all }))),
  );

  server.registerTool(
    'install_version',
    {
      title: 'Pre-download a version',
      description: 'Downloads a version (client, libraries, assets, Java) without launching, so the next launch is fast.',
      inputSchema: { version: z.string().default('release') },
    },
    safe(async ({ version }) => text(await installVersion(version, { paths }))),
  );

  server.registerTool(
    'list_versions',
    {
      title: 'Available versions',
      description: 'Minecraft versions from Mojang\'s manifest (newest first).',
      inputSchema: { type: z.enum(['release', 'snapshot', 'old_beta', 'old_alpha', 'all']).default('release'), limit: z.number().int().positive().default(30) },
    },
    safe(async ({ type, limit }) => {
      const manifest = await getManifest(paths);
      const versions = manifest.versions.filter((v) => type === 'all' || v.type === type).slice(0, limit);
      return text({ latest: manifest.latest, versions: versions.map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime })) });
    }),
  );

  server.registerTool(
    'account_list',
    { title: 'Stored Microsoft accounts', description: 'Microsoft accounts whose login is saved.', inputSchema: {} },
    safe(async () => text(await listAccounts(paths))),
  );

  server.registerTool(
    'account_login_start',
    {
      title: 'Start Microsoft login',
      description:
        'Starts a Microsoft device login. Returns a URL the user must open in a browser and approve; then poll account_login_status. The session is saved and refreshed automatically.',
      inputSchema: {},
    },
    safe(async () => {
      const id = ++loginSeq;
      const handle = await startLogin(paths);
      const entry: { handle: LoginHandle; url?: string; result?: string; error?: string } = { handle };
      logins.set(id, entry);
      handle.done.then(
        (n) => (entry.result = n),
        (e: Error) => (entry.error = e.message),
      );
      entry.url = await handle.url;
      return text({ loginId: id, url: entry.url, next: 'Ask the user to open the URL and sign in, then call account_login_status' });
    }),
  );

  server.registerTool(
    'account_login_status',
    {
      title: 'Microsoft login status',
      description: 'Waits up to waitSeconds for a pending login started with account_login_start.',
      inputSchema: { loginId: z.number().int(), waitSeconds: z.number().min(0).max(120).default(30) },
    },
    safe(async ({ loginId, waitSeconds }) => {
      const entry = logins.get(loginId);
      if (!entry) throw new CalciteError('unknown_login', `No login with id ${loginId}`);
      if (!entry.result && !entry.error) {
        await Promise.race([entry.handle.done.catch(() => undefined), new Promise((r) => setTimeout(r, waitSeconds * 1000))]);
      }
      if (entry.result) return text({ status: 'done', account: entry.result });
      if (entry.error) return text({ status: 'failed', error: entry.error });
      return text({ status: 'pending', url: entry.url });
    }),
  );

  server.registerTool(
    'account_remove',
    { title: 'Remove a stored account', description: 'Deletes a saved Microsoft login.', inputSchema: { account: z.string() } },
    safe(async ({ account }) => {
      if (!(await removeAccount(paths, account))) throw new CalciteError('unknown_account', `No stored account named "${account}"`);
      return text(`Removed ${account}`);
    }),
  );

  return { server, manager };
}

/** Runs the MCP server over stdio until the client disconnects. stdout carries only protocol messages. */
export async function runMcpStdio(opts: McpOptions = {}): Promise<void> {
  const { server, manager } = createMcpServer(opts);
  const transport = new StdioServerTransport();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await manager.stopAll();
    process.exit(0);
  };
  transport.onclose = () => void close();
  process.stdin.once('end', () => void close());
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  await server.connect(transport);
}
