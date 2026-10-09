package calcite.probe;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;

import java.io.StringReader;
import java.lang.reflect.Method;

import org.junit.jupiter.api.Test;

import calcite.probe.fixtures.a;
import calcite.probe.fixtures.b;

/** Name resolution through ProGuard-style mappings, against the obfuscated-looking fixture classes. */
class RefTest {

    private static final String MAPPINGS = String.join("\n",
            "# {\"id\":\"sourceFile\"}",
            "net.example.Base -> calcite.probe.fixtures.a:",
            "# {\"fileName\":\"Base.java\",\"id\":\"sourceFile\"}",
            "    int counter -> a",
            "    10:12:int getCounter() -> b",
            "net.example.Thing -> calcite.probe.fixtures.b:",
            "    java.lang.String label -> c",
            "    20:21:java.lang.String describe() -> d",
            "    22:23:java.lang.String describe(java.lang.String) -> d",
            "    24:25:java.lang.String describe(net.example.Base) -> d",
            "    26:27:void <init>() -> <init>",
            "");

    private static Mappings mappings() throws Exception {
        return Mappings.parse(new StringReader(MAPPINGS));
    }

    private static Ref ref() throws Exception {
        return new Ref(mappings(), RefTest.class.getClassLoader());
    }

    @Test
    void parsesMappings() throws Exception {
        Mappings m = mappings();
        assertEquals(2, m.size());
        assertEquals("calcite.probe.fixtures.b", m.runtimeClass("net.example.Thing"));
        assertEquals("net.example.Base", m.namedClass("calcite.probe.fixtures.a"));
        assertEquals("calcite.probe.fixtures.a[]", m.runtimeType("net.example.Base[]"));
        assertEquals("int", m.runtimeType("int"));
        Mappings.ClassEntry thing = m.byRuntime("calcite.probe.fixtures.b");
        assertEquals(3, thing.methods("describe").size());
        assertEquals("c", thing.field("label"));
    }

    @Test
    void resolvesClassesAndMembers() throws Exception {
        Ref ref = ref();
        Class<?> thing = ref.cls("net.example.Thing");
        assertSame(b.class, thing);
        Object o = new b();
        assertEquals("plain", ref.call(o, "describe"));
        assertEquals("label!", ref.get(o, "label"));
        assertNull(ref.cls("net.example.Missing"));
        assertNull(ref.method(thing, "nope", 0));
        assertEquals("Thing", ref.simpleNamed(thing));
    }

    @Test
    void resolvesOverloadsByParameterType() throws Exception {
        Ref ref = ref();
        Method byString = ref.method(b.class, "describe", 1, "java.lang.String");
        Method byBase = ref.method(b.class, "describe", 1, "net.example.Base");
        assertNotNull(byString);
        assertNotNull(byBase);
        assertNotEquals(byString, byBase);
        assertEquals("str:x", byString.invoke(new b(), "x"));
        assertEquals("base:7", byBase.invoke(new b(), new a()));
    }

    @Test
    void resolvesInheritedMembers() throws Exception {
        Ref ref = ref();
        Object o = new b();
        assertEquals(7, ref.call(o, "getCounter"));
        assertEquals(7, ref.get(o, "counter"));
    }

    @Test
    void identityMappingsUseRuntimeNames() throws Exception {
        Ref ref = new Ref(Mappings.identity(), RefTest.class.getClassLoader());
        assertSame(StringBuilder.class, ref.cls("java.lang.StringBuilder"));
        assertEquals(2, ref.call(new StringBuilder("ab"), "length"));
        assertNotNull(ref.method(StringBuilder.class, "append", 1, "java.lang.String"));
    }
}
