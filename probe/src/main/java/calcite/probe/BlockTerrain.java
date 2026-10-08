package calcite.probe;

import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.Set;

import calcite.probe.nav.Cell;
import calcite.probe.nav.Terrain;

/**
 * Classifies the client's blocks for path finding by their collision shape. Classifications are cached per block
 * state, so a search reads each state's shape once.
 */
final class BlockTerrain {

    private static final Set<String> HAZARDS = new HashSet<String>(Arrays.asList(
            "minecraft:lava", "minecraft:fire", "minecraft:soul_fire", "minecraft:magma_block", "minecraft:cactus",
            "minecraft:campfire", "minecraft:soul_campfire", "minecraft:sweet_berry_bush", "minecraft:wither_rose",
            "minecraft:cobweb", "minecraft:powder_snow", "minecraft:lava_cauldron", "minecraft:nether_portal",
            "minecraft:end_portal"));

    private final Game game;
    private final Ref ref;
    private final World world;
    private final Map<Object, Cell> byState = Collections.synchronizedMap(new IdentityHashMap<Object, Cell>());

    BlockTerrain(Game game, Ref ref, World world) {
        this.game = game;
        this.ref = ref;
        this.world = world;
    }

    /**
     * Terrain of {@code level} for one thread. Searches run off the game thread: reading the client's chunk storage
     * concurrently is safe enough for planning, and a path is re-planned when the world turns out different.
     */
    View of(Object level) throws Exception {
        return new View(level);
    }

    /** Block states and cells of one level; not thread-safe. */
    final class View implements Terrain {
        private final Object level;
        private final Object pos;
        private final Method setPos;
        private final Method getBlockState;
        private final Method hasChunk;
        private final Map<Long, Boolean> chunks = new HashMap<Long, Boolean>();

        View(Object level) throws Exception {
            this.level = level;
            this.pos = ref.construct("net.minecraft.core.BlockPos$MutableBlockPos");
            this.setPos = ref.method(pos.getClass(), "set", 3, "int", "int", "int");
            this.getBlockState = ref.method(level.getClass(), "getBlockState", 1);
            this.hasChunk = ref.method(level.getClass(), "hasChunk", 2, "int", "int");
            if (setPos == null || getBlockState == null) {
                throw new ProbeException("unsupported", "Block access is not available in this version");
            }
        }

        @Override
        public Cell cell(int x, int y, int z) {
            try {
                Object state = state(x, y, z);
                return state == null ? Cell.UNLOADED : classify(state, level, pos);
            } catch (Exception e) {
                return Cell.UNLOADED;
            }
        }

        /** The block state at (x, y, z), or null when its chunk is not loaded. */
        Object state(int x, int y, int z) throws Exception {
            if (!loaded(x >> 4, z >> 4)) {
                return null;
            }
            setPos.invoke(pos, x, y, z);
            return getBlockState.invoke(level, pos);
        }

        private boolean loaded(int cx, int cz) throws Exception {
            if (hasChunk == null) {
                return true;
            }
            long key = (long) cx << 32 | (cz & 0xFFFFFFFFL);
            Boolean loaded = chunks.get(key);
            if (loaded == null) {
                loaded = Boolean.TRUE.equals(hasChunk.invoke(level, cx, cz));
                chunks.put(key, loaded);
            }
            return loaded;
        }
    }

    /** Hazard, water, empty or solid with the height of its collision box. */
    Cell classify(Object state, Object level, Object pos) throws Exception {
        Cell cached = byState.get(state);
        if (cached != null) {
            return cached;
        }
        String id = world.blockId(state);
        Cell cell;
        if ("minecraft:void_air".equals(id)) {
            cell = Cell.UNLOADED;
        } else if (HAZARDS.contains(id) || "lava".equals(fluid(state))) {
            cell = Cell.DANGER;
        } else {
            double height = collisionHeight(state, level, pos);
            cell = height > 0 ? Cell.solid(height) : "water".equals(fluid(state)) ? Cell.WATER : Cell.OPEN;
        }
        byState.put(state, cell);
        return cell;
    }

    /** "water", "lava" or null. */
    private String fluid(Object state) {
        Object fluid = game.optCall(state, "getFluidState");
        if (fluid == null || Boolean.TRUE.equals(game.optCall(fluid, "isEmpty"))) {
            return null;
        }
        String id = world.registryKey("FLUID", game.optCall(fluid, "getType"));
        return id == null ? null : id.contains("lava") ? "lava" : "water";
    }

    /** Top of the block's collision box (0 = no collision); full blocks when the shape API is missing. */
    private double collisionHeight(Object state, Object level, Object pos) throws Exception {
        Method getShape = ref.method(state.getClass(), "getCollisionShape", 2);
        if (getShape == null) {
            return Boolean.TRUE.equals(game.optCall(state, "isAir")) ? 0 : 1;
        }
        Object shape = getShape.invoke(state, level, pos);
        if (Boolean.TRUE.equals(game.optCall(shape, "isEmpty"))) {
            return 0;
        }
        Method max = ref.method(shape.getClass(), "max", 1);
        Object y = ref.getStatic(ref.cls("net.minecraft.core.Direction$Axis"), "Y");
        Object top = max == null ? null : max.invoke(shape, y);
        return top instanceof Number ? ((Number) top).doubleValue() : 1;
    }
}
