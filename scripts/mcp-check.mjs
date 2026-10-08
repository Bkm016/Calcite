// Starts `calcite mcp` over stdio and exercises the tool list (plus an optional live session).
// Usage: node scripts/mcp-check.mjs [server host:port] [version]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFile } from 'node:fs/promises';

const [server, version = '1.21.11'] = process.argv.slice(2);
const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('../dist/cli.js', import.meta.url).pathname, 'mcp'], stderr: 'inherit' });
const mcp = new Client({ name: 'mcp-check', version: '0' });
await mcp.connect(transport);
const call = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 20 * 60_000 });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`--- ${name}${r.isError ? ' (ERROR)' : ''}: ${t.slice(0, 600)}`);
  return r;
};
const { tools } = await mcp.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
await call('list_versions', { limit: 3 });
await call('account_list');
await call('get_state');
if (server) {
  await call('launch_client', { name: 'McpBot', version, server });
  await call('get_state', { client: 'McpBot' });
  await call('get_entities', { radius: 32, limit: 3 });
  await call('send_chat', { message: 'hi from mcp' });
  await call('wait_for', { chat: 'hi from mcp', timeoutSeconds: 10 });
  await call('run_command', { command: '/list' });
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    const shot = await call('screenshot');
    const img = shot.content.find((c) => c.type === 'image');
    console.log(`    screenshot ${i}: ${Date.now() - t}ms ${img ? Buffer.from(img.data, 'base64').length + ' bytes' : 'none'}`);
    if (img) await writeFile('/tmp/calcite-mcp.png', Buffer.from(img.data, 'base64'));
  }
  await call('stop_client');
}
await mcp.close();
