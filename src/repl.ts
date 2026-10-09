import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { CalciteError, type ClickMode, type Client, type Surroundings } from './client.js';

/** A ":name" command of the interactive console; whatever {@code run} returns is printed. */
interface ReplCommand {
  args?: string;
  help: string;
  /** {@code rest} is the text after the command name, for arguments that may contain spaces. */
  run(client: Client, args: string[], rest: string): unknown;
}

const usage = (name: string) => new CalciteError('bad_request', `usage: :${name} ${lookup(name)?.args ?? ''}`);

/** Argument {@code index} as a number; fails with the command's usage when it is missing or not a number. */
function num(args: string[], index: number, name: string): number {
  const value = Number(args[index] ?? NaN);
  if (!Number.isFinite(value)) throw usage(name);
  return value;
}

/** Arguments {@code from} to {@code from + 2} as a block position. */
function point(args: string[], name: string, from = 0): { x: number; y: number; z: number } {
  return { x: num(args, from, name), y: num(args, from + 1, name), z: num(args, from + 2, name) };
}

const optionalNumber = (value: string | undefined) => (value === undefined ? undefined : Number(value));

export function formatSurroundings(s: Surroundings): string {
  return [
    `${s.x.toFixed(1)} ${s.y.toFixed(1)} ${s.z.toFixed(1)} facing ${s.facing} in ${s.biome ?? '?'} (${s.dimension ?? '?'}), time ${s.timeOfDay ?? '?'}`,
    `standing on ${s.standingOn ?? '?'}${s.in ? `, in ${s.in}` : ''}`,
    ...s.map.map((row) => `  ${row}`),
    `  ${s.legend}`,
    ...s.blocks.map((b) => `${String(b.count).padStart(5)}  ${b.id}  nearest ${b.nearest.join(' ')}`),
    ...s.entities.map((e) => `entity ${e.id} ${e.type}${e.name ? ` "${e.name}"` : ''} at ${e.distance}m`),
  ].join('\n');
}

