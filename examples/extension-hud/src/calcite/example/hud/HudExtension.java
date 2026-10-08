package calcite.example.hud;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import calcite.probe.Ref;
import calcite.probe.api.Calcite;
import calcite.probe.api.CalciteException;
import calcite.probe.api.CalciteExtension;
import calcite.probe.api.Handler;

/**
 * Example Calcite extension: reads the HUD (boss bars, scoreboard sidebar, tab list, title) and reports title and
 * action bar changes as events. Written against Mojang's official names; works on vanilla and every mod loader.
 */
public final class HudExtension implements CalciteExtension {

    private Calcite calcite;
    private Ref ref;

    @Override
    public String id() {
        return "hud";
    }

    @Override
    public void init(Calcite c) {
        calcite = c;
        ref = c.ref();
        c.command("bossbars", "Boss bars on screen: name, progress (0-1), color", null, new Handler() {
            @Override
            public Object handle(Map<String, Object> args) throws Exception {
                return onGame(new Callable<Object>() {
                    @Override
                    public Object call() throws Exception {
                        return bossBars();
                    }
                });
            }
        });
        c.command("sidebar", "Scoreboard sidebar: title and lines (name, score), highest score first", null, new Handler() {
            @Override
            public Object handle(Map<String, Object> args) throws Exception {
                return onGame(new Callable<Object>() {
                    @Override
                    public Object call() throws Exception {
                        return sidebar();
                    }
                });
            }
        });
        Map<String, Object> tabSchema = new LinkedHashMap<String, Object>();
        tabSchema.put("type", "object");
        Map<String, Object> props = new LinkedHashMap<String, Object>();
        Map<String, Object> limit = new LinkedHashMap<String, Object>();
        limit.put("type", "integer");
        limit.put("description", "Max players to return (default 100)");
        props.put("limit", limit);
        tabSchema.put("properties", props);
        c.command("tablist", "Players in the tab list: name, latency (ms), display name", tabSchema, new Handler() {
            @Override
            public Object handle(final Map<String, Object> args) throws Exception {
                final int max = args.get("limit") instanceof Number ? ((Number) args.get("limit")).intValue() : 100;
                return onGame(new Callable<Object>() {
                    @Override
                    public Object call() throws Exception {
                        return tabList(max);
                    }
                });
            }
        });
        c.command("title", "Current title, subtitle and action bar text", null, new Handler() {
            @Override
            public Object handle(Map<String, Object> args) throws Exception {
                return onGame(new Callable<Object>() {
                    @Override
                    public Object call() throws Exception {
                        return titles();
                    }
                });
            }
        });
        watchTitles();
    }

    private Object onGame(Callable<Object> task) throws Exception {
        if (calcite.minecraft() == null) {
            throw new CalciteException("not_ready", "Minecraft is still starting");
        }
        return calcite.onGameThread(task, 10000);
    }

    private Object gui() throws Exception {
        return ref.get(calcite.minecraft(), "gui");
    }

    /** Component → plain text. */
    private String text(Object component) throws Exception {
        return component == null ? null : (String) ref.call(component, "getString");
    }

    private List<Map<String, Object>> bossBars() throws Exception {
        Object overlay = ref.call(gui(), "getBossOverlay");
        Map<?, ?> events = (Map<?, ?>) ref.get(overlay, "events");
        List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
        for (Object bar : events.values()) {
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            m.put("name", text(ref.call(bar, "getName")));
            m.put("progress", ref.call(bar, "getProgress"));
            m.put("color", String.valueOf(ref.call(bar, "getColor")).toLowerCase());
            out.add(m);
        }
        return out;
    }

