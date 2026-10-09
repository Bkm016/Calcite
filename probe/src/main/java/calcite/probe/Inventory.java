package calcite.probe;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The player's inventory, the hotbar, and open containers (chests, furnaces, ...). */
final class Inventory implements Ops.Module {

    private final Game game;
    private final Ref ref;
    private final Menus menus;

    Inventory(Game game, Ref ref, Menus menus) {
        this.game = game;
        this.ref = ref;
        this.menus = menus;
    }

    @Override
    public void register(Ops ops) {
        ops.add("inventory", a -> game.withPlayer((mc, player) -> inventory(player)));
        ops.add("select_slot", a -> selectSlot(a.integer("slot", -1)));
        ops.add("container", a -> container(a.millis("waitMs", 0)));
        ops.add("click", a -> click(a.integer("slot", -1000), a.integer("button", 0), a.str("mode", "pickup")));
        ops.action("close_container", a -> game.withPlayer((mc, player) -> close(mc, player)));
        ops.add("drop", a -> game.withPlayer((mc, player) -> drop(mc, player, a.flag("all", false))));
        ops.add("transfer", a -> game.withPlayer((mc, player) -> transfer(mc, player, World.qualify(a.str("item")),
                a.optInt("count"), "container".equals(a.str("to", "container")), a.optInt("slot"))));
    }

    private Map<String, Object> inventory(Object player) throws Exception {
        Object inv = menus.playerInventory(player);
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("selected", menus.selectedSlot(inv));
        List<Map<String, Object>> items = new ArrayList<Map<String, Object>>();
        for (int i = 0, n = menus.size(inv); i < n; i++) {
            Map<String, Object> item = menus.item(menus.stackAt(inv, i));
            if (item != null) {
                items.add(withSlot(i, item));
            }
        }
        out.put("items", items);
        out.put("slots", "0-8 hotbar, 9-35 main, 36-39 armor (feet..head), 40 offhand");
        return out;
    }

    private Map<String, Object> selectSlot(final int slot) throws Exception {
        if (slot < 0 || slot > 8) {
            throw new ProbeException("bad_request", "Hotbar slot must be 0-8");
        }
        return game.withPlayer((mc, player) -> {
            Object inv = menus.playerInventory(player);
            if (!game.invoke(inv, "setSelectedSlot", slot)) {
                ref.setIfPresent(inv, "selected", slot); // the client sends the change on its next tick
            }
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("selected", slot);
            out.put("item", menus.item(menus.stackAt(inv, slot)));
            return out;
        });
    }

    // ---------------------------------------------------------------- containers

    /** The open container (chest, furnace, ...) or the player's inventory menu; optionally waits for one to open. */
    private Map<String, Object> container(long waitMs) throws Exception {
        long deadline = System.currentTimeMillis() + waitMs;
        while (true) {
            Map<String, Object> state = game.withPlayer(this::containerState);
            if (Boolean.TRUE.equals(state.get("open")) || System.currentTimeMillis() >= deadline) {
                return state;
            }
            Thread.sleep(50);
        }
    }

    Map<String, Object> containerState(Object mc, Object player) throws Exception {
        Object menu = menus.menu(player);
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        boolean open = menus.containerOpen(player);
        out.put("open", open);
        if (menu == null) {
            return out;
        }
        out.put("containerId", game.containerId(menu));
        if (open) {
            out.put("type", menus.menuType(menu));
        }
        Object screen = game.screen(mc);
        if (screen != null) {
            out.put("title", game.text(game.optCall(screen, "getTitle")));
        }
        List<?> slots = menus.slots(menu);
        List<Map<String, Object>> items = new ArrayList<Map<String, Object>>();
        int containerSlots = 0;
        for (int i = 0; i < slots.size(); i++) {
            Object slot = slots.get(i);
            boolean playerSlot = menus.isPlayerSlot(slot);
            if (!playerSlot) {
                containerSlots++;
            }
            Map<String, Object> item = menus.item(menus.slotStack(slot));
            if (item != null) {
                Map<String, Object> m = withSlot(i, item);
                if (playerSlot) {
                    m.put("inventorySlot", game.optGet(slot, "slot"));
                }
                items.add(m);
            }
        }
        out.put("size", slots.size());
        out.put("containerSlots", containerSlots);
        out.put("items", items);
        Map<String, Object> carried = menus.item(menus.carried(player));
        if (carried != null) {
            out.put("carried", carried);
        }
        Map<String, Object> furnace = furnace(menu);
        if (furnace != null) {
            out.put("furnace", furnace);
        }
        return out;
    }

    /** Smelting state of a furnace-like menu: progress values are 0-1 on every version. */
    private Map<String, Object> furnace(Object menu) {
        Object lit = game.optCall(menu, "isLit");
        if (!(lit instanceof Boolean)) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("lit", lit);
        // before 1.21.2 these are pixel widths of the arrow (24) and flame (13) sprites
        out.put("progress", fraction(game.optCall(menu, "getBurnProgress"), 24));
        out.put("fuel", fraction(game.optCall(menu, "getLitProgress"), 13));
        return out;
    }

    private static Double fraction(Object v, int pixels) {
        if (v instanceof Float || v instanceof Double) {
            return Status.round(((Number) v).doubleValue(), 2);
        }
        return v instanceof Number ? Status.round(((Number) v).doubleValue() / pixels, 2) : null;
    }

