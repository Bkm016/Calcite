package calcite.probe;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

class JsonTest {

    @Test
    @SuppressWarnings("unchecked")
    void parsesAndWritesValues() {
        String text = "{\"a\":1,\"b\":[true,false,null],\"c\":\"q\\\"\\n\\u00e9\",\"d\":-2.5,\"e\":{}}";
        Map<String, Object> m = (Map<String, Object>) Json.parse(text);
        assertEquals(1L, m.get("a"));
        assertEquals(Arrays.asList(true, false, null), (List<Object>) m.get("b"));
        assertEquals("q\"\n\u00e9", m.get("c"));
        assertEquals(-2.5, m.get("d"));
        assertEquals(m, Json.parse(Json.write(m)));
    }

    @Test
    void escapesControlCharacters() {
        assertEquals("\"\\u0001\"", Json.write("\u0001"));
    }

    @Test
    void writesArrays() {
        assertEquals("[1,2,3]", Json.write(new int[] {1, 2, 3}));
        assertEquals("[\"a\",null]", Json.write(new String[] {"a", null}));
    }
}
