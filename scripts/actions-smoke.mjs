// End-to-end check of the basic player actions against a real server (1.17+ server; the bot must be an operator).
// Usage: node scripts/actions-smoke.mjs <version> <host:port> [name]; see scripts/e2e.mjs for the environment.
import { runE2E, sleep, until } from './e2e.mjs';

const slotOf = (inv, id) => inv.items.find((i) => i.id === id && i.slot < 9)?.slot;

await runE2E('ACTIONS', async (t) => {
  const { client } = t;
  const { x: bx, y: by, z: bz } = t.base;
  await t.cmd(`setblock ${bx + 2} ${by} ${bz} dirt`);
  await t.cmd(`setblock ${bx} ${by} ${bz + 2} chest`);
  await t.cmd(`item replace block ${bx} ${by} ${bz + 2} container.0 with diamond 5`);
  await t.cmd('give @s diamond_sword');
  await t.cmd('give @s oak_planks 16');
  await t.cmd(`summon pig ${bx - 1.5} ${by} ${bz + 0.5} {NoAI:1b}`);
  await sleep(1000);

  const state = await client.state();
  t.check('state has food and game mode', state.player.food === 20 && state.player.gameMode === 'survival', {
    food: state.player.food,
    gameMode: state.player.gameMode,
  });

  const look = await client.look({ yaw: 90, pitch: 10 });
  t.check('look sets rotation', Math.abs(look.yaw - 90) < 0.01 && Math.abs(look.pitch - 10) < 0.01, look);

  const before = await client.block({ x: bx + 2, y: by, z: bz });
  const dug = await client.dig({ x: bx + 2, y: by, z: bz });
  const after = await until(async () => {
    const b = await client.block({ x: bx + 2, y: by, z: bz });
    return b.air ? b : undefined;
  });
  t.check('dig breaks dirt in survival', before.id === 'minecraft:dirt' && dug.broken && dug.ticks > 5 && !!after, {
    dug,
    before: before.id,
  });

  let inv = await client.inventory();
  t.check(
    'inventory lists given items',
    slotOf(inv, 'minecraft:diamond_sword') !== undefined && slotOf(inv, 'minecraft:oak_planks') !== undefined,
    inv.items,
  );

  const planks = slotOf(inv, 'minecraft:oak_planks');
  const sel = await client.selectSlot(planks);
  t.check('select slot', sel.selected === planks && sel.item?.id === 'minecraft:oak_planks', sel);
  await sleep(200);
  const placed = await client.use({ block: { x: bx, y: by - 1, z: bz - 2, face: 'up' } });
  const plank = await until(async () => {
    const b = await client.block({ x: bx, y: by, z: bz - 2 });
    return b.id === 'minecraft:oak_planks' ? b : undefined;
  });
  t.check('use places a block', !!plank, placed);

  const target = await client.target();
  t.check('target reports a block', target.type === 'block', target);

  const walk = await client.walkTo(bx + 6.5, bz + 0.5);
  t.check('walk_to arrives', walk.arrived && Math.abs(walk.x - (bx + 6.5)) < 1, walk);
  const back = await client.walkTo(bx + 0.5, bz + 0.5, { range: 0.4 });
  t.check('walk_to back', back.arrived, back);

  const p = (await client.state()).player;
  await client.move({ back: true }, { ticks: 6 });
  await sleep(800);
  const moved = (await client.state()).player;
  const dist = Math.hypot(moved.x - p.x, moved.z - p.z);
  t.check('move holds keys for n ticks', dist > 0.5 && dist < 3, { dist });
  await client.walkTo(bx + 0.5, bz + 0.5, { range: 0.4 });

  inv = await client.inventory();
  await client.selectSlot(slotOf(inv, 'minecraft:diamond_sword'));
  await sleep(200);
  const pig = (await client.entities({ type: 'pig', radius: 8 }))[0];
  t.check('pig found', !!pig);
  let hits = 0;
  if (pig) {
    for (; hits < 6; hits++) {
      if (!(await client.entities({ uuid: pig.uuid })).length) break;
      await client.attack(pig.id).catch((e) => console.log('attack:', e.message));
      await sleep(900);
    }
  }
  const pigGone = pig && (await until(async () => (await client.entities({ uuid: pig.uuid })).length === 0, 3000));
  t.check('attack kills a pig', !!pigGone, { hits });

  const opened = await client.use({ block: { x: bx, y: by, z: bz + 2 } });
  const chest = await client.container({ waitMs: 3000 });
  t.check('use opens a chest', chest.open && chest.containerSlots === 27 && chest.items?.[0]?.id === 'minecraft:diamond', {
    opened,
    type: chest.type,
    title: chest.title,
    first: chest.items?.[0],
  });
  const moved2 = await client.click(0, { mode: 'quick_move' });
  t.check(
    'quick_move takes the diamonds',
    !moved2.items.some((i) => i.slot < moved2.containerSlots && i.id === 'minecraft:diamond'),
    moved2.items,
  );
  await client.closeContainer();
  await sleep(300);
  const closed = await client.container();
  inv = await client.inventory();
  t.check(
    'chest closed, diamonds in inventory',
    !closed.open && inv.items.some((i) => i.id === 'minecraft:diamond' && i.count === 5),
    inv.items,
  );

  await client.selectSlot(planks);
  await sleep(200);
  const dropped = await client.drop();
  const item = await until(async () => (await client.entities({ type: 'item', radius: 6 })).length > 0, 3000);
  t.check('drop throws an item', dropped.id === 'minecraft:oak_planks' && dropped.count === 1 && !!item, dropped);
});
