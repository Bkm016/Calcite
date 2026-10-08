package calcite.probe;

import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** World queries: blocks, the crosshair target and registry ids. */
final class World {

    private final Game game;
    private final Ref ref;

    World(Game game, Ref ref) {
        this.game = game;
        this.ref = ref;
    }

    Map<String, Object> block(final int[] pos) throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            game.requirePlayer(mc);
            Object state = blockState(mc, pos);
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("x", pos[0]);
            out.put("y", pos[1]);
            out.put("z", pos[2]);
            if (state == null) {
                out.put("loaded", false);
                return out;
            }
            out.put("id", registryKey("BLOCK", game.optCall(state, "getBlock")));
            out.put("air", game.optCall(state, "isAir"));
            String s = state.toString();
            int bracket = s.indexOf('[');
            if (bracket > 0 && s.endsWith("]")) {
                out.put("properties", s.substring(bracket + 1, s.length() - 1));
            }
            return out;
        }, 5000);
    }

    /** What the crosshair points at. */
    Map<String, Object> target() throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            game.requirePlayer(mc);
            return describeHit(mc);
        }, 5000);
    }

    Map<String, Object> describeHit(Object mc) throws Exception {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        Object hit = game.optGet(mc, "hitResult");
        Object type = hit == null ? null : game.optCall(hit, "getType");
        String kind = type == null ? "miss" : ((Enum<?>) type).name();
        Mappings.ClassEntry entry = type == null ? null : ref.mappings().byRuntime(type.getClass().getName());
        if (entry != null && !ref.mappings().isIdentity()) {
            for (String named : new String[]{"MISS", "BLOCK", "ENTITY"}) {
                if (kind.equals(entry.field(named))) {
                    kind = named;
                }
            }
        }
        kind = kind.toLowerCase(Locale.ROOT);
        out.put("type", kind);
        if ("block".equals(kind)) {
            Object pos = game.optCall(hit, "getBlockPos");
            int[] p = blockCoords(pos);
            out.put("x", p[0]);
            out.put("y", p[1]);
            out.put("z", p[2]);
            Object dir = game.optCall(hit, "getDirection");
            out.put("face", dir == null ? null : faceName(dir));
            Object state = blockState(mc, p);
            if (state != null) {
                out.put("block", registryKey("BLOCK", game.optCall(state, "getBlock")));
            }
        } else if ("entity".equals(kind)) {
            Object e = game.optCall(hit, "getEntity");
            out.put("entity", game.describe(e, game.position(e)));
        }
        return out;
    }

    private String faceName(Object direction) {
        Object name = game.optCall(direction, "getSerializedName");
        if (name == null) {
            name = game.optCall(direction, "getName");
        }
        return name == null ? direction.toString().toLowerCase(Locale.ROOT) : name.toString();
    }

    Object blockState(Object mc, int[] pos) throws Exception {
        Object level = game.optGet(mc, "level");
        if (level == null) {
            return null;
        }
        Method get = ref.method(level.getClass(), "getBlockState", 1);
        return get == null ? null : get.invoke(level, blockPos(pos));
    }

    Object blockPos(int[] pos) throws Exception {
        return ref.construct("net.minecraft.core.BlockPos", pos[0], pos[1], pos[2]);
    }

    private int[] blockCoords(Object pos) {
        return new int[]{Ref.intValue(game.optCall(pos, "getX"), 0), Ref.intValue(game.optCall(pos, "getY"), 0), Ref.intValue(game.optCall(pos, "getZ"), 0)};
    }

    /** Registry id ("minecraft:stone") of a value in BuiltInRegistries.NAME (1.19.3+) or Registry.NAME. */
    String registryKey(String registry, Object value) {
        if (value == null) {
            return null;
        }
        for (String holder : new String[]{"net.minecraft.core.registries.BuiltInRegistries", "net.minecraft.core.Registry"}) {
            Class<?> k = ref.cls(holder);
            if (k == null) {
                continue;
            }
            try {
                Object reg = ref.getStatic(k, registry);
                Method getKey = ref.method(reg.getClass(), "getKey", 1);
                Object key = getKey == null ? null : getKey.invoke(reg, value);
                if (key != null) {
                    return key.toString();
                }
            } catch (Throwable ignored) {
                // try the next holder
            }
        }
        return value.toString();
    }
}