const COMMANDS: Record<string, ReplCommand> = {
  state: { help: 'game state', run: (c) => c.state() },
  ents: {
    args: '[radius]',
    help: 'entities nearby',
    run: async (c, [radius]) =>
      (await c.entities({ radius: optionalNumber(radius) ?? 32 }))
        .map(
          (e) =>
            `${e.id}\t${e.type}\t${e.name ?? ''}${e.customName ? ` (${e.customName})` : ''}\t${e.x?.toFixed(1)} ${e.y?.toFixed(1)} ${e.z?.toFixed(1)}`,
        )
        .join('\n'),
  },
  around: {
    args: '[radius]',
    help: 'map of the area, nearby blocks and entities',
    run: async (c, [radius]) => formatSurroundings(await c.surroundings({ radius: optionalNumber(radius) })),
  },
  find: {
    args: '<block> [radius]',
    help: 'find blocks by id or pattern (*_ore)',
    run: (c, [blocks, radius]) => {
      if (!blocks) throw usage('find');
      return c.findBlocks({ blocks, radius: optionalNumber(radius) });
    },
  },
  shot: {
    args: '[file]',
    help: 'save a screenshot',
    run: async (c, [file = `calcite-${Date.now()}.png`]) => {
      const shot = await c.screenshot();
      await writeFile(file, shot.png);
      return `saved ${file} (${shot.png.length} bytes)`;
    },
  },
  render: { args: 'on|off', help: 'continuous rendering', run: (c, [mode]) => c.setRender(mode === 'on') },
  respawn: { help: 'respawn after death', run: (c) => c.respawn() },
  look: {
    args: '<yaw> <pitch>',
    help: 'turn to a rotation',
    run: (c, args) => c.look({ yaw: num(args, 0, 'look'), pitch: num(args, 1, 'look') }),
  },
  lookat: {
    args: '<x> <y> <z>',
    help: 'turn towards a point',
    run: (c, args) => c.look(point(args, 'lookat')),
  },
  goto: {
    args: '<x> <z> [y]',
    help: 'walk there along a path',
    run: (c, args) => c.walkTo(num(args, 0, 'goto'), num(args, 1, 'goto'), { y: optionalNumber(args[2]) }),
  },
  move: {
    args: '<forward,jump,...> [ticks]',
    help: 'hold movement keys',
    run: (c, [keys = '', ticks]) =>
      c.move(
        Object.fromEntries(
          keys
            .split(',')
            .filter(Boolean)
            .map((k) => [k, true]),
        ),
        { ticks: optionalNumber(ticks) ?? 20 },
      ),
  },
  stop: { help: 'release keys, cancel the running action', run: (c) => c.stopActions() },
  task: { help: 'the running action', run: (c) => c.task() },
  attack: { args: '[entity id]', help: 'left click', run: (c, [id]) => c.attack(optionalNumber(id)) },
  use: {
    args: '[entity id | x y z] [hold ticks]',
    help: 'right click',
    run: (c, args) =>
      args.length >= 3
        ? c.use({ block: point(args, 'use'), holdTicks: optionalNumber(args[3]) })
        : c.use({ entityId: optionalNumber(args[0]), holdTicks: optionalNumber(args[1]) }),
  },
  dig: {
    args: '<x> <y> <z>',
    help: 'mine a block',
    run: (c, args) => c.dig(point(args, 'dig')),
  },
  block: {
    args: '<x> <y> <z>',
    help: 'block at a position',
    run: (c, args) => c.block(point(args, 'block')),
  },
  target: { help: 'what the crosshair points at', run: (c) => c.target() },
  inv: { help: 'inventory', run: (c) => c.inventory() },
  slot: { args: '<0-8>', help: 'select a hotbar slot', run: (c, args) => c.selectSlot(num(args, 0, 'slot')) },
  craft: {
    args: '<item> [count]',
    help: 'craft from the inventory',
    run: (c, [item, count]) => {
      if (!item) throw usage('craft');
      return c.craft(item, { count: optionalNumber(count) });
    },
  },
  container: { help: 'the open container', run: (c) => c.container() },
  click: {
    args: '<slot> [button] [mode]',
    help: 'click a container slot',
    run: (c, args) => c.click(num(args, 0, 'click'), { button: optionalNumber(args[1]), mode: args[2] as ClickMode | undefined }),
  },
  transfer: {
    args: '<item> [count] [inventory]',
    help: 'move items into the open container (or back into the inventory)',
    run: (c, [item, ...rest]) => {
      if (!item) throw usage('transfer');
      const count = rest.map(Number).find(Number.isFinite);
      return c.transfer(item, { count, to: rest.includes('inventory') ? 'inventory' : 'container' });
    },
  },
  close: { help: 'close the container', run: (c) => c.closeContainer() },
  drop: { args: '[all]', help: 'drop the held item', run: (c, [all]) => c.drop({ all: all === 'all' }) },
  events: { args: '[name regex]', help: 'recent game events', run: (c, [name]) => c.eventsSince({ name, limit: 20 }) },
  ext: {
    help: 'extension commands',
    run: async (c) => {
      const { commands, extensions } = await c.extensions();
      return [
        ...extensions.map((x) => `jar ${x.jar}: ${x.error ? `failed: ${x.error}` : x.ids.join(', ')}`),
        ...commands.map((cmd) => `${cmd.name}\t${cmd.description ?? ''}${cmd.schema ? `\targs ${JSON.stringify(cmd.schema)}` : ''}`),
        ...(commands.length ? [] : ['no extension commands']),
      ].join('\n');
    },
  },
  call: {
    args: '<name> [json args]',
    help: 'call an extension command',
    run: (c, [name], rest) => {
      if (!name) throw usage('call');
      const json = rest.slice(name.length).trim();
      return c.call(name, json ? (JSON.parse(json) as Record<string, unknown>) : {});
    },
  },
  help: { help: 'this list', run: () => help() },
};

function lookup(name: string): ReplCommand | undefined {
  return Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
}

function help(): string {
  const lines = Object.entries(COMMANDS).map(([name, c]) => [`:${name} ${c.args ?? ''}`, c.help]);
  lines.push([':quit', 'stop the client']);
  const width = Math.max(...lines.map(([u]) => u.length));
  return ['Type chat, /command or:', ...lines.map(([u, h]) => `  ${u.padEnd(width)}  ${h}`)].join('\n');
}

/** Runs one console line: chat, a /command, or a :command. Returns the text to print, if any. */
export async function execute(client: Client, line: string): Promise<string | undefined> {
  if (line.startsWith('/')) {
    await client.command(line.slice(1));
    return undefined;
  }
  if (!line.startsWith(':')) {
    await client.chat(line);
    return undefined;
  }
  const [name = '', ...args] = line.slice(1).split(/\s+/);
  const command = lookup(name);
  if (!command) throw new CalciteError('unknown_command', `unknown command :${name} (:help lists them)`);
  const result = await command.run(client, args, line.slice(1 + name.length).trim());
  if (result === undefined || typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

/** Reads console lines until ":quit" or end of input, running each against the client. */
export async function runRepl(client: Client): Promise<void> {
  process.stderr.write(`Ready. ${help()}\n`);
  const rl = createInterface({ input: process.stdin });
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === ':quit' || line === ':q') break;
    if (!line) continue;
    try {
      const output = await execute(client, line);
      if (output) process.stdout.write(`${output}\n`);
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
    }
  }
  rl.close();
}