    private Map<String, Object> sidebar() throws Exception {
        Object level = ref.get(calcite.minecraft(), "level");
        if (level == null) {
            throw new CalciteException("not_in_game", "Not in a world");
        }
        Object scoreboard = ref.call(level, "getScoreboard");
        Class<?> slots = ref.cls("net.minecraft.world.scores.DisplaySlot");
        // 1.20.2+: DisplaySlot enum; older: slot number 1
        Object objective = slots != null ? ref.call(scoreboard, "getDisplayObjective", ref.getStatic(slots, "SIDEBAR"))
                : ref.call(scoreboard, "getDisplayObjective", 1);
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        if (objective == null) {
            out.put("title", null);
            out.put("lines", new ArrayList<Object>());
            return out;
        }
        out.put("title", text(ref.call(objective, "getDisplayName")));
        List<Map<String, Object>> lines = new ArrayList<Map<String, Object>>();
        if (ref.has(scoreboard, "listPlayerScores", 1)) {
            // 1.20.3+: PlayerScoreEntry records
            for (Object e : (Collection<?>) ref.call(scoreboard, "listPlayerScores", objective)) {
                lines.add(line((String) ref.call(e, "owner"), ((Number) ref.call(e, "value")).intValue()));
            }
        } else {
            for (Object s : (Collection<?>) ref.call(scoreboard, "getPlayerScores", objective)) {
                lines.add(line((String) ref.call(s, "getOwner"), ((Number) ref.call(s, "getScore")).intValue()));
            }
        }
        java.util.Collections.sort(lines, new java.util.Comparator<Map<String, Object>>() {
            @Override
            public int compare(Map<String, Object> a, Map<String, Object> b) {
                return Integer.compare((Integer) b.get("score"), (Integer) a.get("score"));
            }
        });
        out.put("lines", lines);
        return out;
    }

    private static Map<String, Object> line(String name, int score) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("name", name);
        m.put("score", score);
        return m;
    }

    private List<Map<String, Object>> tabList(int max) throws Exception {
        Object connection = ref.call(calcite.minecraft(), "getConnection");
        if (connection == null) {
            throw new CalciteException("not_in_game", "Not connected to a server");
        }
        List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
        for (Object info : (Collection<?>) ref.call(connection, "getOnlinePlayers")) {
            if (out.size() >= max) {
                break;
            }
            Object profile = ref.call(info, "getProfile");
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            // authlib's GameProfile: getName() before Minecraft 1.21.9, a record with name() after
            m.put("name", ref.has(profile, "name", 0) ? ref.call(profile, "name") : ref.call(profile, "getName"));
            m.put("latency", ref.call(info, "getLatency"));
            m.put("displayName", text(ref.call(info, "getTabListDisplayName")));
            out.add(m);
        }
        return out;
    }

    private Map<String, Object> titles() throws Exception {
        Object gui = gui();
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        boolean shown = ((Number) ref.get(gui, "titleTime")).intValue() > 0;
        m.put("title", shown ? text(ref.get(gui, "title")) : null);
        m.put("subtitle", shown ? text(ref.get(gui, "subtitle")) : null);
        boolean bar = ((Number) ref.get(gui, "overlayMessageTime")).intValue() > 0;
        m.put("actionBar", bar ? text(ref.get(gui, "overlayMessageString")) : null);
        return m;
    }

    /** Emits "hud.title" and "hud.actionbar" whenever they change. */
    private void watchTitles() {
        ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "calcite-hud");
            t.setDaemon(true);
            return t;
        });
        final Object[] last = new Object[2];
        timer.scheduleWithFixedDelay(() -> {
            try {
                Object mc = calcite.minecraft();
                if (mc == null) {
                    return;
                }
                Thread.currentThread().setContextClassLoader(mc.getClass().getClassLoader());
                @SuppressWarnings("unchecked")
                Map<String, Object> now = (Map<String, Object>) onGame(new Callable<Object>() {
                    @Override
                    public Object call() throws Exception {
                        return titles();
                    }
                });
                Object title = now.get("title") == null ? null : now.get("title") + "\n" + now.get("subtitle");
                if (title != null && !title.equals(last[0])) {
                    Map<String, Object> e = new LinkedHashMap<String, Object>();
                    e.put("title", now.get("title"));
                    e.put("subtitle", now.get("subtitle"));
                    calcite.emit("title", e);
                }
                last[0] = title;
                Object bar = now.get("actionBar");
                if (bar != null && !bar.equals(last[1])) {
                    calcite.emit("actionbar", bar);
                }
                last[1] = bar;
            } catch (Throwable ignored) {
                // not in a world yet, or the game is closing
            }
        }, 1000, 250, TimeUnit.MILLISECONDS);
    }
}
