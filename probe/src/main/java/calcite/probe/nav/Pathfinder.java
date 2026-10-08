package calcite.probe.nav;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;

/**
 * A* over block spaces for a walking player: flat moves in eight directions (no corner cutting), one-block jumps
 * up, drops of up to {@value #MAX_DROP} blocks and swimming. Hazards ({@link Cell.Kind#DANGER}) are never entered.
 * When the budget runs out the path to the explored space closest to the goal is returned, marked incomplete.
 */
public final class Pathfinder {

    public static final int MAX_DROP = 3;
    /** Highest rise walked without jumping (stairs, slabs). */
    static final double STEP = 0.6;
    /** Highest rise reachable by jumping. */
    static final double JUMP = 1.25;
    private static final double JUMP_COST = 0.5;
    private static final double SWIM_COST = 2;
    private static final double DIVE_COST = 4;
    private static final int[][] DIRECTIONS = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}, {1, 1}, {1, -1}, {-1, 1}, {-1, -1}};

    private final Terrain terrain;

    public Pathfinder(Terrain terrain) {
        this.terrain = new CachedTerrain(terrain);
    }

    private static final class Node {
        final int x;
        final int y;
        final int z;
        final double floor;
        final double h;
        double g = Double.MAX_VALUE;
        Node parent;
        boolean jump;
        boolean closed;

        Node(int x, int y, int z, double floor, double h) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.floor = floor;
            this.h = h;
        }
    }

    /** A queue entry; nodes are re-queued when a cheaper way to them is found. */
    private static final class Entry implements Comparable<Entry> {
        final Node node;
        final double f;

        Entry(Node node) {
            this.node = node;
            this.f = node.g + node.h;
        }

        @Override
        public int compareTo(Entry o) {
            int c = Double.compare(f, o.f);
            return c != 0 ? c : Double.compare(node.h, o.node.h);
        }
    }

    private final Map<Long, Node> nodes = new HashMap<Long, Node>();
    private final PriorityQueue<Entry> open = new PriorityQueue<Entry>();
    private Goal goal;

    /**
     * Searches from a player standing at (x, y, z). When the player is not on solid ground (jumping, falling) the
     * search starts from the floor below, up to {@value #MAX_DROP} blocks down.
     */
    public Path find(double x, double y, double z, Goal goal, int maxNodes, long maxMillis) {
        this.goal = goal;
        nodes.clear();
        open.clear();
        Node start = startNode(x, y, z);
        start.g = 0;
        open.add(new Entry(start));
        Node best = start;
        int explored = 0;
        long deadline = System.currentTimeMillis() + maxMillis;
        while (!open.isEmpty()) {
            Node n = open.poll().node;
            if (n.closed) {
                continue;
            }
            n.closed = true;
            if (goal.reached(n.x, n.floor, n.z)) {
                return new Path(trace(n), true, explored);
            }
            if (n.h < best.h || n.h == best.h && n.g < best.g) {
                best = n;
            }
            if (++explored >= maxNodes || (explored & 255) == 0 && System.currentTimeMillis() > deadline) {
                break;
            }
            expand(n);
        }
        return new Path(trace(best), false, explored);
    }

    /**
     * The space the player stands in: the column under the player's centre, or a neighbour column when the player
     * stands on the edge of a block with the centre over air.
     */
    private Node startNode(double x, double y, double z) {
        int bx = (int) Math.floor(x), bz = (int) Math.floor(z);
        int ex = x - bx < 0.3 ? -1 : x - bx > 0.7 ? 1 : 0;
        int ez = z - bz < 0.3 ? -1 : z - bz > 0.7 ? 1 : 0;
        int[][] columns = {{bx, bz}, {bx + ex, bz}, {bx, bz + ez}, {bx + ex, bz + ez}};
        for (int[] c : columns) {
            Node n = standingAt(c[0], y, c[1], 0.6);
            if (n != null) {
                return n;
            }
        }
        Node n = standingAt(bx, y, bz, MAX_DROP + 1);
        return n != null ? n : node(bx, (int) Math.floor(y), bz, y);
    }

    /** The highest space in column (x, z) whose floor is at most {@code below} under {@code feet} (and not above). */
    private Node standingAt(int x, double feet, int z, double below) {
        for (int y = (int) Math.floor(feet) + 1; y >= Math.floor(feet - below) - 1; y--) {
            double floor = Terrain.floor(terrain, x, y, z);
            if (!Double.isNaN(floor) && floor <= feet + 0.1 && floor >= feet - below) {
                return node(x, y, z, floor);
            }
        }
        return null;
    }

    private void expand(Node n) {
        for (int[] d : DIRECTIONS) {
            int nx = n.x + d[0], nz = n.z + d[1];
            if (d[0] != 0 && d[1] != 0) {
                diagonal(n, nx, nz);
            } else {
                straight(n, nx, nz);
            }
        }
        if (terrain.cell(n.x, n.y, n.z).kind == Cell.Kind.WATER) {
            swimVertically(n, n.y + 1);
            swimVertically(n, n.y - 1);
        }
    }

    /** Diagonal moves stay level and need both side columns free, so the player never clips a corner. */
    private void diagonal(Node n, int nx, int nz) {
        if (!bodyClear(nx, n.y, n.z) || !bodyClear(n.x, n.y, nz)) {
            return;
        }
        double floor = Terrain.floor(terrain, nx, n.y, nz);
        if (!Double.isNaN(floor) && Math.abs(floor - n.floor) <= STEP) {
            link(n, nx, n.y, nz, floor, Math.sqrt(2), false);
        }
    }

    /** One block sideways: up a step or jump, level, or down a drop, whichever space the player can stand in. */
    private void straight(Node n, int nx, int nz) {
        for (int y = n.y + 1; y >= n.y; y--) {
            double floor = Terrain.floor(terrain, nx, y, nz);
            if (Double.isNaN(floor)) {
                continue;
            }
            double rise = floor - n.floor;
            boolean jump = rise > STEP;
            if (rise <= JUMP && (!jump || headroom(n, floor))) {
                link(n, nx, y, nz, floor, jump ? 1 + JUMP_COST : 1, jump);
            }
            return;
        }
        if (!bodyClear(nx, n.y, nz)) {
            return;
        }
        for (int drop = 1; drop <= MAX_DROP; drop++) {
            int y = n.y - drop;
            double floor = Terrain.floor(terrain, nx, y, nz);
            if (!Double.isNaN(floor)) {
                link(n, nx, y, nz, floor, 1 + drop, false);
                return;
            }
            if (!terrain.cell(nx, y, nz).clear()) {
                return;
            }
        }
    }

    private void swimVertically(Node n, int y) {
        if (terrain.cell(n.x, y, n.z).kind == Cell.Kind.WATER && !Double.isNaN(Terrain.floor(terrain, n.x, y, n.z))) {
            link(n, n.x, y, n.z, y, 1, false);
        }
    }

    /** Space above the current column for a jump that lands at {@code target}. */
    private boolean headroom(Node n, double target) {
        int top = (int) Math.floor(target + 1.8 - 1e-6);
        for (int y = n.y + 2; y <= top; y++) {
            if (!terrain.cell(n.x, y, n.z).clear()) {
                return false;
            }
        }
        return true;
    }

    private boolean bodyClear(int x, int y, int z) {
        return terrain.cell(x, y, z).clear() && terrain.cell(x, y + 1, z).clear();
    }

    private void link(Node from, int x, int y, int z, double floor, double cost, boolean jump) {
        Cell feet = terrain.cell(x, y, z);
        if (feet.kind == Cell.Kind.WATER) {
            cost *= terrain.cell(x, y + 1, z).kind == Cell.Kind.WATER ? DIVE_COST : SWIM_COST;
        }
        Node to = node(x, y, z, floor);
        double g = from.g + cost;
        if (to.closed || g >= to.g) {
            return;
        }
        to.g = g;
        to.parent = from;
        to.jump = jump;
        open.add(new Entry(to));
    }

    private Node node(int x, int y, int z, double floor) {
        long key = key(x, y, z);
        Node n = nodes.get(key);
        if (n == null) {
            n = new Node(x, y, z, floor, goal.estimate(x, floor, z));
            nodes.put(key, n);
        }
        return n;
    }

    private static long key(int x, int y, int z) {
        return ((long) x & 0x3FFFFFF) << 38 | ((long) z & 0x3FFFFFF) << 12 | (y & 0xFFF);
    }

    private List<Path.Step> trace(Node end) {
        List<Path.Step> steps = new ArrayList<Path.Step>();
        for (Node n = end; n != null; n = n.parent) {
            steps.add(new Path.Step(n.x, n.y, n.z, n.floor, n.jump, terrain.cell(n.x, n.y, n.z).kind == Cell.Kind.WATER));
        }
        Collections.reverse(steps);
        return steps;
    }

    /** Remembers every space read during one search; terrain reads go through reflection. */
    private static final class CachedTerrain implements Terrain {
        private final Terrain source;
        private final Map<Long, Cell> cells = new HashMap<Long, Cell>();

        CachedTerrain(Terrain source) {
            this.source = source;
        }

        @Override
        public Cell cell(int x, int y, int z) {
            long key = key(x, y, z);
            Cell c = cells.get(key);
            if (c == null) {
                c = source.cell(x, y, z);
                cells.put(key, c);
            }
            return c;
        }
    }
}
