package calcite.probe;

import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** World queries: blocks, the crosshair target and registry ids. */
final class World implements Ops.Module {

    private final Game game;
    private final Ref ref;

    World(Game game, Ref ref) {
        this.game = game;
        this.ref = ref;
    }

    @Override
    public void register(Ops ops) {
        ops.add("block", a -> block(a.blockPos()));
        ops.add("target", a -> game.withPlayer((mc, player) -> describeHit(mc)));
    }

    Map<String, Object> block(final int[] pos) throws Exception {
        return game.withPlayer((mc, player) -> {
            Object state = blockState(mc, pos);
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("x", pos[0]);
            out.put("y", pos[1]);
            out.put("z", pos[2]);
            if (state == null) {
                out.put("loaded", false);
                return out;
            }
            out.put("id", blockId(state));
            out.put("air", game.optCall(state, "isAir"));
            String s = state.toString();
            int bracket = s.indexOf('[');
            if (bracket > 0 && s.endsWith("]")) {
                out.put("properties", s.substring(bracket + 1, s.length() - 1));
            }
            return out;
        });
    }

    /** What the crosshair points at (game thread). */
    Map<String, Object> describeHit(Object mc) throws Exception {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        Object hit = game.optGet(mc, "hitResult");
        Object type = hit == null ? null : game.optCall(hit, "getType");
        String kind = type == null ? "miss" : ref.enumName(type).toLowerCase(Locale.ROOT);
        out.put("type", kind);
        if ("block".equals(kind)) {
            Object pos = game.optCall(hit, "getBlockPos");
            int[] p = {Ref.intValue(game.optCall(pos, "getX"), 0), Ref.intValue(game.optCall(pos, "getY"), 0), Ref.intValue(game.optCall(pos, "getZ"), 0)};
            out.put("x", p[0]);
            out.put("y", p[1]);
            out.put("z", p[2]);
            Object dir = game.optCall(hit, "getDirection");
            out.put("face", dir == null ? null : faceName(dir));
            Object state = blockState(mc, p);
            if (state != null) {
                out.put("block", blockId(state));
            }
        } else if ("entity".equals(kind)) {
            out.put("entity", game.describe(game.optCall(hit, "getEntity")));
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

    /** The block state at a position, or null outside a world. */
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

    /** Registry id of a block state's block, e.g. "minecraft:stone". */
    String blockId(Object state) {
        return registryKey("BLOCK", game.optCall(state, "getBlock"));
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

    /** "diamond_ore" → "minecraft:diamond_ore"; ids with a namespace and patterns are kept. */
    static String qualify(String id) {
        String s = id.trim().toLowerCase(Locale.ROOT);
        return s.indexOf(':') >= 0 || s.startsWith("*") ? s : "minecraft:" + s;
    }
}
