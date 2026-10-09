import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp/index.js';
import { tempDir } from './helpers.mjs';

/** An MCP client connected in memory to a fresh server whose Calcite home is a temporary directory. */
async function connected(t) {
  const saved = process.env.CALCITE_HOME;
  process.env.CALCITE_HOME = await tempDir(t, 'calcite-mcp-');
  t.after(() => (saved === undefined ? delete process.env.CALCITE_HOME : (process.env.CALCITE_HOME = saved)));
  const { server, manager } = createMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(clientSide);
  t.after(async () => {
    await mcp.close();
    await manager.stopAll();
  });
  const call = async (name, args = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    return { error: r.isError === true, text: r.content.map((c) => c.text).join('\n') };
  };
  return { mcp, call };
}

test('every tool is documented and has an object schema', async (t) => {
  const { mcp } = await connected(t);
  const instructions = mcp.getInstructions() ?? '';
  assert.match(instructions, /launch_client/);
  const { tools } = await mcp.listTools();
  assert.ok(tools.length >= 30, `${tools.length} tools`);
  const names = new Set(tools.map((x) => x.name));
  for (const name of ['launch_client', 'stop_client', 'get_state', 'surroundings', 'walk_to', 'craft', 'wait_for', 'account_list']) {
    assert.ok(names.has(name), `missing ${name}`);
  }
  for (const x of tools) {
    assert.match(x.name, /^[a-z_]+$/, x.name);
    assert.ok(x.title && x.description.length > 10, `${x.name} needs a title and a description`);
    assert.equal(x.inputSchema.type, 'object', x.name);
  }
  // every tool the instructions mention exists
  for (const [, name] of instructions.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)) assert.ok(names.has(name), `instructions mention ${name}`);
});

test('tools report failures as tool errors with a code', async (t) => {
  const { call } = await connected(t);
  assert.deepEqual(await call('list_clients'), { error: false, text: '[]' });
  const state = await call('get_state');
  assert.equal(state.error, true);
  assert.match(state.text, /^\[\w+\] /);
  const stop = await call('stop_client', { client: 'nobody' });
  assert.equal(stop.error, true);
  assert.match(stop.text, /nobody/);
  const invalid = await call('launch_client', { name: 'bad name!' });
  assert.equal(invalid.error, true);
  assert.match(invalid.text, /name/);
});

test('account tools work against an empty store', async (t) => {
  const { call } = await connected(t);
  const list = await call('account_list');
  assert.equal(list.error, false);
  assert.deepEqual(JSON.parse(list.text), []);
  assert.deepEqual(await call('account_remove', { account: 'ghost' }), {
    error: true,
    text: '[unknown_account] No stored account named "ghost"',
  });
});
