package calcite.probe;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import calcite.probe.nav.Cell;
import calcite.probe.nav.Terrain;

/**
 * A summary of the area around the player for agents that cannot see: a relief map of where the player can walk,
 * the blocks and entities nearby, and time, weather and biome.
 */
final class Surroundings implements Ops.Module {

    static final String LEGEND = "@ you, . level, + one up, - one down, v 2-3 down, O deep drop, # wall, ~ water, "
            + "! danger, ? not loaded; P player, M monster, A other mob, i item. Rows run north to south, columns west to east.";
    private static final String[] FACING = {"south", "southwest", "west", "northwest", "north", "northeast", "east", "southeast"};
    private static final int MAX_ENTITIES = 20;
    private static final int MAX_BLOCK_KINDS = 15;

    private final Game game;
    private final Ref ref;
    private final World world;
    private final Status status;
    private final BlockTerrain terrain;

    Surroundings(Game game, Ref ref, World world, Status status, BlockTerrain terrain) {
        this.game = game;
        this.ref = ref;
        this.world = world;
        this.status = status;
        this.terrain = terrain;
    }

    @Override
    public void register(Ops ops) {
        ops.add("surroundings", a -> surroundings(Math.max(2, Math.min(24, a.integer("radius", 8)))));
    }

    private Map<String, Object> surroundings(final int radius) throws Exception {
        final Map<String, Object> out = new LinkedHashMap<String, Object>();
        final List<int[]> marks = new ArrayList<int[]>();
        final Object[] captured = new Object[2];
        game.withPlayer((mc, player) -> {
            Object level = game.optGet(mc, "level");
            double[] pos = game.position(player);
            captured[0] = level;
            captured[1] = pos;
            out.put("x", pos[0]);
            out.put("y", pos[1]);
            out.put("z", pos[2]);
            Double yaw = game.yaw(player);
            out.put("facing", yaw == null ? null : facing(yaw));
            out.putAll(environment(level, pos));
            out.put("entities", entities(mc, player, pos, radius, marks));
            return null;
        });
        Object level = captured[0];
        double[] pos = (double[]) captured[1];
        BlockTerrain.View view = terrain.of(level);
        int px = (int) Math.floor(pos[0]), pz = (int) Math.floor(pos[2]);
        char[][] map = relief(view, px - radius, pz - radius, 2 * radius + 1, pos[1]);
        for (int[] mark : marks) {
            int col = mark[0] - (px - radius), row = mark[1] - (pz - radius);
            if (row >= 0 && row < map.length && col >= 0 && col < map.length) {
                map[row][col] = (char) mark[2];
            }
        }
        map[radius][radius] = '@';
        List<String> rows = new ArrayList<String>();
        for (char[] row : map) {
            rows.add(new String(row));
        }
        out.put("standingOn", blockAt(view, px, (int) Math.floor(pos[1] - 0.05), pz));
        String in = blockAt(view, px, (int) Math.floor(pos[1]), pz);
        if (in != null && !in.endsWith(":air")) {
            out.put("in", in);
        }
        out.put("map", rows);
        out.put("mapOrigin", new int[]{px - radius, pz - radius});
        out.put("legend", LEGEND);
        out.put("blocks", blocks(view, pos, radius));
        return out;
    }

    // ---------------------------------------------------------------- relief map

    /** Rows of map characters for the {@code size}×{@code size} columns from (x0, z0), relative to {@code feet}. */
    static char[][] relief(Terrain t, int x0, int z0, int size, double feet) {
        char[][] map = new char[size][size];
        for (int row = 0; row < size; row++) {
            for (int col = 0; col < size; col++) {
                map[row][col] = column(t, x0 + col, z0 + row, feet);
            }
        }
        return map;
    }

    /** Where a player walking at height {@code feet} would end up in column (x, z). */
    static char column(Terrain t, int x, int z, double feet) {
        int top = (int) Math.floor(feet) + 1;
        for (int y = top; y >= top - 4; y--) {
            Cell cell = t.cell(x, y, z);
            if (cell.kind == Cell.Kind.DANGER) {
                return '!';
            }
            if (cell.kind == Cell.Kind.UNLOADED) {
                return '?';
            }
            double floor = Terrain.floor(t, x, y, z);
            if (!Double.isNaN(floor)) {
                return cell.kind == Cell.Kind.WATER ? '~' : height(floor - feet);
            }
            if (!cell.clear()) {
                return '#';
            }
        }
        return 'O';
    }

    private static char height(double rise) {
        if (rise > 1.25) {
            return '#';
        }
        if (rise > 0.5) {
            return '+';
        }
        if (rise >= -0.5) {
            return '.';
        }
        return rise >= -1.5 ? '-' : 'v';
    }

    // ---------------------------------------------------------------- blocks

