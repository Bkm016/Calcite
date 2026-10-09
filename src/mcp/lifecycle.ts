import { z } from 'zod';
import { defaultUsername, installVersion, type Account } from '../client.js';
import { getManifest } from '../mojang.js';
import { clientName, tool, type ToolContext } from './shared.js';

/** Launching, stopping and listing clients; versions. */
export function registerLifecycleTools({ server, manager, paths, defaults }: ToolContext): void {
  tool(
    server,
    'launch_client',
    {
      title: 'Launch a Minecraft client',
      description:
        'Downloads (if needed) and starts a Minecraft client, optionally joining a server. Resolves once the player is in the world (or on the title screen without a server).',
      inputSchema: {
        name: z
          .string()
          .regex(/^[A-Za-z0-9_.-]{1,32}$/)
          .describe('Unique client name; also the instance directory'),
        version: z.string().default('release').describe('Minecraft version id, "release" (latest release) or "snapshot"'),
        loader: z
          .string()
          .optional()
          .describe('Mod loader: "fabric", "forge" or "neoforge", optionally with a version ("fabric@0.19.5"); installed on first use'),
        mods: z
          .array(z.string())
          .optional()
          .describe(
            'Mods (needs loader): "modrinth:<project>[@version]" (with required dependencies), http(s) URLs of jars, or local jar/folder paths',
          ),
        extensions: z
          .array(z.string())
          .optional()
          .describe('Probe extension jars (local paths or http(s) URLs) that add commands and events; see list_extensions'),
        server: z.string().optional().describe('host[:port] to join'),
        username: z.string().optional().describe('Offline username (3-16 chars). Ignored when microsoft is set'),
        microsoft: z
          .union([z.boolean(), z.string()])
          .optional()
          .describe('Use a stored Microsoft account: true for the primary one or the profile name'),
        render: z
          .enum(['on-demand', 'always', 'off'])
          .optional()
          .describe('on-demand (default): render only for screenshots; always; off: no renderer at all'),
        memory: z
          .string()
          .regex(/^\d+[MG]$/)
          .optional()
          .describe('Max heap, e.g. "2G"'),
        reconnect: z.boolean().optional().describe('Relaunch and rejoin after a disconnect/crash (default true)'),
        timeoutSeconds: z.number().int().positive().optional().describe('Startup timeout (default 900)'),
      },
    },
    async (a) => {
      const account: Account = a.microsoft
        ? { type: 'microsoft', name: typeof a.microsoft === 'string' ? a.microsoft : undefined }
        : { type: 'offline', username: a.username ?? defaultUsername(a.name) };
      const client = await manager.launch({
        ...defaults,
        name: a.name,
        version: a.version,
        loader: a.loader,
        mods: a.mods,
        extensions: a.extensions ?? defaults.extensions,
        server: a.server,
        account,
        render: a.render ?? defaults.render,
        memory: a.memory ?? defaults.memory,
        reconnect: a.reconnect ?? defaults.reconnect,
        startTimeoutMs: a.timeoutSeconds ? a.timeoutSeconds * 1000 : defaults.startTimeoutMs,
      });
      return client.status();
    },
  );

  tool(
    server,
    'stop_client',
    { title: 'Stop a client', description: 'Stops the game and frees its resources.', inputSchema: { client: clientName } },
    async ({ client }) => {
      const target = manager.resolve(client);
      await manager.stop(target.options.name);
      return `Stopped ${target.options.name}`;
    },
  );

  tool(
    server,
    'list_clients',
    { title: 'List clients', description: 'Status of every client managed by this server.', inputSchema: {} },
    () => manager.list(),
  );

  tool(
    server,
    'get_state',
    {
      title: 'Client state',
      description: 'Lifecycle status plus live game state: screen, position, health, food, dimension, fps, disconnect reason.',
      inputSchema: { client: clientName },
    },
    async ({ client }) => {
      const target = manager.resolve(client);
      const status = target.status();
      if (status.probeConnected) {
        try {
          status.game = await target.state();
        } catch {
          // keep the last polled state
        }
      }
      return status;
    },
  );

  tool(
    server,
    'install_version',
    {
      title: 'Pre-download a version',
      description:
        'Downloads a version (client, libraries, assets, Java, optionally a mod loader) without launching, so the next launch is fast.',
      inputSchema: {
        version: z.string().default('release'),
        loader: z.string().optional().describe('Also install a mod loader: "fabric", "forge" or "neoforge", optionally "@<version>"'),
      },
    },
    async ({ version, loader }) => installVersion(version, { paths, loader }),
  );

  tool(
    server,
    'list_versions',
    {
      title: 'Available versions',
      description: "Minecraft versions from Mojang's manifest (newest first).",
      inputSchema: {
        type: z.enum(['release', 'snapshot', 'old_beta', 'old_alpha', 'all']).default('release'),
        limit: z.number().int().positive().default(30),
      },
    },
    async ({ type, limit }) => {
      const manifest = await getManifest(paths);
      const versions = manifest.versions.filter((v) => type === 'all' || v.type === type).slice(0, limit);
      return { latest: manifest.latest, versions: versions.map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime })) };
    },
  );
}
