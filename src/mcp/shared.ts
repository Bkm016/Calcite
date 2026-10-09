import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CalciteError, type ClientOptions } from '../client.js';
import type { ClientManager } from '../manager.js';
import type { CalcitePaths } from '../paths.js';
import type { BackgroundTasks } from './tasks.js';

export type Result = CallToolResult;

/** What every group of tools works with. */
export interface ToolContext {
  server: McpServer;
  manager: ClientManager;
  paths: CalcitePaths;
  tasks: BackgroundTasks;
  /** Defaults applied to launch_client calls. */
  defaults: Partial<ClientOptions>;
}

export function text(value: unknown): Result {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

export function failure(err: unknown): Result {
  const code = err instanceof CalciteError ? err.code : (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text: code ? `[${code}] ${message}` : message }] };
}

/** Wraps a handler so every failure becomes an MCP tool error instead of a protocol error. */
export function safe<A>(fn: (args: A) => Promise<Result>): (args: A) => Promise<Result> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return failure(err);
    }
  };
}

interface ToolConfig<S extends z.ZodRawShape> {
  title: string;
  description: string;
  inputSchema: S;
}

/** Registers a tool whose handler's return value is sent as JSON (or as is, for a string). */
export function tool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: ToolConfig<S>,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => unknown,
): void {
  const callback = safe(async (args: z.objectOutputType<S, z.ZodTypeAny>) => text(await handler(args)));
  // the SDK computes the argument type through its own zod compatibility layer, which TypeScript cannot relate to S
  server.registerTool(name, config, callback as unknown as ToolCallback<S>);
}

/** Requires all of x, y and z or none of them. */
export function optionalPoint(x?: number, y?: number, zz?: number): { x: number; y: number; z: number } | undefined {
  if (x === undefined && y === undefined && zz === undefined) return undefined;
  if (x === undefined || y === undefined || zz === undefined) throw new CalciteError('bad_request', 'Give all of x, y and z');
  return { x, y, z: zz };
}

export const clientName = z.string().optional().describe('Client name; may be omitted when exactly one client is running');

export const coord = z.number().describe('Block coordinate');

export const face = z
  .enum(['down', 'up', 'north', 'south', 'west', 'east'])
  .optional()
  .describe('Block face to target (default: the face nearest to the player)');

export const background = z
  .boolean()
  .default(false)
  .describe('Return at once and keep going; follow it with get_task, cancel it with stop_actions');

export const stopOnDamage = z.boolean().default(false).describe('Stop (reason "damaged") as soon as the player takes damage');

export const timeoutSeconds = (fallback: number, max = 600) => z.number().positive().max(max).default(fallback);

export const entityFilter = {
  radius: z.number().positive().optional().describe('Only entities within this many blocks of the player'),
  type: z.string().optional().describe('Entity type id, e.g. "minecraft:player" or "zombie"'),
  uuid: z.string().optional(),
  name: z.string().optional().describe('Case-insensitive substring of the name or custom name'),
  limit: z.number().int().positive().max(1000).optional(),
  includeSelf: z.boolean().optional(),
};
