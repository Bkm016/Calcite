package calcite.probe;

import static calcite.probe.ProbeTests.check;

import calcite.probe.nav.Cell;
import calcite.probe.nav.Goal;
import calcite.probe.nav.Path;
import calcite.probe.nav.Pathfinder;
import calcite.probe.nav.Terrain;

/** Path finding and the relief map over small hand-drawn worlds. */
final class NavTests {

    private NavTests() {
    }

    /**
     * A world drawn as layers from y = 1 upwards, each a '/'-separated list of rows (z) of columns (x):
     * {@code #} full block, {@code _} bottom slab, {@code ~} water, {@code !} lava, anything else air.
     * Below y = 1 is solid ground; outside the drawing is not loaded.
     */
    static final class Grid implements Terrain {
        private final String[][] layers;

        Grid(String... layers) {
            this.layers = new String[layers.length][];
            for (int i = 0; i < layers.length; i++) {
                this.layers[i] = layers[i].split("/");
            }
        }

        @Override
        public Cell cell(int x, int y, int z) {
            String[] rows = layers[0];
            if (z < 0 || z >= rows.length || x < 0 || x >= rows[z].length()) {
                return Cell.UNLOADED;
            }
            if (y < 1) {
                return Cell.FULL;
            }
            if (y > layers.length) {
                return Cell.OPEN;
            }
            switch (layers[y - 1][z].charAt(x)) {
                case '#': return Cell.FULL;
                case '_': return Cell.solid(0.5);
                case '~': return Cell.WATER;
                case '!': return Cell.DANGER;
                default: return Cell.OPEN;
            }
        }
    }

    static void run() {
        flatDiagonal();
        aroundWall();
        jumpUpStep();
        avoidsLava();
        dropsDown();
        swims();
        unreachable();
        relief();
        facing();
    }

    private static Path find(Grid grid, double x, double y, double z, double gx, double gz) {
        return new Pathfinder(grid).find(x, y, z, new Goal(gx, Double.NaN, gz, 0.5), 10000, 1000);
    }

    private static Path.Step last(Path p) {
        return p.steps.get(p.steps.size() - 1);
    }

    static void flatDiagonal() {
        String open = "...../...../...../...../.....";
        Path p = find(new Grid(open, open), 0.5, 1, 0.5, 4.5, 4.5);
        check(p.complete && p.steps.size() == 5, "flat ground: four diagonal moves");
        check(last(p).x == 4 && last(p).z == 4 && last(p).floor == 1, "path ends at the goal");
    }

    static void aroundWall() {
        String wall = "...../...../####./...../.....";
        Path p = find(new Grid(wall, wall), 0.5, 1, 0.5, 0.5, 4.5);
        boolean throughGap = false;
        for (Path.Step s : p.steps) {
            check(!(s.z == 2 && s.x < 4), "never inside the wall");
            throughGap |= s.z == 2 && s.x == 4;
        }
        check(p.complete && throughGap, "walks around through the gap");
    }

    static void jumpUpStep() {
        Path p = find(new Grid("..##", "...."), 0.5, 1, 0.5, 3.5, 0.5);
        check(p.complete && last(p).floor == 2, "climbs onto the step");
        check(p.steps.get(2).jump && !p.steps.get(1).jump, "jumps only for the full block");
        Path slab = find(new Grid("..__", "...."), 0.5, 1, 0.5, 3.5, 0.5);
        check(slab.complete && !slab.steps.get(2).jump && slab.steps.get(2).floor == 1.5, "walks up a slab");
    }

    static void avoidsLava() {
        Path p = find(new Grid(".../.!./...", ".../.../..."), 1.5, 1, 0.5, 1.5, 2.5);
        for (Path.Step s : p.steps) {
            check(!(s.x == 1 && s.z == 1), "never steps into lava");
        }
        check(p.complete, "detours around lava");
    }

    static void dropsDown() {
        // a 3-high tower at x = 0 next to the ground
        Path p = find(new Grid("#...", "#...", "#...", "...."), 0.5, 4, 0.5, 3.5, 0.5);
        check(p.complete && p.steps.get(1).floor == 1, "drops three blocks");
        Path tooHigh = find(new Grid("#..", "#..", "#..", "#..", "...."), 0.5, 5, 0.5, 2.5, 0.5);
        check(!tooHigh.complete, "does not drop four blocks");
    }

    static void swims() {
        Path p = find(new Grid(".~~.", "...."), 0.5, 1, 0.5, 3.5, 0.5);
        boolean swam = false;
        for (Path.Step s : p.steps) {
            swam |= s.swim;
        }
        check(p.complete && swam, "swims across water");
    }

    static void unreachable() {
        String box = "...../.###./.#.#./.###./.....";
        Path p = find(new Grid(box, box, box), 0.5, 1, 0.5, 2.5, 2.5);
        check(!p.complete && !p.isEmpty(), "a walled-in goal gives a partial path");
    }

    static void relief() {
        Grid g = new Grid(
                "..#.~!..",
                "...#....",
                "........");
        String row = new String(Surroundings.relief(g, 0, 0, 8, 1)[0]);
        check("..+#~!..".equals(row), "relief map row: " + row);
        Grid hole = new Grid("#..", "#..", "#..", "...");
        check(Surroundings.column(hole, 1, 0, 4) == 'v', "three blocks down");
        check(Surroundings.column(hole, 0, 0, 4) == '.', "level on the tower");
        check(Surroundings.column(new Grid("."), 0, 0, 5) == 'O', "deep drop");
        check(Surroundings.column(new Grid("."), 5, 0, 1) == '?', "not loaded");
    }

    static void facing() {
        check("south".equals(Surroundings.facing(0)) && "west".equals(Surroundings.facing(90)), "yaw 0 south, 90 west");
        check("north".equals(Surroundings.facing(-180)) && "east".equals(Surroundings.facing(-90)), "negative yaw");
        check("southeast".equals(Surroundings.facing(-45)), "diagonal facing");
    }
}
