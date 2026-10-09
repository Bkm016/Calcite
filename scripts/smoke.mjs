// End-to-end smoke test against a real server.
// Usage: node scripts/smoke.mjs <version> <host:port> [name] [render]
import { writeFile } from 'node:fs/promises';
import { Client } from '../dist/index.js';

const [version = '1.21.11', server = 'localhost:25565', name = 'CalciteSmoke', render = 'on-demand'] = process.argv.slice(2);
const client = new Client({ name, version, server, render, account: { type: 'offline', username: name.slice(0, 16) } });
client.on('phase', (p) => console.log(`[phase] ${p}`));
client.on('state', (s) =>
  console.log(
    `[state] screen=${s.screen} inGame=${s.inGame} ready=${s.ready} fps=${s.fps}${s.disconnectReason ? ` reason=${s.disconnectReason}` : ''}`,
  ),
);
client.on('chat', (c) => console.log(`[chat] ${c.message}`));

const started = Date.now();
try {
  await client.start();
  console.log(`started in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const state = await client.state();
  console.log('state:', JSON.stringify(state));
  const ents = await client.entities({ radius: 64, limit: 5 });
  console.log(`entities (${ents.length}):`, JSON.stringify(ents.slice(0, 3)));
  await client.chat(`hello from calcite ${version}`);
  await client.waitFor({ chat: `hello from calcite` }, 10_000).then((r) => console.log('chat echo:', r.chat?.message));
  if (!client.headless) {
    const shot = await client.screenshot();
    const out = `/tmp/calcite-smoke-${version}.png`;
    await writeFile(out, shot.png);
    console.log(`screenshot ${shot.png.length} bytes -> ${out}`);
  }
  console.log('SMOKE OK', JSON.stringify(client.status().game?.player));
} catch (err) {
  console.error('SMOKE FAILED:', err.message);
  console.error(
    client
      .logsSince({ limit: 40 })
      .map((l) => `  ${l.source}: ${l.line}`)
      .join('\n'),
  );
  process.exitCode = 1;
} finally {
  await client.stop();
}
