import { z } from 'zod';
import { CalciteError } from '../client.js';
import { clientName, coord, entityFilter, safe, timeoutSeconds, tool, type Result, type ToolContext } from './shared.js';

/** Reading the world: entities, blocks, surroundings, screenshots, chat, events and logs. */
export function registerObserveTools({ server, manager }: ToolContext): void {
  tool(
    server,
    'surroundings',
    {
      title: 'Look around',
      description:
        'A compact picture of the area: a top-down relief map centred on the player (@), the most common blocks nearby with the nearest of each, nearby entities with offsets, and biome, time of day and weather. Start here before acting in an unknown place.',
      inputSchema: { client: clientName, radius: z.number().int().min(2).max(24).default(8).describe('Map radius in blocks') },
    },
    async ({ client, radius }) => manager.resolve(client).surroundings({ radius }),
  );

  tool(
    server,
    'find_blocks',
    {
      title: 'Find blocks',
      description:
        'Finds loaded blocks by id or pattern around the player, nearest first: "oak_log", "*_ore", "minecraft:*planks". Use with walk_to and dig to gather resources.',
      inputSchema: {
        client: clientName,
        blocks: z.union([z.string(), z.array(z.string()).min(1)]).describe('Block ids or patterns ("*" matches anything; "minecraft:" is implied)'),
        radius: z.number().int().min(1).max(128).default(32).describe('Horizontal radius in blocks'),
        limit: z.number().int().positive().max(256).default(16),
      },
    },
    async ({ client, ...search }) => manager.resolve(client).findBlocks(search),
  );

  tool(
    server,
    'get_entities',
    {
      title: 'Entities the client sees',
      description: 'Entities currently known to the client (what the server actually sent), with position, type, names and vehicle.',
      inputSchema: { client: clientName, ...entityFilter },
    },
    async ({ client, ...query }) => {
      const list = await manager.resolve(client).entities(query);
      return { count: list.length, entities: list };
    },
  );

  tool(
    server,
    'get_block',
    { title: 'Block at a position', description: 'Block id and state properties at x/y/z as the client sees them.', inputSchema: { client: clientName, x: coord, y: coord, z: coord } },
    async ({ client, ...pos }) => manager.resolve(client).block(pos),
  );

  tool(
    server,
    'get_target',
    { title: 'Crosshair target', description: 'The block (with face) or entity the crosshair points at.', inputSchema: { client: clientName } },
    async ({ client }) => manager.resolve(client).target(),
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot',
      description: 'Renders and returns the current view as a PNG image.',
      inputSchema: { client: clientName, keep: z.boolean().optional().describe('Also keep the file in the instance screenshots folder') },
    },
    safe(async ({ client, keep }: { client?: string; keep?: boolean }) => {
      const shot = await manager.resolve(client).screenshot({ keep });
      const content: Result['content'] = [{ type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' }];
      if (shot.path) content.push({ type: 'text', text: shot.path });
      return { content };
    }),
  );

  tool(
    server,
    'set_render',
    {
      title: 'Toggle continuous rendering',
      description: 'Turns continuous rendering on (e.g. while watching) or off (saves CPU). Screenshots work either way.',
      inputSchema: { client: clientName, enabled: z.boolean() },
    },
    async ({ client, enabled }) => {
      await manager.resolve(client).setRender(enabled);
      return `render ${enabled ? 'on' : 'off'}`;
    },
  );

  tool(
    server,
    'get_chat',
    {
      title: 'Chat history',
      description: 'Chat lines received by the client. Pass the last seen seq as "since" to get only new lines.',
      inputSchema: { client: clientName, since: z.number().int().nonnegative().optional(), limit: z.number().int().positive().max(1000).default(50) },
    },
    async ({ client, since, limit }) => manager.resolve(client).chatSince(since ?? 0, limit),
  );

  tool(
    server,
    'get_events',
    {
      title: 'Game events',
      description:
        'Events the client noticed: world.join/leave, player.hurt/death/respawn/food/dimension, inventory.change, container.open/close, screen.change, plus those from extensions and mods. Pass the last seen seq as "since" to get only new ones.',
      inputSchema: {
        client: clientName,
        since: z.number().int().nonnegative().optional(),
        name: z.string().optional().describe('Regular expression the event name must match, e.g. "^player\\\\."'),
        limit: z.number().int().positive().max(1000).default(50),
      },
    },
    async ({ client, ...query }) => manager.resolve(client).eventsSince(query),
  );

  tool(
    server,
    'wait_for',
    {
      title: 'Wait for a condition',
      description: 'Blocks until a chat line matches, a game event arrives, an entity appears/disappears, or the client reaches a phase.',
      inputSchema: {
        client: clientName,
        chat: z.string().optional().describe('Case-insensitive regular expression matched against new chat lines'),
        event: z.string().optional().describe('Regular expression matched against the names of new game events, e.g. "player.hurt|player.death"'),
        entity: z.object({ ...entityFilter, present: z.boolean().optional().describe('false waits for it to disappear') }).optional(),
        phase: z.enum(['in_game', 'disconnected', 'reconnecting', 'crashed', 'stopped']).optional(),
        timeoutSeconds: timeoutSeconds(30),
      },
    },
    async ({ client, timeoutSeconds: seconds, ...cond }) => {
      if (!cond.chat && !cond.event && !cond.entity && !cond.phase) throw new CalciteError('bad_condition', 'Give chat, event, entity or phase');
      return manager.resolve(client).waitFor(cond, seconds * 1000);
    },
  );

  tool(
    server,
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
    async ({ client, ...query }) => manager.resolve(client).logsSince(query),
  );
}
