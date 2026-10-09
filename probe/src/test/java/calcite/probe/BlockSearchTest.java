package calcite.probe;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.regex.Pattern;

import org.junit.jupiter.api.Test;

class BlockSearchTest {

    private static boolean matches(String pattern, String id) {
        return BlockSearch.glob(World.qualify(pattern)).matcher(id).matches();
    }

    @Test
    void plainIdsMatchExactly() {
        assertTrue(matches("stone", "minecraft:stone"));
        assertFalse(matches("stone", "minecraft:stone_bricks"));
    }

    @Test
    void globsWithoutNamespaceMatchAnyNamespace() {
        Pattern ores = BlockSearch.glob(World.qualify("*_ore"));
        assertTrue(ores.matcher("minecraft:iron_ore").matches());
        assertTrue(ores.matcher("mod:tin_ore").matches());
        assertFalse(ores.matcher("minecraft:ore_block").matches());
    }

    @Test
    void namespacedGlobsKeepTheirNamespace() {
        assertTrue(matches("minecraft:*_log", "minecraft:oak_log"));
        assertFalse(matches("minecraft:*_log", "mod:oak_log"));
    }
}
