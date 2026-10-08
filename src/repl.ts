import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { CalciteError, type ClickMode, type Client, type Surroundings } from './client.js';

/** A ":name" command of the interactive console; whatever {@code run} returns is printed. */
interface ReplCommand {
  args?: string;
  help: string;
  /** {@code rest} is the text after the command name, for arguments that may contain spaces. */
  run(client: Client, args: string[], rest: string): Promise<unknown>;
}

const out = (line = '') => process.stdout.write(`${line}\n`);

/** The first {@code count} arguments as numbers; fails with the command's usage otherwise. */
function numbers(args: string[], count: number, name: string): number[] {
  const n = args.slice(0, count).map(Number);
  if (n.length < count || n.some((v) => !Number.isFinite(v))) {
    throw new CalciteError('bad_request', `usage: :${name} ${COMMANDS[name].args ?? ''}`);
  }
  return n;
}

const optionalNumber = (value: string | undefined) => (value === undefined ? undefined : Number(value));

function printSurroundings(s: Surroundings): void {
  out(`${s.x.toFixed(1)} ${s.y.toFixed(1)} ${s.z.toFixed(1)} facing ${s.facing} in ${s.biome ?? '?'} (${s.dimension ?? '?'}), time ${s.timeOfDay ?? '?'}`);
  out(`standing on ${s.standingOn ?? '?'}${s.in ? `, in ${s.in}` : ''}`);
  for (const row of s.map) out(`  ${row}`);
  out(`  ${Object.entries(s.legend).map(([k, v]) => `${k} ${v}`).join('  ')}`);
  for (const b of s.blocks) out(`${String(b.count).padStart(5)}  ${b.id}  nearest ${b.nearest.join(' ')}`);
  for (const e of s.entities) out(`entity ${e.id} ${e.type}${e.name ? ` "${e.name}"` : ''} at ${e.distance}m`);
}

