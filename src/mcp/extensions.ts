import { z } from 'zod';
import { clientName, timeoutSeconds, tool, type ToolContext } from './shared.js';

/** Commands added by probe extensions and mods. */
export function registerExtensionTools({ server, manager }: ToolContext): void {
  tool(
    server,
    'list_extensions',
    {
      title: 'Extension commands',
      description:
        'Commands added by probe extensions and mods (name, description, JSON schema of the arguments) and the extension jars that were loaded (with load errors).',
      inputSchema: { client: clientName },
    },
    async ({ client }) => manager.resolve(client).extensions(),
  );

  tool(
    server,
    'call_extension',
    {
      title: 'Call an extension command',
      description: 'Runs a command from list_extensions with JSON arguments matching its schema and returns its result.',
      inputSchema: {
        client: clientName,
        name: z.string().min(1).describe('Command name from list_extensions, e.g. "hud.bossbars"'),
        args: z.record(z.string(), z.unknown()).optional().describe('Arguments object'),
        timeoutSeconds: timeoutSeconds(30),
      },
    },
    async ({ client, name, args, timeoutSeconds: seconds }) => manager.resolve(client).call(name, args ?? {}, { timeoutMs: seconds * 1000 }),
  );
}