    private Map<String, Object> click(final int slot, final int button, final String mode) throws Exception {
        return game.withPlayer((mc, player) -> {
            int size = menus.slots(menus.menu(player)).size();
            if (slot != -999 && (slot < 0 || slot >= size)) {
                throw new ProbeException("bad_request", "Slot must be 0-" + (size - 1) + " or -999");
            }
            menus.click(mc, player, slot, button, mode);
            return containerState(mc, player);
        });
    }

    Void close(Object mc, Object player) throws Exception {
        if (menus.containerOpen(player)) {
            ref.callOrFail(player, "closeContainer");
        } else if (game.screen(mc) != null) {
            game.setScreen(mc, null);
        }
        return null;
    }

    /** Drops the selected hotbar item (one, or the whole stack), like pressing Q. */
    private Map<String, Object> drop(Object mc, Object player, boolean all) throws Exception {
        Object inv = menus.playerInventory(player);
        int selected = menus.selectedSlot(inv);
        Map<String, Object> dropped = menus.item(menus.stackAt(inv, selected));
        if (dropped == null) {
            throw new ProbeException("empty_hand", "Nothing in the selected hotbar slot");
        }
        Method drop = ref.method(player.getClass(), "drop", 1, "boolean");
        if (drop != null) {
            drop.invoke(player, all);
        } else {
            // 26.x: throw the stack out of the matching slot of the open menu
            int index = menus.menuSlotOf(menus.menu(player), inv, selected);
            if (index < 0) {
                throw new ProbeException("unsupported", "Cannot drop items in this version");
            }
            menus.click(mc, player, index, all ? 1 : 0, "throw");
        }
        if (!all) {
            dropped.put("count", 1);
        }
        return dropped;
    }

    // ---------------------------------------------------------------- transfer

    /**
     * Moves items with id {@code item} between the open container and the player's inventory. Without a count or
     * slot whole stacks are shift-clicked (the game picks the slots, e.g. fuel goes into a furnace's fuel slot);
     * otherwise stacks are picked up and placed one by one into {@code slot} or the first slots that take them.
     */
    private Map<String, Object> transfer(Object mc, Object player, String item, Integer count, boolean toContainer, Integer slot) throws Exception {
        if (!menus.containerOpen(player)) {
            throw new ProbeException("no_container", "Open a container first (use on a chest, furnace, ...)");
        }
        List<?> slots = menus.slots(menus.menu(player));
        if (slot != null && (slot < 0 || slot >= slots.size() || menus.isPlayerSlot(slots.get(slot)) == toContainer)) {
            throw new ProbeException("bad_request", "Slot " + slot + " is not a " + (toContainer ? "container" : "inventory") + " slot");
        }
        int before = countOnSide(slots, item, toContainer);
        if (before == 0) {
            throw new ProbeException("no_items", "No " + item + " in the " + (toContainer ? "inventory" : "container"));
        }
        int remaining = count == null ? Integer.MAX_VALUE : count;
        for (int i = 0; i < slots.size() && remaining > 0; i++) {
            Object source = slots.get(i);
            if (menus.isPlayerSlot(source) == toContainer && item.equals(menus.itemId(menus.slotStack(source)))) {
                remaining -= count == null && slot == null ? shiftClick(mc, player, i) : place(mc, player, item, i, slot, remaining, toContainer);
            }
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("item", item);
        out.put("moved", before - countOnSide(slots, item, toContainer));
        out.put("container", containerState(mc, player));
        return out;
    }

    private int shiftClick(Object mc, Object player, int index) throws Exception {
        int had = menus.count(menus.slotStack(menus.slots(menus.menu(player)).get(index)));
        menus.click(mc, player, index, 0, "quick_move");
        return had - menus.count(menus.slotStack(menus.slots(menus.menu(player)).get(index)));
    }

    /** Picks up the stack in {@code source}, places up to {@code limit} items, and puts the rest back. */
    private int place(Object mc, Object player, String item, int source, Integer target, int limit, boolean toContainer) throws Exception {
        List<?> slots = menus.slots(menus.menu(player));
        menus.click(mc, player, source, 0, "pickup");
        int placed = 0;
        for (int i = 0; i < slots.size() && placed < limit && carried(player) > 0; i++) {
            String holds = menus.itemId(menus.slotStack(slots.get(i)));
            boolean candidate = (target != null ? i == target : menus.isPlayerSlot(slots.get(i)) != toContainer)
                    && (holds == null || holds.equals(item)); // a right click on another item would swap stacks
            while (candidate && placed < limit && carried(player) > 0) {
                int had = carried(player);
                menus.click(mc, player, i, 1, "pickup"); // right click: place one
                if (carried(player) >= had) {
                    break; // full or holds another item
                }
                placed++;
            }
        }
        if (carried(player) > 0) {
            menus.click(mc, player, source, 0, "pickup");
        }
        return placed;
    }

    private int carried(Object player) {
        Object stack = menus.carried(player);
        return menus.itemId(stack) == null ? 0 : menus.count(stack);
    }

    private int countOnSide(List<?> slots, String item, boolean playerSide) {
        int total = 0;
        for (Object s : slots) {
            Object stack = menus.slotStack(s);
            if (menus.isPlayerSlot(s) == playerSide && item.equals(menus.itemId(stack))) {
                total += menus.count(stack);
            }
        }
        return total;
    }

    private static Map<String, Object> withSlot(int slot, Map<String, Object> item) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("slot", slot);
        m.putAll(item);
        return m;
    }
}
