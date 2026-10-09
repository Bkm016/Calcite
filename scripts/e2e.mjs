// Shared harness of the end-to-end scripts: starts one bot against a real server, runs a scenario and reports.
// Arguments: <version> [host:port | paper | world] [name]. "paper" (the default) runs a managed Paper server from
// scripts/paper-server.mjs (cached in CALCITE_E2E_DIR, default .e2e/paper); "world" plays a fresh singleplayer world;
// an external server must make the bot an operator and turn spawn protection off.
// CALCITE_RENDER=off|on-demand|always, CALCITE_LOADER=fabric|forge|neoforge[@version], CALCITE_MODS=spec,spec
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '../dist/index.js';
import { startTestServer } from './paper-server.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls {@code fn} until it returns something truthy or the time is up; returns its last value. */
export async function until(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > deadline) return v;
    await sleep(200);
  }
}

/**
 * Runs {@code scenario(t)} with a started client and exits non-zero when a check failed.
 * {@code t}: client, check(label, ok, detail), cmd(command), base {x, y, z} (a stone platform is built there).
 */
export async function runE2E(title, scenario, { platformRadius = 8 } = {}) {
  const [version = '1.21.11', target = 'paper', name = 'ActBot'] = process.argv.slice(2);
  const managed =
    target === 'paper' ? await startTestServer({ dir: process.env.CALCITE_E2E_DIR ?? '.e2e/paper', operators: [name] }) : undefined;
  const singleplayer = target === 'world';
  const client = new Client({
    name,
    version,
    server: singleplayer ? undefined : (managed?.address ?? target),
    world: singleplayer ? { name: 'calcite-e2e' } : undefined,
    render: process.env.CALCITE_RENDER ?? 'off',
    account: { type: 'offline', username: name.slice(0, 16) },
    loader: process.env.CALCITE_LOADER,
    mods: process.env.CALCITE_MODS ? process.env.CALCITE_MODS.split(',') : undefined,
  });
  client.on('phase', (p) => console.log(`[phase] ${p}`));
  const failures = [];
  const t = {
    client,
    check(label, ok, detail) {
      console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
      if (!ok) failures.push(label);
    },
    async cmd(command) {
      await client.command(command);
      await sleep(150);
    },
  };
  try {
    if (singleplayer) await rm(join(client.gameDir, 'saves', 'calcite-e2e'), { recursive: true, force: true });
    const started = await client.start();
    if (started.loader) console.log(`loader ${started.loader}, mods ${JSON.stringify(started.mods ?? [])}`);
    const p = (await client.state()).player;
    // y=100: clients older than 1.18 do not receive blocks below y=0 through ViaBackwards
    const base = { x: Math.floor(p.x), y: 100, z: Math.floor(p.z) };
    console.log(`base ${base.x} ${base.y} ${base.z}`);
    const r = platformRadius;
    if (singleplayer) {
      // what scripts/paper-server.mjs configures for its server
      for (const c of ['difficulty peaceful', 'time set day', 'gamerule immediate_respawn true']) await t.cmd(c);
    }
    await t.cmd('gamemode survival');
    await t.cmd('clear');
    await t.cmd(`fill ${base.x - r} ${base.y - 1} ${base.z - r} ${base.x + r} ${base.y - 1} ${base.z + r} stone`);
    await t.cmd(`fill ${base.x - r} ${base.y} ${base.z - r} ${base.x + r} ${base.y + 3} ${base.z + r} air`);
    await t.cmd(`kill @e[type=!player,distance=..${r * 2}]`);
    await t.cmd(`tp @s ${base.x + 0.5} ${base.y} ${base.z + 0.5}`);
    await sleep(500);
    t.base = base;
    await scenario(t);
    await client.stopActions();
    console.log(failures.length ? `${title} FAILED: ${failures.join(', ')}` : `${title} OK`);
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    console.error(`${title} FAILED:`, err.code ?? '', err.message);
    console.error(
      client
        .logsSince({ limit: 30 })
        .map((l) => `  ${l.source}: ${l.line}`)
        .join('\n'),
    );
    process.exitCode = 1;
  } finally {
    await client.stop();
    await managed?.stop();
  }
}
