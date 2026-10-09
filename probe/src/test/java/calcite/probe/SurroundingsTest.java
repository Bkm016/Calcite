package calcite.probe;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

import calcite.probe.nav.Grid;

/** The relief map and compass directions of {@code surroundings}. */
class SurroundingsTest {

    @Test
    void drawsReliefRows() {
        Grid g = new Grid(
                "..#.~!..",
                "...#....",
                "........");
        assertEquals("..+#~!..", new String(Surroundings.relief(g, 0, 0, 8, 1)[0]));
    }

    @Test
    void marksDropsAndUnloadedColumns() {
        Grid tower = new Grid("#..", "#..", "#..", "...");
        assertEquals('v', Surroundings.column(tower, 1, 0, 4), "three blocks down");
        assertEquals('.', Surroundings.column(tower, 0, 0, 4), "level on the tower");
        assertEquals('O', Surroundings.column(new Grid("."), 0, 0, 5), "deep drop");
        assertEquals('?', Surroundings.column(new Grid("."), 5, 0, 1), "not loaded");
    }

    @Test
    void namesFacingFromYaw() {
        assertEquals("south", Surroundings.facing(0));
        assertEquals("west", Surroundings.facing(90));
        assertEquals("north", Surroundings.facing(-180));
        assertEquals("east", Surroundings.facing(-90));
        assertEquals("southeast", Surroundings.facing(-45));
    }
}