const COMMANDS: Record<string, ReplCommand> = {
  state: { help: 'game state', run: (c) => c.state() },
  ents: {
    args: '[radius]',
    help: 'entities nearby',
    run: async (c, [radius]) => {
      for (const e of await c.entities({ radius: Number(radius ?? 32) })) {
        out(`${e.id}\t${e.type}\t${e.name ?? ''}${e.customName ? ` (${e.customName})` : ''}\t${e.x?.toFixed(1)} ${e.y?.toFixed(1)} ${e.z?.toFixed(1)}`);
      }
    },
  },
  around: {
    args: '[radius]',
    help: 'map of the area, nearby blocks and entities',
    run: async (c, [radius]) => printSurroundings(await c.surroundings({ radius: optionalNumber(radius) })),
  },
  find: {
    args: '<block> [radius]',
    help: 'find blocks by id or pattern (*_ore)',
    run: (c, [blocks, radius]) => {
      if (!blocks) throw new CalciteError('bad_request', 'usage: :find <block> [radius]');
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
    run: (c, args) => {
      const [yaw, pitch] = numbers(args, 2, 'look');
      return c.look({ yaw, pitch });
    },
  },
  lookat: {
    args: '<x> <y> <z>',
    help: 'turn towards a point',
    run: (c, args) => {
      const [x, y, z] = numbers(args, 3, 'lookat');
      return c.look({ x, y, z });
    },
  },
  goto: {
    args: '<x> <z> [y]',
    help: 'walk there along a path',
    run: (c, args) => {
      const [x, z] = numbers(args, 2, 'goto');
      return c.walkTo(x, z, { y: optionalNumber(args[2]) });
    },
  },
  move: {
    args: '<forward,jump,...> [ticks]',
    help: 'hold movement keys',
    run: (c, [keys = '', ticks]) => c.move(Object.fromEntries(keys.split(',').filter(Boolean).map((k) => [k, true])), { ticks: Number(ticks ?? 20) }),
  },
  stop: { help: 'release keys, cancel the running action', run: (c) => c.stopActions() },
  task: { help: 'the running action', run: (c) => c.task() },
  attack: { args: '[entity id]', help: 'left click', run: (c, [id]) => c.attack(optionalNumber(id)) },
  use: {
    args: '[entity id | x y z] [hold ticks]',
    help: 'right click',
    run: (c, args) => {
      if (args.length >= 3) {
        const [x, y, z] = numbers(args, 3, 'use');
        return c.use({ block: { x, y, z }, holdTicks: optionalNumber(args[3]) });
      }
      return c.use({ entityId: optionalNumber(args[0]), holdTicks: optionalNumber(args[1]) });
    },
  },
  dig: {
    args: '<x> <y> <z>',
    help: 'mine a block',
    run: (c, args) => {
      const [x, y, z] = numbers(args, 3, 'dig');
      return c.dig({ x, y, z });
    },
  },
  block: {
    args: '<x> <y> <z>',
    help: 'block at a position',
    run: (c, args) => {
      const [x, y, z] = numbers(args, 3, 'block');
      return c.block({ x, y, z });
    },
  },
  target: { help: 'what the crosshair points at', run: (c) => c.target() },
  inv: { help: 'inventory', run: (c) => c.inventory() },
  slot: { args: '<0-8>', help: 'select a hotbar slot', run: (c, args) => c.selectSlot(numbers(args, 1, 'slot')[0]) },
  craft: {
    args: '<item> [count]',
    help: 'craft from the inventory',
    run: (c, [item, count]) => {
      if (!item) throw new CalciteError('bad_request', 'usage: :craft <item> [count]');
      return c.craft(item, { count: optionalNumber(count) });
    },
  },
  container: { help: 'the open container', run: (c) => c.container() },
  click: {
    args: '<slot> [button] [mode]',
    help: 'click a container slot',
    run: (c, args) => c.click(numbers(args, 1, 'click')[0], { button: Number(args[1] ?? 0), mode: (args[2] as ClickMode) ?? 'pickup' }),
  },
  transfer: {
    args: '<item> [count] [inventory]',
    help: 'move items into (or out of) the open container',
    run: (c, [item, count, to]) => {
      if (!item) throw new CalciteError('bad_request', 'usage: :transfer <item> [count] [inventory]');
      return c.transfer(item, { count: count && count !== 'all' ? Number(count) : undefined, to: to === 'inventory' ? 'inventory' : 'container' });
    },
  },
  close: { help: 'close the container', run: (c) => c.closeContainer() },
  drop: { args: '[all]', help: 'drop the held item', run: (c, [all]) => c.drop({ all: all === 'all' }) },
  events: { args: '[name regex]', help: 'recent game events', run: async (c, [name]) => c.eventsSince({ name, limit: 20 }) },
  ext: {
    help: 'extension commands',
    run: async (c) => {
      const { commands, extensions } = await c.extensions();
      for (const x of extensions) out(`jar ${x.jar}: ${x.error ? `failed: ${x.error}` : x.ids.join(', ')}`);
      for (const cmd of commands) out(`${cmd.name}\t${cmd.description ?? ''}${cmd.schema ? `\targs ${JSON.stringify(cmd.schema)}` : ''}`);
      if (!commands.length) out('no extension commands');
    },
  },
  call: {
    args: '<name> [json args]',
    help: 'call an extension command',
    run: (c, [name], rest) => {
      if (!name) throw new CalciteError('bad_request', 'usage: :call <name> [json args]');
      const json = rest.slice(name.length).trim();
      return c.call(name, json ? (JSON.parse(json) as Record<string, unknown>) : {});
    },
  },
  help: { help: 'this list', run: async () => help() },
};

function help(): string {
  const usage = Object.entries(COMMANDS).map(([name, c]) => [`:${name} ${c.args ?? ''}`, c.help]);
  usage.push([':quit', 'stop the client']);
  const width = Math.max(...usage.map(([u]) => u.length));
  return ['Type chat, /command or:', ...usage.map(([u, h]) => `  ${u.padEnd(width)}  ${h}`)].join('\n');
}

async function execute(client: Client, line: string): Promise<void> {
  if (line.startsWith('/')) return client.command(line.slice(1));
  if (!line.startsWith(':')) return client.chat(line);
  const [name, ...args] = line.slice(1).split(/\s+/);
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) throw new CalciteError('unknown_command', `unknown command :${name} (:help lists them)`);
  const result = await command.run(client, args, line.slice(1 + name.length).trim());
  if (typeof result === 'string') out(result);
  else if (result !== undefined) out(JSON.stringify(result, null, 2));
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
      await execute(client, line);
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
    }
  }
  rl.close();
}
