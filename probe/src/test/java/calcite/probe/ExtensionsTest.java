package calcite.probe;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.function.BiConsumer;
import java.util.function.Function;

import org.junit.jupiter.api.Test;

import calcite.probe.api.CalciteException;

/** Commands registered by extensions and by mods through the system-properties bridge. */
class ExtensionsTest {

    @Test
    @SuppressWarnings("unchecked")
    void callsBridgedAndRegisteredCommands() throws Exception {
        List<String> events = new ArrayList<String>();
        Extensions ext = new Extensions((name, data) -> events.add(name + "=" + data));
        ext.publishBridge();
        Map<String, Object> bridge = (Map<String, Object>) System.getProperties().get(Extensions.BRIDGE_COMMANDS);
        bridge.put("mod.echo", (Function<Map<String, Object>, Object>) a -> a.get("x"));
        Map<String, Object> meta = new HashMap<String, Object>();
        meta.put("description", "ping");
        meta.put("handler", (Callable<Object>) () -> "pong");
        bridge.put("mod.ping", meta);
        ext.register("x.add", null, null, a -> ((Number) a.get("a")).longValue() + 1, "x");

        Map<String, Object> args = new HashMap<String, Object>();
        args.put("x", "hi");
        args.put("a", 1L);
        assertEquals("hi", ext.call("mod.echo", args), "bridged function");
        assertEquals("pong", ext.call("mod.ping", args), "bridged map with a handler");
        assertEquals(2L, ext.call("x.add", args), "registered command");

        List<Map<String, Object>> list = ext.list();
        assertEquals(3, list.size());
        assertEquals("mod.echo", list.get(0).get("name"));
        assertEquals("ping", list.get(1).get("description"));
        assertEquals("x", list.get(2).get("source"));

        assertEquals("unknown_command", assertThrows(CalciteException.class, () -> ext.call("nope", args)).code());

        ((BiConsumer<String, Object>) System.getProperties().get(Extensions.BRIDGE_EMIT)).accept("mod.tick", 3);
        assertEquals(java.util.Collections.singletonList("mod.tick=3"), events, "bridged events");
    }
}
