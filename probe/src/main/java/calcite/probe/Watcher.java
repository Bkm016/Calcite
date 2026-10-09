package calcite.probe;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Built-in game events, found by comparing the client's state between polls: joining and leaving worlds, damage,
 * death and respawn, hunger, dimension changes, inventory changes, containers and screens. Polled from the probe
 * timer; the comparison runs on the game thread, where all fields of this class are used.
 */
final class Watcher {

    private final Game game;
    private final Ref ref;
    private final Menus menus;
    private final EventSink sink;
    private final AtomicBoolean busy = new AtomicBoolean();

    private Object player;
    private double health = -1;
    private int food = -1;
    private String dimension;
    private String screen;
    private Object menu;
    private boolean dead;
    private String[] slots = new String[0];

    Watcher(Game game, Ref ref, Menus menus, EventSink sink) {
        this.game = game;
        this.ref = ref;
        this.menus = menus;
        this.sink = sink;
    }

    void poll() {
        game.runLater(busy, () -> {
            try {
                check(game.minecraft());
            } catch (Throwable t) {
                // a half-loaded world can fail any read; the next poll sees a settled state
            }
        });
    }

    private void check(Object mc) throws Exception {
        Object current = game.optGet(mc, "player");
        Object level = game.optGet(mc, "level");
        checkScreen(mc);
        if (current == null || level == null) {
            if (player != null) {
                player = null;
                emit("world.leave", null);
            }
            return;
        }
        String dim = game.dimension(level);
        if (player == null) {
            player = current;
            dimension = dim;
            remember(current);
            emit("world.join", position(current, "dimension", dim));
            return;
        }
        if (current != player) { // the client creates a new player on respawn and on dimension change
            player = current;
            if (dead) {
                dead = false;
                emit("player.respawn", position(current, "dimension", dim));
            }
            health = game.health(current);
        }
        if (!Objects.equals(dim, dimension)) {
            emit("player.dimension", position(current, "dimension", dim, "previous", dimension));
            dimension = dim;
        }
        checkHealth(current);
        checkFood(current);
        checkInventory(current);
        checkContainer(mc, current);
    }

    private void checkHealth(Object player) {
        double now = game.health(player);
        if (now >= 0 && health >= 0 && now < health) {
            Map<String, Object> data = map("health", now, "amount", health - now);
            String source = damageSource(player);
            if (source != null) {
                data.put("source", source);
            }
            emit("player.hurt", data);
        }
        health = now;
    }

    /** The kind of the last damage taken ("fall", "mob", "lava"...), where the client knows it (1.19.4+). */
    private String damageSource(Object player) {
        Object source = game.optCall(player, "getLastDamageSource");
        Object id = game.optCall(game.optCall(source, "type"), "msgId");
        return id != null ? id.toString() : (String) game.optCall(source, "getMsgId");
    }

    private void checkFood(Object player) {
        int now = foodLevel(player);
        if (now >= 0 && food >= 0 && now != food) {
            emit("player.food", map("food", now, "previous", food));
        }
        food = now;
    }

    private int foodLevel(Object player) {
        return Ref.intValue(game.optCall(game.optCall(player, "getFoodData"), "getFoodLevel"), -1);
    }

    private void checkInventory(Object player) throws Exception {
        Object inv = menus.playerInventory(player);
        int size = menus.size(inv);
        List<Map<String, Object>> changes = new ArrayList<Map<String, Object>>();
        String[] now = new String[size];
        for (int i = 0; i < size; i++) {
            Object stack = menus.stackAt(inv, i);
            now[i] = signature(stack);
            String before = i < slots.length ? slots[i] : null;
            if (!Objects.equals(now[i], before)) {
                changes.add(map("slot", i, "item", menus.item(stack), "previous", parse(before)));
            }
        }
        slots = now;
        if (!changes.isEmpty()) {
            emit("inventory.change", map("changes", changes));
        }
    }

    private void checkContainer(Object mc, Object player) {
        Object now = menus.containerOpen(player) ? menus.menu(player) : null;
        if (now == menu) {
            return;
        }
        if (menu != null) {
            emit("container.close", map("type", menus.menuType(menu)));
        }
        menu = now;
        if (now != null) {
            Object screen = game.screen(mc);
            emit("container.open", map("type", menus.menuType(now), "title", screen == null ? null : game.text(game.optCall(screen, "getTitle")),
                    "containerId", game.containerId(now), "size", menus.slots(now).size()));
        }
    }

    private void checkScreen(Object mc) {
        Object open = game.screen(mc);
        String now = open == null ? null : ref.simpleNamed(open.getClass());
        if (Objects.equals(now, screen)) {
            return;
        }
        emit("screen.change", map("screen", now, "previous", screen));
        screen = now;
        if ("DeathScreen".equals(now)) {
            dead = true;
            emit("player.death", map("message", game.text(game.optGet(open, "causeOfDeath"))));
        }
    }

    /** Takes the state of a new player without reporting it as changes. */
    private void remember(Object player) throws Exception {
        health = game.health(player);
        food = foodLevel(player);
        Object inv = menus.playerInventory(player);
        slots = new String[menus.size(inv)];
        for (int i = 0; i < slots.length; i++) {
            slots[i] = signature(menus.stackAt(inv, i));
        }
    }

    /** "minecraft:stone 12" for a stack, null for an empty one. */
    private String signature(Object stack) {
        String id = menus.itemId(stack);
        return id == null ? null : id + " " + menus.count(stack);
    }

    private static Map<String, Object> parse(String signature) {
        if (signature == null) {
            return null;
        }
        int space = signature.lastIndexOf(' ');
        return map("id", signature.substring(0, space), "count", Integer.parseInt(signature.substring(space + 1)));
    }

    private Map<String, Object> position(Object player, Object... extra) {
        double[] p = game.position(player);
        Map<String, Object> data = map(extra);
        data.put("x", p[0]);
        data.put("y", p[1]);
        data.put("z", p[2]);
        return data;
    }

    private void emit(String name, Object data) {
        sink.event(name, data);
    }

    private static Map<String, Object> map(Object... keysAndValues) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        for (int i = 0; i < keysAndValues.length; i += 2) {
            m.put((String) keysAndValues[i], keysAndValues[i + 1]);
        }
        return m;
    }
}