    /** The kinds of blocks around the player's height, most common first, each with its nearest position. */
    private List<Map<String, Object>> blocks(BlockTerrain.View view, double[] pos, int radius) throws Exception {
        int px = (int) Math.floor(pos[0]), py = (int) Math.floor(pos[1]), pz = (int) Math.floor(pos[2]);
        Map<String, int[]> found = new HashMap<String, int[]>(); // id → count, x, y, z, distance²
        for (int x = px - radius; x <= px + radius; x++) {
            for (int z = pz - radius; z <= pz + radius; z++) {
                for (int y = py - 3; y <= py + 4; y++) {
                    Object state = view.state(x, y, z);
                    String id = state == null || game.isAir(state) ? null : world.blockId(state);
                    if (id == null) {
                        continue;
                    }
                    int d = sq(x - px) + sq(y - py) + sq(z - pz);
                    int[] f = found.get(id);
                    if (f == null) {
                        f = new int[]{0, x, y, z, d};
                        found.put(id, f);
                    } else if (d < f[4]) {
                        f[1] = x;
                        f[2] = y;
                        f[3] = z;
                        f[4] = d;
                    }
                    f[0]++;
                }
            }
        }
        List<Map.Entry<String, int[]>> kinds = new ArrayList<Map.Entry<String, int[]>>(found.entrySet());
        Collections.sort(kinds, (a, b) -> Integer.compare(b.getValue()[0], a.getValue()[0]));
        List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
        for (Map.Entry<String, int[]> e : kinds.subList(0, Math.min(MAX_BLOCK_KINDS, kinds.size()))) {
            int[] f = e.getValue();
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            m.put("id", e.getKey());
            m.put("count", f[0]);
            m.put("nearest", new int[]{f[1], f[2], f[3]});
            out.add(m);
        }
        return out;
    }

    private String blockAt(BlockTerrain.View view, int x, int y, int z) throws Exception {
        Object state = view.state(x, y, z);
        return state == null ? null : world.blockId(state);
    }

    // ---------------------------------------------------------------- entities and environment

    /** Nearby entities, nearest first; adds their map marks (x, z, character) to {@code marks}. Game thread. */
    private List<Map<String, Object>> entities(Object mc, Object player, double[] pos, int radius, List<int[]> marks) {
        Class<?> living = ref.cls("net.minecraft.world.entity.LivingEntity");
        List<Object[]> near = new ArrayList<Object[]>();
        for (Object e : status.loadedEntities(mc)) {
            double[] p = game.position(e);
            if (e == player || p == null || Math.abs(p[0] - pos[0]) > radius + 0.5 || Math.abs(p[2] - pos[2]) > radius + 0.5
                    || Math.abs(p[1] - pos[1]) > radius) {
                continue;
            }
            near.add(new Object[]{e, p, Status.distanceSq(p, pos)});
        }
        Collections.sort(near, (a, b) -> Double.compare((Double) a[2], (Double) b[2]));
        List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
        for (Object[] n : near) {
            Object e = n[0];
            double[] p = (double[]) n[1];
            String type = game.entityType(e);
            char mark = "minecraft:item".equals(type) ? 'i' : type != null && type.endsWith(":player") ? 'P'
                    : monster(e) ? 'M' : living != null && living.isInstance(e) ? 'A' : 0;
            if (mark != 0) {
                marks.add(new int[]{(int) Math.floor(p[0]), (int) Math.floor(p[2]), mark});
            }
            if (out.size() < MAX_ENTITIES) {
                Map<String, Object> m = new LinkedHashMap<String, Object>();
                m.put("id", game.optCall(e, "getId"));
                m.put("type", type);
                m.put("name", game.text(game.optCall(e, "getName")));
                m.put("offset", new double[]{Status.round(p[0] - pos[0], 1), Status.round(p[1] - pos[1], 1), Status.round(p[2] - pos[2], 1)});
                m.put("distance", Status.round(Math.sqrt((Double) n[2]), 1));
                double health = living != null && living.isInstance(e) ? game.health(e) : -1;
                if (health >= 0) {
                    m.put("health", health);
                }
                out.add(m);
            }
        }
        return out;
    }

    private boolean monster(Object entity) {
        Object category = game.optCall(game.optCall(entity, "getType"), "getCategory");
        return category instanceof Enum && "MONSTER".equals(ref.enumName(category));
    }

    /** Dimension, biome, time of day and weather. Game thread. */
    private Map<String, Object> environment(Object level, double[] pos) throws Exception {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("dimension", game.dimension(level));
        out.put("biome", biome(level, pos));
        Object time = game.optCall(level, "getDayTime");
        if (time instanceof Number) {
            out.put("timeOfDay", ((Number) time).longValue() % 24000);
        }
        out.put("raining", Boolean.TRUE.equals(game.optCall(level, "isRaining")));
        out.put("thundering", Boolean.TRUE.equals(game.optCall(level, "isThundering")));
        return out;
    }

    /** Biome id; 1.18+ returns a Holder whose key names it, older versions the biome itself. */
    private String biome(Object level, double[] pos) throws Exception {
        Method getBiome = ref.method(level.getClass(), "getBiome", 1);
        if (getBiome == null) {
            return null;
        }
        Object biome = getBiome.invoke(level, world.blockPos(new int[]{(int) Math.floor(pos[0]), (int) Math.floor(pos[1]), (int) Math.floor(pos[2])}));
        Object key = game.optCall(biome, "unwrapKey");
        if (key instanceof java.util.Optional) {
            return ((java.util.Optional<?>) key).map(Game::keyLocation).orElse(null);
        }
        return world.registryKey("BIOME", biome);
    }

    static String facing(double yaw) {
        int octant = (int) Math.round(((yaw % 360) + 360) % 360 / 45) % 8;
        return FACING[octant];
    }

    private static int sq(int v) {
        return v * v;
    }
}
