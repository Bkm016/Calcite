import { z } from 'zod';
import { background, clientName, timeoutSeconds, tool, type ToolContext } from './shared.js';

/** The inventory, containers and crafting. */
export function registerItemTools({ server, manager, tasks }: ToolContext): void {
  tool(
    server,
    'get_inventory',
    {
      title: 'Inventory',
      description: 'Non-empty inventory slots (0-8 hotbar, 9-35 main, 36-39 armor, 40 offhand) and the selected hotbar slot.',
      inputSchema: { client: clientName },
    },
    async ({ client }) => manager.resolve(client).inventory(),
  );

  tool(
    server,
    'select_slot',
    {
      title: 'Select hotbar slot',
      description: 'Selects hotbar slot 0-8 (the held item).',
      inputSchema: { client: clientName, slot: z.number().int().min(0).max(8) },
    },
    async ({ client, slot }) => manager.resolve(client).selectSlot(slot),
  );

  tool(
    server,
    'craft',
    {
      title: 'Craft an item',
      description:
        'Crafts an item from ingredients in the inventory through the recipe book. 2×2 recipes use the inventory grid; bigger ones need a crafting table within reach (opened and closed automatically). Only recipes the player has unlocked are known — they unlock on first picking up an ingredient.',
      inputSchema: {
        client: clientName,
        item: z.string().min(1).describe('Item id, e.g. "oak_planks" or "minecraft:stick"'),
        count: z
          .number()
          .int()
          .positive()
          .max(64 * 36)
          .default(1)
          .describe('How many items to make (recipes making several may give a few more)'),
        background,
        timeoutSeconds: timeoutSeconds(30),
      },
    },
    async ({ client, item, count, background: bg, timeoutSeconds: seconds }) => {
      const target = manager.resolve(client);
      return tasks.run(target, 'craft', bg, () => target.craft(item, { count, timeoutMs: seconds * 1000 }));
    },
  );

  tool(
    server,
    'get_container',
    {
      title: 'Open container',
      description:
        'The open container (chest, barrel, furnace, villager trades...) with its non-empty slots; slots 0..containerSlots-1 are the container, the rest the player inventory. Furnaces also report lit, progress and fuel. waitSeconds waits for one to open, e.g. right after use on a chest.',
      inputSchema: { client: clientName, waitSeconds: z.number().min(0).max(30).default(0) },
    },
    async ({ client, waitSeconds }) => manager.resolve(client).container({ waitMs: waitSeconds * 1000 }),
  );

  tool(
    server,
    'transfer',
    {
      title: 'Move items',
      description:
        'Moves items of one kind between the open container and the inventory. Without count and slot whole stacks are shift-clicked and the game picks the slots (a furnace takes fuel into its fuel slot and ores into its input); otherwise up to count items go into slot (or the first slots that take them). For a furnace: slot 0 input, 1 fuel, 2 output.',
      inputSchema: {
        client: clientName,
        item: z.string().min(1).describe('Item id, e.g. "coal"'),
        to: z.enum(['container', 'inventory']).default('container'),
        count: z.number().int().positive().optional(),
        slot: z.number().int().nonnegative().optional().describe('Target menu slot'),
      },
    },
    async ({ client, item, ...opts }) => manager.resolve(client).transfer(item, opts),
  );

  tool(
    server,
    'click_slot',
    {
      title: 'Click a container slot',
      description:
        'Clicks a slot of the open container (or of the inventory when none is open) and returns the new contents. mode: pickup (button 0 left / 1 right), quick_move (shift click: move the stack between container and inventory), swap (button = hotbar slot 0-8, 40 offhand), throw (button 1 = whole stack), clone, quick_craft, pickup_all. Slot -999 clicks outside (drops the carried stack).',
      inputSchema: {
        client: clientName,
        slot: z.number().int().min(-999),
        button: z.number().int().min(0).max(40).default(0),
        mode: z.enum(['pickup', 'quick_move', 'swap', 'clone', 'throw', 'quick_craft', 'pickup_all']).default('pickup'),
      },
    },
    async ({ client, slot, button, mode }) => manager.resolve(client).click(slot, { button, mode }),
  );

  tool(
    server,
    'close_container',
    { title: 'Close container', description: 'Closes the open container or screen.', inputSchema: { client: clientName } },
    async ({ client }) => {
      await manager.resolve(client).closeContainer();
      return 'closed';
    },
  );

  tool(
    server,
    'drop_item',
    {
      title: 'Drop item',
      description: 'Drops one item, or the whole stack, from the selected hotbar slot.',
      inputSchema: { client: clientName, all: z.boolean().default(false) },
    },
    async ({ client, all }) => manager.resolve(client).drop({ all }),
  );
}
