import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ClientOptions } from '../client.js';
import { ClientManager } from '../manager.js';
import { resolvePaths } from '../paths.js';
import { VERSION } from '../version.js';
import { registerAccountTools } from './accounts.js';
import { registerActTools } from './act.js';
import { registerExtensionTools } from './extensions.js';
import { registerItemTools } from './items.js';
import { registerLifecycleTools } from './lifecycle.js';
import { registerObserveTools } from './observe.js';
import type { ToolContext } from './shared.js';
import { BackgroundTasks } from './tasks.js';

export interface McpOptions {
  /** Defaults applied to launch_client calls. */
  defaults?: Partial<ClientOptions>;
}

const INSTRUCTIONS = `Calcite drives real Minecraft Java Edition clients (1.14.4+ fully; older versions launch without probe features).

Flow: launch_client (the first launch of a version downloads ~0.5-1 GB and can take minutes) → observe and act → stop_client.

Observe: surroundings gives a map of the area with nearby blocks and entities — start there. find_blocks locates resources, get_entities lists entities with ids, get_state shows health, food and position, screenshot shows the view.

Act: walk_to finds a path to a point; dig mines, attack and use (right click: chests, doors, placing blocks, eating) take entity ids or block coordinates. get_inventory, craft and select_slot handle items; get_container, transfer and click_slot work with chests and furnaces.

Long actions (walk_to, dig, craft) accept background: true — follow them with get_task, cancel with stop_actions, and pass stopOnDamage to stop when attacked. One action runs at a time; starting another cancels the running one.

Events: get_events and wait_for {event} report world.join, player.hurt, player.death, inventory.change, container.open and more, plus events from extensions.

Accounts: offline accounts need no login. For premium servers call account_login_start, show the URL to the user, then poll account_login_status.

Screenshots need render "on-demand" (default) or "always". Mods: launch_client with loader "fabric", "forge" or "neoforge" and mods such as "modrinth:fabric-api". Extensions (probe jars) add commands: list_extensions, call_extension.`;

export function createMcpServer(opts: McpOptions = {}): { server: McpServer; manager: ClientManager } {
  const server = new McpServer({ name: 'calcite', version: VERSION }, { instructions: INSTRUCTIONS });
  const manager = new ClientManager();
  const ctx: ToolContext = { server, manager, paths: resolvePaths(), tasks: new BackgroundTasks(), defaults: opts.defaults ?? {} };
  registerLifecycleTools(ctx);
  registerObserveTools(ctx);
  registerActTools(ctx);
  registerItemTools(ctx);
  registerExtensionTools(ctx);
  registerAccountTools(ctx);
  return { server, manager };
}

/** Runs the MCP server over stdio until the client disconnects. stdout carries only protocol messages. */
export async function runMcpStdio(opts: McpOptions = {}): Promise<void> {
  const { server, manager } = createMcpServer(opts);
  const transport = new StdioServerTransport();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await manager.stopAll();
    process.exit(0);
  };
  transport.onclose = () => void close();
  process.stdin.once('end', () => void close());
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  await server.connect(transport);
}
