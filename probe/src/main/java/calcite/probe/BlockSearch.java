package calcite.probe;

import java.lang.reflect.Array;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * Finds the blocks nearest to the player by id or pattern, reading the client's chunk sections directly. Sections
 * holding only air (or, where the game can tell, none of the wanted blocks) are skipped, so a search over a few
 * hundred thousand blocks takes milliseconds. Runs on the request thread; see {@link BlockTerrain} on why reading
 * chunks off the game thread is acceptable.
 */
final class BlockSearch implements Ops.Module {

    static final int MAX_RADIUS = 128;
    private static final long BUDGET_MS = 5000;

    private final Game game;
    private final Ref ref;
    private final World world;

    BlockSearch(Game game, Ref ref, World world) {
        this.game = game;
        this.ref = ref;
        this.world = world;
    }

    @Override
    public void register(Ops ops) {
        ops.add("find_blocks", a -> {
            List<Pattern> patterns = new ArrayList<Pattern>();
            for (String id : a.strings("blocks")) {
                patterns.add(glob(World.qualify(id)));
            }
            int radius = Math.max(1, Math.min(MAX_RADIUS, a.integer("radius", 32)));
            return find(patterns, radius, Math.max(1, a.integer("limit", 16)));
        });
    }

    /**
     * A block id pattern: {@code *} matches any characters. Patterns without a namespace ({@code *_ore}) match the
     * id's path in every namespace.
     */
    static Pattern glob(String pattern) {
        StringBuilder regex = new StringBuilder(pattern.indexOf(':') < 0 ? "[^:]+:" : "");
        String[] parts = pattern.split("\\*", -1);
        for (int i = 0; i < parts.length; i++) {
            regex.append(i > 0 ? ".*" : "").append(Pattern.quote(parts[i]));
        }
        return Pattern.compile(regex.toString());
    }

