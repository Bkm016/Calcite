package calcite.probe;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Request arguments and the agent's own arguments. */
class ArgsTest {

    @Test
    void readsTypedArguments() {
        Map<String, Object> raw = new HashMap<String, Object>();
        raw.put("x", 1.7);
        raw.put("y", -0.5);
        raw.put("z", 3L);
        raw.put("name", "stone");
        raw.put("list", Arrays.asList("a", 2, "b"));
        raw.put("flag", "yes");
        Args a = new Args(raw);
        assertArrayEquals(new int[] {1, -1, 3}, a.blockPos(), "block positions are floored");
        assertEquals("stone", a.str("name"));
        assertEquals("d", a.str("missing", "d"));
        assertNull(a.optNum("missing"));
        assertEquals(3, a.integer("z", 0));
        assertEquals(9, a.millis("missing", 9));
        assertTrue(a.flag("flag", true), "a non-boolean flag falls back to the default");
        assertEquals(Arrays.asList("a", "b"), a.strings("list"), "string lists skip other values");
        assertEquals(Collections.singletonList("stone"), a.strings("name"), "a string is a list of one");
    }

    @Test
    void missingArgumentsAreBadRequests() {
        assertEquals("bad_request", assertThrows(ProbeException.class, () -> new Args(null).num("x")).code());
        assertEquals("bad_request", assertThrows(ProbeException.class, () -> new Args(null).str("name")).code());
    }

    @Test
    void parsesInlineAgentArguments() {
        Map<String, String> args = Probe.parseArgs("port=1,token=x");
        assertEquals("1", args.get("port"));
        assertEquals("x", args.get("token"));
    }

    @Test
    void readsAgentArgumentsFromAPropertiesFile(@TempDir File dir) throws Exception {
        File f = new File(dir, "calcite probe.properties");
        Files.write(f.toPath(), "port=5\nmappings=C\\:\\\\Users\\\\John Doe\\\\m,1.txt\n".getBytes(StandardCharsets.UTF_8));
        Map<String, String> args = Probe.parseArgs(f.getAbsolutePath());
        assertEquals("5", args.get("port"));
        assertEquals("C:\\Users\\John Doe\\m,1.txt", args.get("mappings"), "values keep spaces and commas");
    }
}
