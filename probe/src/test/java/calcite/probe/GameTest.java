package calcite.probe;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** The reflective accessors of {@link Game}, against plain objects with the game's member names. */
class GameTest {

    /** Newer versions: rotation getters. */
    public static final class Getters {
        public float getYRot() {
            return 90f;
        }

        public float getXRot() {
            return -30f;
        }
    }

    /** Older versions: public rotation fields only. */
    public static final class Fields {
        public float yRot = 45f;
        public float xRot = 10f;
    }

    public static final class State {
        private final boolean air;

        State(boolean air) {
            this.air = air;
        }

        public boolean isAir() {
            return air;
        }
    }

    public static final class Menu {
        public int containerId = 3;
    }

    private final Game game = new Game(new Ref(Mappings.identity(), GameTest.class.getClassLoader()), true);

    @Test
    void rotationPrefersGettersAndFallsBackToFields() {
        assertEquals(90.0, game.yaw(new Getters()));
        assertEquals(-30.0, game.pitch(new Getters()));
        assertEquals(45.0, game.yaw(new Fields()));
        assertEquals(10.0, game.pitch(new Fields()));
        assertNull(game.yaw(new Object()));
    }

    @Test
    void blockAndMenuAccessors() {
        assertTrue(game.isAir(new State(true)));
        assertFalse(game.isAir(new State(false)));
        assertFalse(game.isAir(new Object()));
        assertEquals(3, game.containerId(new Menu()));
    }
}
