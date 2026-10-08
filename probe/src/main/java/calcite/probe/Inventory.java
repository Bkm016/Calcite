package calcite.probe;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import calcite.probe.Game.ProbeException;

/** The player's inventory, the hotbar, and open containers (chests, furnaces, ...). */
final class Inventory {

    private final Game game;
    private final Ref ref;
    private final World world;

    Inventory(Game game, Ref ref, World world) {
        this.game = game;
        this.ref = ref;
        this.world = world;
    }

    Map<String, Object> inventory() throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            Object player = game.requirePlayer(mc);
            Object inv = playerInventory(player);
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("selected", selectedSlot(inv));
            List<Map<String, Object>> items = new ArrayList<Map<String, Object>>();
            int size = Ref.intValue(game.optCall(inv, "getContainerSize"), 41);
            Method getItem = ref.method(inv.getClass(), "getItem", 1, "int");
            for (int i = 0; i < size; i++) {
                Map<String, Object> item = item(getItem.invoke(inv, i));
                if (item != null) {
                    Map<String, Object> m = new LinkedHashMap<String, Object>();
                    m.put("slot", i);
                    m.putAll(item);
                    items.add(m);
                }
            }
            out.put("items", items);
            out.put("slots", "0-8 hotbar, 9-35 main, 36-39 armor (feet..head), 40 offhand");
            return out;
        }, 5000);
    }

    Map<String, Object> selectSlot(final int slot) throws Exception {
        if (slot < 0 || slot > 8) {
            throw new ProbeException("bad_request", "Hotbar slot must be 0-8");
        }
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            Object inv = playerInventory(game.requirePlayer(mc));
            if (!game.invoke(inv, "setSelectedSlot", slot)) {
                ref.setIfPresent(inv, "selected", slot); // the client sends the change on its next tick
            }
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("selected", slot);
            Method getItem = ref.method(inv.getClass(), "getItem", 1, "int");
            out.put("item", item(getItem.invoke(inv, slot)));
            return out;
        }, 5000);
    }

    private Object playerInventory(Object player) {
        Object inv = game.optCall(player, "getInventory");
        if (inv == null) {
            inv = game.optGet(player, "inventory");
        }
        if (inv == null) {
            throw new ProbeException("unsupported", "Player inventory not found");
        }
        return inv;
    }

    private int selectedSlot(Object inv) {
        Object v = game.optCall(inv, "getSelectedSlot");
        if (v == null) {
            v = game.optGet(inv, "selected");
        }
        return Ref.intValue(v, 0);
    }

    /** id/count/name of a stack, or null for an empty one. */
    private Map<String, Object> item(Object stack) {
        if (stack == null || Boolean.TRUE.equals(game.optCall(stack, "isEmpty"))) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("id", world.registryKey("ITEM", game.optCall(stack, "getItem")));
        m.put("count", game.optCall(stack, "getCount"));
        m.put("name", game.text(game.optCall(stack, "getHoverName")));
        int max = Ref.intValue(game.optCall(stack, "getMaxDamage"), 0);
        if (max > 0) {
            m.put("damage", game.optCall(stack, "getDamageValue"));
            m.put("maxDamage", max);
        }
        return m;
    }

    // ---------------------------------------------------------------- containers

    /** The open container (chest, furnace, ...) or the player's inventory menu; optionally waits for one to open. */
    Map<String, Object> container(long waitMs) throws Exception {
        final Object mc = game.requireMinecraft();
        long deadline = System.currentTimeMillis() + waitMs;
        while (true) {
            Map<String, Object> state = game.onGameThread(() -> containerState(mc), 5000);
            if (Boolean.TRUE.equals(state.get("open")) || System.currentTimeMillis() >= deadline) {
                return state;
            }
            Thread.sleep(50);
        }
    }

    private Map<String, Object> containerState(Object mc) throws Exception {
        Object player = game.requirePlayer(mc);
        Object menu = game.optGet(player, "containerMenu");
        Object inventoryMenu = game.optGet(player, "inventoryMenu");
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        boolean open = menu != null && menu != inventoryMenu;
        out.put("open", open);
        if (menu == null) {
            return out;
        }
        out.put("containerId", game.optGet(menu, "containerId"));
        if (open) {
            Object type = game.optCall(menu, "getType");
            out.put("type", type == null ? null : world.registryKey("MENU", type));
        }
        Object screen = game.screen(mc);
        if (screen != null) {
            out.put("title", game.text(game.optCall(screen, "getTitle")));
        }
        Class<?> inventoryClass = ref.cls("net.minecraft.world.entity.player.Inventory");
        List<?> slots = (List<?>) game.optGet(menu, "slots");
        List<Map<String, Object>> items = new ArrayList<Map<String, Object>>();
        int containerSlots = 0;
        for (int i = 0; i < slots.size(); i++) {
            Object slot = slots.get(i);
            Object container = game.optGet(slot, "container");
            boolean playerSlot = inventoryClass != null && inventoryClass.isInstance(container);
            if (!playerSlot) {
                containerSlots++;
            }
            Map<String, Object> item = item(game.optCall(slot, "getItem"));
            if (item != null) {
                Map<String, Object> m = new LinkedHashMap<String, Object>();
                m.put("slot", i);
                m.putAll(item);
                if (playerSlot) {
                    m.put("inventorySlot", game.optGet(slot, "slot"));
                }
                items.add(m);
            }
        }
        out.put("size", slots.size());
        out.put("containerSlots", containerSlots);
        out.put("items", items);
        Map<String, Object> carried = item(game.optCall(menu, "getCarried"));
        if (carried != null) {
            out.put("carried", carried);
        }
        return out;
    }

    /**
     * Clicks a slot of the open menu (the player's inventory when none is open). {@code mode}: pickup (default),
     * quick_move (shift click), swap (button = hotbar slot 0-8, 40 = offhand), clone, throw (button 1 = whole
     * stack), quick_craft, pickup_all. Slot -999 clicks outside the window (drops the carried stack).
     */
    Map<String, Object> click(final int slot, final int button, final String mode) throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            Object player = game.requirePlayer(mc);
            Object menu = game.optGet(player, "containerMenu");
            List<?> slots = (List<?>) game.optGet(menu, "slots");
            if (slot != -999 && (slot < 0 || slot >= slots.size())) {
                throw new ProbeException("bad_request", "Slot must be 0-" + (slots.size() - 1) + " or -999");
            }
            Class<?> typeClass = ref.cls("net.minecraft.world.inventory.ContainerInput", "net.minecraft.world.inventory.ClickType");
            Object type;
            try {
                type = ref.getStatic(typeClass, mode.toUpperCase(Locale.ROOT));
            } catch (NoSuchFieldException e) {
                throw new ProbeException("bad_request", "Unknown click mode " + mode);
            }
            Object gameMode = game.optGet(mc, "gameMode");
            Object id = game.optGet(menu, "containerId");
            Method m = ref.method(gameMode.getClass(), "handleContainerInput", 5);
            if (m == null) {
                m = ref.method(gameMode.getClass(), "handleInventoryMouseClick", 5);
            }
            if (m == null) {
                throw new ProbeException("unsupported", "No container click API in this version");
            }
            m.invoke(gameMode, id, slot, button, type, player);
            return containerState(mc);
        }, 5000);
    }

    void closeContainer() throws Exception {
        final Object mc = game.requireMinecraft();
        game.onGameThread(() -> {
            Object player = game.requirePlayer(mc);
            if (game.optGet(player, "containerMenu") != game.optGet(player, "inventoryMenu")) {
                ref.callOrFail(player, "closeContainer");
            } else if (game.screen(mc) != null) {
                game.setScreen(mc, null);
            }
            return null;
        }, 5000);
    }

    /** Drops the selected hotbar item (one, or the whole stack), like pressing Q. */
    Map<String, Object> drop(final boolean all) throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            Object player = game.requirePlayer(mc);
            Object inv = playerInventory(player);
            int selected = selectedSlot(inv);
            Method getItem = ref.method(inv.getClass(), "getItem", 1, "int");
            Map<String, Object> dropped = item(getItem.invoke(inv, selected));
            if (dropped == null) {
                throw new ProbeException("empty_hand", "Nothing in the selected hotbar slot");
            }
            Method drop = ref.method(player.getClass(), "drop", 1, "boolean");
            if (drop != null) {
                drop.invoke(player, all);
            } else {
                // 26.x: throw the stack out of the matching slot of the open menu
                Object menu = game.optGet(player, "containerMenu");
                List<?> slots = (List<?>) game.optGet(menu, "slots");
                int index = -1;
                for (int i = 0; i < slots.size(); i++) {
                    Object s = slots.get(i);
                    if (game.optGet(s, "container") == inv && Ref.intValue(game.optGet(s, "slot"), -1) == selected) {
                        index = i;
                    }
                }
                if (index < 0) {
                    throw new ProbeException("unsupported", "Cannot drop items in this version");
                }
                Class<?> typeClass = ref.cls("net.minecraft.world.inventory.ContainerInput", "net.minecraft.world.inventory.ClickType");
                Object gameMode = game.optGet(mc, "gameMode");
                Method m = ref.method(gameMode.getClass(), "handleContainerInput", 5);
                if (m == null) {
                    m = ref.method(gameMode.getClass(), "handleInventoryMouseClick", 5);
                }
                m.invoke(gameMode, game.optGet(menu, "containerId"), index, all ? 1 : 0, ref.getStatic(typeClass, "THROW"), player);
            }
            if (!all) {
                dropped.put("count", 1);
            }
            return dropped;
        }, 5000);
    }
}