    private Map<String, Object> find(final List<Pattern> patterns, final int radius, final int limit) throws Exception {
        final Object[] captured = new Object[2];
        game.withPlayer((mc, player) -> {
            captured[0] = game.optGet(mc, "level");
            captured[1] = game.position(player);
            return null;
        });
        Object level = captured[0];
        double[] origin = (double[]) captured[1];
        Matcher matcher = new Matcher(patterns);
        // farthest of the best matches on top, so it is the one replaced by a nearer one
        PriorityQueue<Match> best = new PriorityQueue<Match>(limit, (p, q) -> Double.compare(q.distanceSq, p.distanceSq));
        Sections sections = new Sections(level);
        int ox = (int) Math.floor(origin[0]), oy = (int) Math.floor(origin[1]), oz = (int) Math.floor(origin[2]);
        long deadline = System.currentTimeMillis() + BUDGET_MS;
        boolean truncated = false;
        for (int[] chunk : chunksByDistance(ox >> 4, oz >> 4, (radius >> 4) + 1)) {
            if (best.size() >= limit && chunkDistanceSq(chunk, origin) > best.peek().distanceSq) {
                break; // every remaining chunk is farther than the matches found
            }
            if (System.currentTimeMillis() > deadline) {
                truncated = true;
                break;
            }
            sections.scan(chunk[0], chunk[1], oy - radius, oy + radius, matcher, (x, y, z, id) -> {
                double dx = x + 0.5 - origin[0], dy = y + 0.5 - origin[1], dz = z + 0.5 - origin[2];
                double d = dx * dx + dy * dy + dz * dz;
                if (d <= (double) radius * radius && (best.size() < limit || d < best.peek().distanceSq)) {
                    best.add(new Match(x, y, z, id, d));
                    if (best.size() > limit) {
                        best.poll();
                    }
                }
            });
        }
        List<Match> sorted = new ArrayList<Match>(best);
        Collections.sort(sorted, (p, q) -> Double.compare(p.distanceSq, q.distanceSq));
        List<Map<String, Object>> blocks = new ArrayList<Map<String, Object>>();
        for (Match m : sorted) {
            blocks.add(m.toMap());
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("count", blocks.size());
        if (truncated) {
            out.put("truncated", true);
        }
        out.put("blocks", blocks);
        return out;
    }

    /** Chunk coordinates within {@code r} chunks of (cx, cz), nearest first. */
    private static List<int[]> chunksByDistance(int cx, int cz, int r) {
        List<int[]> chunks = new ArrayList<int[]>();
        for (int x = cx - r; x <= cx + r; x++) {
            for (int z = cz - r; z <= cz + r; z++) {
                chunks.add(new int[]{x, z});
            }
        }
        Collections.sort(chunks, (a, b) -> Integer.compare(sq(a[0] - cx) + sq(a[1] - cz), sq(b[0] - cx) + sq(b[1] - cz)));
        return chunks;
    }

    /** Squared horizontal distance from {@code p} to the nearest point of a chunk. */
    private static double chunkDistanceSq(int[] chunk, double[] p) {
        double dx = Math.max(0, Math.max(chunk[0] * 16 - p[0], p[0] - (chunk[0] * 16 + 16)));
        double dz = Math.max(0, Math.max(chunk[1] * 16 - p[2], p[2] - (chunk[1] * 16 + 16)));
        return dx * dx + dz * dz;
    }

    private static int sq(int v) {
        return v * v;
    }

    private interface Visitor {
        void visit(int x, int y, int z, String id);
    }

    /** Matches block states against the patterns, once per state. */
    private final class Matcher implements Predicate<Object> {
        private final List<Pattern> patterns;
        private final Map<Object, String> ids = new IdentityHashMap<Object, String>();

        Matcher(List<Pattern> patterns) {
            this.patterns = patterns;
        }

        /** The id of a matching state, or null. */
        String match(Object state) {
            if (ids.containsKey(state)) {
                return ids.get(state);
            }
            String id = world.blockId(state);
            String result = null;
            for (Pattern p : patterns) {
                if (id != null && p.matcher(id).matches()) {
                    result = id;
                    break;
                }
            }
            ids.put(state, result);
            return result;
        }

        @Override
        public boolean test(Object state) {
            return match(state) != null;
        }
    }

    /** Reads the sections of loaded chunks; the reflective lookups happen once per search. */
    private final class Sections {
        private final Object level;
        private final Method getChunk;
        private final Method hasChunk;
        private final Method sectionY;
        private Method getSections;
        private Method getState;
        private Method maybeHas;

        Sections(Object level) {
            this.level = level;
            this.getChunk = ref.method(level.getClass(), "getChunk", 2, "int", "int");
            this.hasChunk = ref.method(level.getClass(), "hasChunk", 2, "int", "int");
            this.sectionY = ref.method(level.getClass(), "getSectionYFromSectionIndex", 1, "int");
            if (getChunk == null) {
                throw new ProbeException("unsupported", "Chunk access is not available in this version");
            }
        }

        void scan(int cx, int cz, int minY, int maxY, Matcher matcher, Visitor visitor) throws Exception {
            if (hasChunk != null && !Boolean.TRUE.equals(hasChunk.invoke(level, cx, cz))) {
                return;
            }
            Object chunk = getChunk.invoke(level, cx, cz);
            if (getSections == null) {
                getSections = ref.method(chunk.getClass(), "getSections", 0);
            }
            Object sections = getSections == null ? null : getSections.invoke(chunk);
            if (sections == null) {
                return;
            }
            for (int i = 0, n = Array.getLength(sections); i < n; i++) {
                Object section = Array.get(sections, i);
                if (section == null) {
                    continue;
                }
                int baseY = baseY(section, i);
                if (baseY + 15 < minY || baseY > maxY || empty(section) || !mayContain(section, matcher)) {
                    continue;
                }
                if (getState == null) {
                    getState = ref.method(section.getClass(), "getBlockState", 3, "int", "int", "int");
                }
                for (int ly = Math.max(0, minY - baseY); ly <= Math.min(15, maxY - baseY); ly++) {
                    for (int lz = 0; lz < 16; lz++) {
                        for (int lx = 0; lx < 16; lx++) {
                            String id = matcher.match(getState.invoke(section, lx, ly, lz));
                            if (id != null) {
                                visitor.visit(cx * 16 + lx, baseY + ly, cz * 16 + lz, id);
                            }
                        }
                    }
                }
            }
        }

        /** Bottom block y of section {@code index}: 1.17+ levels have a minimum section below zero. */
        private int baseY(Object section, int index) throws Exception {
            if (sectionY != null) {
                return Ref.intValue(sectionY.invoke(level, index), index) * 16;
            }
            return Ref.intValue(game.optCall(section, "bottomBlockY"), index * 16);
        }

        private boolean empty(Object section) {
            Object empty = game.optCall(section, "hasOnlyAir");
            return Boolean.TRUE.equals(empty != null ? empty : game.optCall(section, "isEmpty"));
        }

        /** The section palette's quick check, where available (1.16+). */
        private boolean mayContain(Object section, Matcher matcher) throws Exception {
            if (maybeHas == null) {
                maybeHas = ref.method(section.getClass(), "maybeHas", 1);
                if (maybeHas == null) {
                    return true;
                }
            }
            return !Boolean.FALSE.equals(maybeHas.invoke(section, matcher));
        }
    }

    private static final class Match {
        final int x;
        final int y;
        final int z;
        final String id;
        final double distanceSq;

        Match(int x, int y, int z, String id, double distanceSq) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.id = id;
            this.distanceSq = distanceSq;
        }

        Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            m.put("x", x);
            m.put("y", y);
            m.put("z", z);
            m.put("id", id);
            m.put("distance", Math.round(Math.sqrt(distanceSq) * 10) / 10.0);
            return m;
        }
    }
}
