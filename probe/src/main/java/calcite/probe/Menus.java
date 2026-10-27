package calcite.probe;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Item stacks, the player's inventory and container menus (game thread only). */
final class Menus {

    private final Game game;
    private final Ref ref;
    private final World world;

    Menus(Game game, Ref ref, World world) {
        this.game = game;
        this.ref = ref;
        this.world = world;
    }

    // ---------------------------------------------------------------- stacks

    /** id/count/name of a stack, or null for an empty one. */
    Map<String, Object> item(Object stack) {
        String id = itemId(stack);
        if (id == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("id", id);
        m.put("count", count(stack));
        m.put("name", game.text(game.optCall(stack, "getHoverName")));
        int max = Ref.intValue(game.optCall(stack, "getMaxDamage"), 0);
        if (max > 0) {
            m.put("damage", game.optCall(stack, "getDamageValue"));
            m.put("maxDamage", max);
        }
        return m;
    }

    /** Item id of a stack, or null for an empty one. */
    String itemId(Object stack) {
        if (stack == null || Boolean.TRUE.equals(game.optCall(stack, "isEmpty"))) {
            return null;
        }
        return world.registryKey("ITEM", game.optCall(stack, "getItem"));
    }

    /**
     * The lines the client shows when hovering this stack: name, enchantments, lore, attributes, potion
     * effects and the like. 1.20.5+ takes a tooltip context, older versions only the player and a flag;
     * a version without the API returns an empty list instead of failing.
     */
    List<String> tooltip(Object mc, Object player, Object stack) {
        List<String> lines = new ArrayList<String>();
        if (itemId(stack) == null) {
            return lines;
        }
        Method lines3 = ref.method(stack.getClass(), "getTooltipLines", 3);
        Method lines2 = lines3 == null ? ref.method(stack.getClass(), "getTooltipLines", 2) : null;
        if (lines3 == null && lines2 == null) {
            return lines;
        }
        try {
            Object result = lines3 != null
                    ? lines3.invoke(stack, tooltipContext(mc), player, tooltipFlag())
                    : lines2.invoke(stack, player, tooltipFlag());
            if (result instanceof List) {
                for (Object line : (List<?>) result) {
                    String text = game.text(line);
                    if (text != null) {
                        lines.add(text);
                    }
                }
            }
        } catch (Throwable ignored) {
            // an unsupported version or a stack whose tooltip throws: report the fields we could read
        }
        return lines;
    }

    /**
     * {@code TooltipFlag.NORMAL}: everything a player sees without advanced tooltips (F3+H). Older versions
     * keep it as an enum constant of the nested TooltipFlag.Default, newer ones as a field of TooltipFlag.
     */
    private Object tooltipFlag() {
        for (String name : new String[]{"net.minecraft.world.item.TooltipFlag", "net.minecraft.world.item.TooltipFlag$Default"}) {
            Class<?> type = ref.cls(name);
            if (type == null) {
                continue;
            }
            try {
                Object flag = ref.getStatic(type, "NORMAL");
                if (flag != null) {
                    return flag;
                }
            } catch (ReflectiveOperationException ignored) {
                // try the other holder
            }
        }
        return null;
    }

    /** {@code Item.TooltipContext.EMPTY}, or a context for the client's level, or null before 1.20.5. */
    private Object tooltipContext(Object mc) {
        Class<?> type = ref.cls("net.minecraft.world.item.Item$TooltipContext");
        if (type == null) {
            return null;
        }
        try {
            Object empty = ref.getStatic(type, "EMPTY");
            if (empty != null) {
                return empty;
            }
        } catch (ReflectiveOperationException ignored) {
            // older versions of the interface only offer of(Level)
        }
        Object level = game.optGet(mc, "level");
        Method of = ref.method(type, "of", 1);
        try {
            return of != null && level != null ? of.invoke(null, level) : null;
        } catch (ReflectiveOperationException e) {
            return null;
        }
    }

    int count(Object stack) {
        return Ref.intValue(game.optCall(stack, "getCount"), 0);
    }

    // ---------------------------------------------------------------- player inventory

    Object playerInventory(Object player) {
        Object inv = game.optCall(player, "getInventory");
        if (inv == null) {
            inv = game.optGet(player, "inventory");
        }
        if (inv == null) {
            throw new ProbeException("unsupported", "Player inventory not found");
        }
        return inv;
    }

    int size(Object inv) {
        return Ref.intValue(game.optCall(inv, "getContainerSize"), 41);
    }

    Object stackAt(Object inv, int slot) throws Exception {
        Method getItem = ref.method(inv.getClass(), "getItem", 1, "int");
        return getItem.invoke(inv, slot);
    }

    int selectedSlot(Object inv) {
        Object v = game.optCall(inv, "getSelectedSlot");
        if (v == null) {
            v = game.optGet(inv, "selected");
        }
        return Ref.intValue(v, 0);
    }

    /** How many items with this id the player carries. */
    int countInInventory(Object player, String id) throws Exception {
        Object inv = playerInventory(player);
        int total = 0;
        for (int i = 0, n = size(inv); i < n; i++) {
            Object stack = stackAt(inv, i);
            if (id.equals(itemId(stack))) {
                total += count(stack);
            }
        }
        return total;
    }

    // ---------------------------------------------------------------- menus

    /** The open menu: a container, or the player's inventory menu when none is open. */
    Object menu(Object player) {
        return game.optGet(player, "containerMenu");
    }

    boolean containerOpen(Object player) {
        Object menu = menu(player);
        return menu != null && menu != game.optGet(player, "inventoryMenu");
    }

    /** The stack on the mouse cursor: held by the menu since 1.17, by the player's inventory before. */
    Object carried(Object player) {
        Object stack = game.optCall(menu(player), "getCarried");
        return stack != null ? stack : game.optCall(playerInventory(player), "getCarried");
    }

    String menuType(Object menu) {
        Object type = game.optCall(menu, "getType");
        return type == null ? null : world.registryKey("MENU", type);
    }

    List<?> slots(Object menu) {
        return (List<?>) game.optGet(menu, "slots");
    }

    Object slotStack(Object slot) {
        return game.optCall(slot, "getItem");
    }

    boolean isPlayerSlot(Object slot) {
        Class<?> inventoryClass = ref.cls("net.minecraft.world.entity.player.Inventory");
        return inventoryClass != null && inventoryClass.isInstance(game.optGet(slot, "container"));
    }

    /** Index of the menu slot showing slot {@code inventorySlot} of the player's inventory, or -1. */
    int menuSlotOf(Object menu, Object inv, int inventorySlot) {
        List<?> slots = slots(menu);
        for (int i = 0; i < slots.size(); i++) {
            Object s = slots.get(i);
            if (game.optGet(s, "container") == inv && Ref.intValue(game.optGet(s, "slot"), -1) == inventorySlot) {
                return i;
            }
        }
        return -1;
    }

    /**
     * Clicks a slot of the open menu like the player would. {@code mode}: pickup, quick_move, swap, clone, throw,
     * quick_craft or pickup_all; slot -999 is outside the window.
     */
    void click(Object mc, Object player, int slot, int button, String mode) throws Exception {
        Class<?> typeClass = ref.cls("net.minecraft.world.inventory.ContainerInput", "net.minecraft.world.inventory.ClickType");
        Object type;
        try {
            type = ref.getStatic(typeClass, mode.toUpperCase(Locale.ROOT));
        } catch (NoSuchFieldException e) {
            throw new ProbeException("bad_request", "Unknown click mode " + mode);
        }
        Object gameMode = game.optGet(mc, "gameMode");
        Method m = ref.method(gameMode.getClass(), "handleContainerInput", 5);
        if (m == null) {
            m = ref.method(gameMode.getClass(), "handleInventoryMouseClick", 5);
        }
        if (m == null) {
            throw new ProbeException("unsupported", "No container click API in this version");
        }
        m.invoke(gameMode, game.containerId(menu(player)), slot, button, type, player);
    }
}
