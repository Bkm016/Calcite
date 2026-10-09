package calcite.probe;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Client and player state, and the entities the client knows about. */
final class Status implements Ops.Module {

    private final Game game;
    private final Ref ref;

    Status(Game game, Ref ref) {
        this.game = game;
        this.ref = ref;
    }

    @Override
    public void register(Ops ops) {
        ops.add("state", a -> state());
        ops.add("entities", a -> entities(a.num("radius", 0), a.integer("limit", 0), a.flag("includeSelf", false)));
    }

    Map<String, Object> state() throws Exception {
        final Object mc = game.minecraft();
        if (mc == null) {
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("ready", false);
            out.put("headless", game.headless());
            out.put("inGame", false);
            return out;
        }
        return game.onGameThread(() -> {
            Map<String, Object> s = new LinkedHashMap<String, Object>();
            s.put("ready", true);
            s.put("headless", game.headless());
            Object level = game.optGet(mc, "level");
            Object player = game.optGet(mc, "player");
            s.put("inGame", level != null && player != null);
            s.put("loading", game.optGet(mc, "overlay") != null);
            Object screen = game.screen(mc);
            s.put("screen", screen == null ? null : ref.simpleNamed(screen.getClass()));
            if (screen != null && "DisconnectedScreen".equals(ref.simpleNamed(screen.getClass()))) {
                s.put("disconnectReason", disconnectReason(screen));
            }
            Object fps = game.optGet(mc, "fps");
            if (fps instanceof Number) {
                s.put("fps", ((Number) fps).intValue());
            }
            Object noRender = game.optGet(mc, "noRender");
            if (noRender instanceof Boolean) {
                s.put("noRender", noRender);
            }
            if (player != null) {
                s.put("player", player(mc, player, level));
            }
            return s;
        }, Game.TIMEOUT_MS);
    }

    private Map<String, Object> player(Object mc, Object player, Object level) {
        Map<String, Object> p = new LinkedHashMap<String, Object>();
        p.put("id", game.optCall(player, "getId"));
        Object uuid = game.optCall(player, "getUUID");
        p.put("uuid", uuid == null ? null : uuid.toString());
        p.put("name", game.text(game.optCall(player, "getName")));
        double[] pos = game.position(player);
        if (pos != null) {
            p.put("x", pos[0]);
            p.put("y", pos[1]);
            p.put("z", pos[2]);
        }
        p.put("yaw", game.yaw(player));
        p.put("pitch", game.pitch(player));
        double health = game.health(player);
        if (health >= 0) {
            p.put("health", health);
        }
        Object food = game.optCall(game.optCall(player, "getFoodData"), "getFoodLevel");
        if (food instanceof Number) {
            p.put("food", ((Number) food).intValue());
        }
        Object mode = game.optCall(game.optCall(game.optGet(mc, "gameMode"), "getPlayerMode"), "getName");
        if (mode != null) {
            p.put("gameMode", mode.toString());
        }
        p.put("dimension", game.dimension(level));
        return p;
    }

    private String disconnectReason(Object screen) {
        Object details = game.optGet(screen, "details");
        Object reason = details == null ? null : game.optCall(details, "reason");
        if (reason == null) {
            reason = game.optGet(screen, "reason");
        }
        return reason == null ? null : game.text(reason);
    }

    /** Entities known to the client, optionally only those within {@code radius} blocks of the player. */
    List<Map<String, Object>> entities(final double radius, final int limit, final boolean includeSelf) throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
            Object player = game.optGet(mc, "player");
            double[] origin = player == null ? null : game.position(player);
            Object selfId = player == null ? null : game.optCall(player, "getId");
            for (Object e : loadedEntities(mc)) {
                if (limit > 0 && out.size() >= limit) {
                    break;
                }
                if (!includeSelf && selfId != null && selfId.equals(game.optCall(e, "getId"))) {
                    continue;
                }
                double[] pos = game.position(e);
                if (radius > 0 && origin != null && pos != null && distanceSq(pos, origin) > radius * radius) {
                    continue;
                }
                out.add(game.describe(e));
            }
            return out;
        }, 10000);
    }

    /** ClientLevel#entitiesForRendering; game thread only. */
    Iterable<?> loadedEntities(Object mc) {
        Object level = game.optGet(mc, "level");
        if (level == null) {
            return new ArrayList<Object>();
        }
        Object iterable = game.optCall(level, "entitiesForRendering");
        if (!(iterable instanceof Iterable)) {
            throw new ProbeException("unsupported", "ClientLevel#entitiesForRendering is not available in this version");
        }
        return (Iterable<?>) iterable;
    }

    static double distanceSq(double[] a, double[] b) {
        double dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
        return dx * dx + dy * dy + dz * dz;
    }

    static double round(double v, int decimals) {
        double scale = Math.pow(10, decimals);
        return Math.round(v * scale) / scale;
    }
}
