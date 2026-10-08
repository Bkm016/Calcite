import { z } from 'zod';
import { background, clientName, coord, face, optionalPoint, stopOnDamage, timeoutSeconds, tool, type ToolContext } from './shared.js';

/** Acting as the player: chat, commands, looking, moving, fighting, using and mining. */
export function registerActTools({ server, manager, tasks }: ToolContext): void {
  tool(
    server,
    'send_chat',
    { title: 'Send chat', description: 'Sends a chat message as the player.', inputSchema: { client: clientName, message: z.string().min(1).max(256) } },
    async ({ client, message }) => {
      await manager.resolve(client).chat(message);
      return 'sent';
    },
  );

  tool(
    server,
    'run_command',
    {
      title: 'Run command',
      description: 'Runs a command as the player (leading "/" optional) and returns the chat lines that arrived within 750 ms; use wait_for for slower replies.',
      inputSchema: { client: clientName, command: z.string().min(1).max(32_000) },
    },
    async ({ client, command }) => {
      const target = manager.resolve(client);
      const before = target.lastSeq;
      await target.command(command.replace(/^\//, ''));
      await new Promise((r) => setTimeout(r, 750));
      return { sent: true, chatSince: target.chatSince(before) };
    },
  );

  tool(server, 'respawn', { title: 'Respawn', description: 'Respawns the player after death.', inputSchema: { client: clientName } }, async ({ client }) => {
    await manager.resolve(client).respawn();
    return 'respawned';
  });

  tool(
    server,
    'look',
    {
      title: 'Look',
      description:
        'Turns the player: either to yaw/pitch in degrees (yaw 0 = south, 90 = west, 180 = north, -90 = east; pitch -90 = up, 90 = down) or towards the point x/y/z.',
      inputSchema: {
        client: clientName,
        yaw: z.number().optional(),
        pitch: z.number().min(-90).max(90).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
      },
    },
    async ({ client, yaw, pitch, x, y, z: zz }) => manager.resolve(client).look(optionalPoint(x, y, zz) ?? { yaw, pitch }),
  );

  tool(
    server,
    'walk_to',
    {
      title: 'Walk to a position',
      description:
        'Finds a path through the loaded terrain and walks it: around walls, up steps, down drops of up to 3 blocks, across water, never into lava. Re-plans when pushed off the path. Returns arrived=false with a reason (no_path, stuck, off_path, timeout, damaged) when it cannot get there; with no_path it still gets as close as it can.',
      inputSchema: {
        client: clientName,
        x: z.number(),
        y: z.number().optional().describe('Target height; omit to accept any height at x/z'),
        z: z.number(),
        range: z.number().positive().max(16).default(0.5).describe('Stop within this many blocks'),
        sprint: z.boolean().default(true),
        direct: z.boolean().default(false).describe('Walk in a straight line without planning a path'),
        stopOnDamage,
        background,
        timeoutSeconds: timeoutSeconds(60),
      },
    },
    async ({ client, x, z: zz, timeoutSeconds: seconds, background: bg, ...opts }) => {
      const target = manager.resolve(client);
      return tasks.run(target, 'walk_to', bg, () => target.walkTo(x, zz, { ...opts, timeoutMs: seconds * 1000 }));
    },
  );

  tool(
    server,
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
    async ({ client, ticks, ...controls }) => manager.resolve(client).move(controls, { ticks }),
  );

  tool(
    server,
    'stop_actions',
    { title: 'Stop actions', description: 'Releases all keys and cancels the running walk_to, dig, craft or held use.', inputSchema: { client: clientName } },
    async ({ client }) => {
      await manager.resolve(client).stopActions();
      return 'stopped';
    },
  );

  tool(
    server,
    'get_task',
    {
      title: 'Running action',
      description:
        'Progress of the running walk_to, dig or craft (waypoint, distance, crafted count...) and the outcome of the last one started with background: true.',
      inputSchema: { client: clientName, waitSeconds: z.number().min(0).max(120).default(0).describe('Wait up to this long for the background action to end') },
    },
    async ({ client, waitSeconds }) => tasks.status(manager.resolve(client), waitSeconds * 1000),
  );

  tool(
    server,
    'attack',
    {
      title: 'Attack (left click)',
      description: 'Attacks the entity with this id (from get_entities; the player turns to it, must be within reach) or, without an id, whatever the crosshair points at.',
      inputSchema: { client: clientName, entityId: z.number().int().optional() },
    },
    async ({ client, entityId }) => manager.resolve(client).attack(entityId),
  );

  tool(
    server,
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
    async ({ client, entityId, x, y, z: zz, face: f, holdTicks }) => {
      const point = optionalPoint(x, y, zz);
      return manager.resolve(client).use({ entityId, block: point && { ...point, face: f }, holdTicks });
    },
  );

  tool(
    server,
    'dig',
    {
      title: 'Mine a block',
      description: 'Mines the block at x/y/z like a player holding left click (real break time in survival, instant in creative). The block must be within reach.',
      inputSchema: { client: clientName, x: coord, y: coord, z: coord, face, stopOnDamage, background, timeoutSeconds: timeoutSeconds(30, 300) },
    },
    async ({ client, timeoutSeconds: seconds, face: f, stopOnDamage: stop, background: bg, ...pos }) => {
      const target = manager.resolve(client);
      return tasks.run(target, 'dig', bg, () => target.dig({ ...pos, face: f }, { stopOnDamage: stop, timeoutMs: seconds * 1000 }));
    },
  );
}
