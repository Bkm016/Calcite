// End-to-end check of the agent-level features: events, surroundings, block search, path finding, long actions
// (progress, cancel, stop on damage), crafting and furnaces. Usage: node scripts/agent-smoke.mjs <version> <host:port> [name]
import { runE2E, sleep, until } from './e2e.mjs';

const count = (inv, id) => inv.items.filter((i) => i.id === `minecraft:${id}`).reduce((n, i) => n + i.count, 0);

await runE2E(
  'AGENT',
  async (t) => {
    const { client, check, cmd } = t;
    const { x: bx, y: by, z: bz } = t.base;

    check('world.join event', client.eventsSince({ name: '^world\\.join$' }).length > 0);
    let since = client.lastSeq;
    await cmd('give @s oak_log 3');
    const gave = await until(() => client.eventsSince({ since, name: '^inventory\\.change$' })[0], 3000);
    check('inventory.change event', !!gave, gave?.data);

    // a wall across the direct line to the goal, open at its south end
    await cmd(`fill ${bx + 3} ${by} ${bz - 6} ${bx + 3} ${by + 2} ${bz + 3} stone`);
    await cmd(`setblock ${bx - 4} ${by} ${bz - 4} gold_block`);
    await sleep(500);

    const around = await client.surroundings({ radius: 6 });
    const center = around.map[6]?.[6];
    check('surroundings map is centred on the player', around.map.length === 13 && center === '@', around.map);
    check(
      'surroundings shows the wall',
      around.map.some((row) => row[9] === '#'),
      around.map,
    );
    check('surroundings knows the ground', around.standingOn === 'minecraft:stone' && !!around.facing, {
      on: around.standingOn,
      facing: around.facing,
    });

    const found = await client.findBlocks({ blocks: 'gold_*', radius: 16 });
    const gold = found.blocks[0];
    check('find_blocks finds the gold block', gold?.x === bx - 4 && gold?.y === by && gold?.z === bz - 4, found);

    const around1 = await client.walkTo(bx + 6.5, bz + 0.5);
    check('walk_to finds a way around the wall', around1.arrived, around1);

    const walking = client.walkTo(bx + 0.5, bz + 0.5);
    const progress = await until(async () => {
      const task = await client.task();
      return task.running ? task : undefined;
    }, 3000);
    check('task reports the running walk', progress?.name === 'walk_to', progress);
    check('walk back arrives', (await walking).arrived);

    const cancelled = client.walkTo(bx - 7.5, bz + 0.5).catch((err) => err);
    await sleep(400);
    await client.stopActions();
    const err = await cancelled;
    check('stop_actions cancels a walk', err?.code === 'cancelled', err?.message);

    since = client.lastSeq;
    const hurtWalk = client.walkTo(bx + 0.5, bz - 6.5, { stopOnDamage: true });
    await sleep(400);
    await cmd('effect give @s instant_damage 1 0');
    const hurt = await hurtWalk;
    check('stopOnDamage stops the walk', !hurt.arrived && hurt.reason === 'damaged', hurt);
    const hurtEvent = await until(() => client.eventsSince({ since, name: '^player\\.hurt$' })[0], 3000);
    check('player.hurt event', !!hurtEvent, hurtEvent?.data);
    await cmd('effect give @s instant_health 1 1');

    await cmd('recipe give @s *');
    await cmd('clear');
    await cmd('give @s oak_log 2');
    await sleep(500);
    const planks = await client.craft('oak_planks', { count: 8 });
    let inv = await client.inventory();
    check('craft planks in the inventory grid', planks.crafted === 8 && count(inv, 'oak_planks') === 8, { planks, items: inv.items });
    const table = await client.craft('crafting_table');
    const sticks = await client.craft('stick');
    inv = await client.inventory();
    check('craft table and sticks', table.crafted === 1 && sticks.crafted === 4 && count(inv, 'stick') === 4, inv.items);

    const noTable = await client.craft('wooden_pickaxe').catch((e) => e);
    check('a 3×3 recipe needs a table', noTable?.code === 'needs_crafting_table', noTable?.message);
    await cmd(`setblock ${bx - 1} ${by} ${bz - 1} crafting_table`);
    await cmd('give @s oak_planks 3');
    await sleep(500);
    const pickaxe = await client.craft('wooden_pickaxe');
    inv = await client.inventory();
    const container = await client.container();
    check('craft at a nearby table', pickaxe.crafted === 1 && count(inv, 'wooden_pickaxe') === 1 && !container.open, {
      pickaxe,
      items: inv.items,
    });

    await cmd(`setblock ${bx + 1} ${by} ${bz - 1} furnace`);
    await cmd('give @s cobblestone 2');
    await cmd('give @s coal 1');
    await sleep(500);
    since = client.lastSeq;
    await client.use({ block: { x: bx + 1, y: by, z: bz - 1 } });
    await client.container({ waitMs: 3000 });
    const input = await client.transfer('cobblestone', { count: 1, slot: 0 });
    const fuel = await client.transfer('coal');
    const lit = await until(async () => {
      const c = await client.container();
      return c.furnace?.lit ? c : undefined;
    }, 5000);
    check('transfer fills a furnace', input.moved === 1 && fuel.moved === 1 && !!lit, {
      input: input.moved,
      fuel: fuel.moved,
      furnace: lit?.furnace,
    });
    await client.closeContainer();
    await sleep(500);
    const opened = client.eventsSince({ since, name: '^container\\.(open|close)$' }).map((e) => e.name);
    check('container events', opened.includes('container.open') && opened.includes('container.close'), opened);
  },
  { platformRadius: 10 },
);
