package calcite.probe.nav;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class PathfinderTest {

    private static Path find(Grid grid, double x, double y, double z, double gx, double gz) {
        return new Pathfinder(grid).find(x, y, z, new Goal(gx, Double.NaN, gz, 0.5), 10000, 1000);
    }

    private static Path.Step last(Path p) {
        return p.steps.get(p.steps.size() - 1);
    }

    @Test
    void walksDiagonallyOnFlatGround() {
        String open = "...../...../...../...../.....";
        Path p = find(new Grid(open, open), 0.5, 1, 0.5, 4.5, 4.5);
        assertTrue(p.complete);
        assertEquals(5, p.steps.size(), "four diagonal moves");
        assertEquals(4, last(p).x);
        assertEquals(4, last(p).z);
        assertEquals(1, last(p).floor);
    }

    @Test
    void goesAroundAWall() {
        String wall = "...../...../####./...../.....";
        Path p = find(new Grid(wall, wall), 0.5, 1, 0.5, 0.5, 4.5);
        assertTrue(p.complete);
        boolean throughGap = false;
        for (Path.Step s : p.steps) {
            assertFalse(s.z == 2 && s.x < 4, "never inside the wall");
            throughGap |= s.z == 2 && s.x == 4;
        }
        assertTrue(throughGap, "walks through the gap");
    }

    @Test
    void jumpsOnlyOntoFullBlocks() {
        Path p = find(new Grid("..##", "...."), 0.5, 1, 0.5, 3.5, 0.5);
        assertTrue(p.complete);
        assertEquals(2, last(p).floor);
        assertTrue(p.steps.get(2).jump);
        assertFalse(p.steps.get(1).jump);

        Path slab = find(new Grid("..__", "...."), 0.5, 1, 0.5, 3.5, 0.5);
        assertTrue(slab.complete);
        assertFalse(slab.steps.get(2).jump, "walks up a slab");
        assertEquals(1.5, slab.steps.get(2).floor);
    }

    @Test
    void avoidsLava() {
        Path p = find(new Grid(".../.!./...", ".../.../..."), 1.5, 1, 0.5, 1.5, 2.5);
        assertTrue(p.complete);
        for (Path.Step s : p.steps) {
            assertFalse(s.x == 1 && s.z == 1, "never steps into lava");
        }
    }

    @Test
    void dropsAtMostThreeBlocks() {
        // a tower at x = 0 next to the ground
        Path p = find(new Grid("#...", "#...", "#...", "...."), 0.5, 4, 0.5, 3.5, 0.5);
        assertTrue(p.complete);
        assertEquals(1, p.steps.get(1).floor);
        Path tooHigh = find(new Grid("#..", "#..", "#..", "#..", "...."), 0.5, 5, 0.5, 2.5, 0.5);
        assertFalse(tooHigh.complete);
    }

    @Test
    void swimsAcrossWater() {
        Path p = find(new Grid(".~~.", "...."), 0.5, 1, 0.5, 3.5, 0.5);
        assertTrue(p.complete);
        assertTrue(p.steps.stream().anyMatch(s -> s.swim));
    }

    @Test
    void walledInGoalGivesPartialPath() {
        String box = "...../.###./.#.#./.###./.....";
        Path p = find(new Grid(box, box, box), 0.5, 1, 0.5, 2.5, 2.5);
        assertFalse(p.complete);
        assertFalse(p.isEmpty());
    }
}
