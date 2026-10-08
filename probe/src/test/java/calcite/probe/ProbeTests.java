package calcite.probe;

import java.io.StringReader;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;

/** Dependency-free tests for the probe (run by scripts/test-probe.mjs). */
public final class ProbeTests {

    private static int failures;

    public static void main(String[] args) throws Exception {
        mappingsParse();
        refResolvesThroughMappings();
        refResolvesOverloadsByType();
        refResolvesInheritedMembers();
        identityMappings();
        jsonRoundTrip();
        agentArgs();
        if (failures > 0) {
            System.err.println(failures + " test(s) failed");
            System.exit(1);
        }
        System.out.println("probe tests passed");
    }

    static final String MAPPINGS = String.join("\n",
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

    static void mappingsParse() throws Exception {
        Mappings m = Mappings.parse(new StringReader(MAPPINGS));
        check(m.size() == 2, "two classes parsed");
        check("calcite.probe.fixtures.b".equals(m.runtimeClass("net.example.Thing")), "runtime class name");
        check("net.example.Base".equals(m.namedClass("calcite.probe.fixtures.a")), "named class name");
        check("calcite.probe.fixtures.a[]".equals(m.runtimeType("net.example.Base[]")), "array type");
        check("int".equals(m.runtimeType("int")), "primitive type");
        Mappings.ClassEntry thing = m.byRuntime("calcite.probe.fixtures.b");
        check(thing.methods("describe").size() == 3, "overloads parsed");
        check("c".equals(thing.field("label")), "field parsed");
    }

    static void refResolvesThroughMappings() throws Exception {
        Ref ref = new Ref(Mappings.parse(new StringReader(MAPPINGS)), ProbeTests.class.getClassLoader());
        Class<?> thing = ref.cls("net.example.Thing");
        check(thing == calcite.probe.fixtures.b.class, "class resolved");
        Object o = thing.newInstance();
        check("plain".equals(ref.call(o, "describe")), "method by official name");
        check("label!".equals(ref.get(o, "label")), "field by official name");
        check(ref.cls("net.example.Missing") == null, "missing class is null");
        check(ref.method(thing, "nope", 0) == null, "missing method is null");
        check("Thing".equals(ref.simpleNamed(thing)), "simple named");
    }

    static void refResolvesOverloadsByType() throws Exception {
        Ref ref = new Ref(Mappings.parse(new StringReader(MAPPINGS)), ProbeTests.class.getClassLoader());
        Class<?> thing = ref.cls("net.example.Thing");
        Object o = thing.newInstance();
        Method byString = ref.method(thing, "describe", 1, "java.lang.String");
        Method byBase = ref.method(thing, "describe", 1, "net.example.Base");
        check(byString != null && byBase != null && !byString.equals(byBase), "overloads disambiguated");
        check("str:x".equals(byString.invoke(o, "x")), "string overload");
        check("base:7".equals(byBase.invoke(o, new calcite.probe.fixtures.a())), "base overload");
    }

    static void refResolvesInheritedMembers() throws Exception {
        Ref ref = new Ref(Mappings.parse(new StringReader(MAPPINGS)), ProbeTests.class.getClassLoader());
        Object o = ref.cls("net.example.Thing").newInstance();
        check(Integer.valueOf(7).equals(ref.call(o, "getCounter")), "inherited method");
        check(Integer.valueOf(7).equals(ref.get(o, "counter")), "inherited field");
    }

    static void identityMappings() throws Exception {
        Ref ref = new Ref(Mappings.identity(), ProbeTests.class.getClassLoader());
        check(ref.cls("java.lang.StringBuilder") == StringBuilder.class, "identity class");
        StringBuilder sb = new StringBuilder("ab");
        check(Integer.valueOf(2).equals(ref.call(sb, "length")), "identity method");
        check(ref.method(StringBuilder.class, "append", 1, "java.lang.String") != null, "identity overload");
    }

    @SuppressWarnings("unchecked")
    static void jsonRoundTrip() {
        String text = "{\"a\":1,\"b\":[true,false,null],\"c\":\"q\\\"\\n\\u00e9\",\"d\":-2.5,\"e\":{}}";
        Map<String, Object> m = (Map<String, Object>) Json.parse(text);
        check(Long.valueOf(1).equals(m.get("a")), "json number");
        check(((List<Object>) m.get("b")).size() == 3, "json array");
        check("q\"\n\u00e9".equals(m.get("c")), "json string escapes");
        check(Double.valueOf(-2.5).equals(m.get("d")), "json double");
        check(Json.parse(Json.write(m)).equals(m), "json round trip");
        check("\"\\u0001\"".equals(Json.write("\u0001")), "control char escaped");
    }

    static void agentArgs() throws Exception {
        Map<String, String> inline = Probe.parseArgs("port=1,token=x");
        check("1".equals(inline.get("port")) && "x".equals(inline.get("token")), "inline agent args");
        java.io.File f = java.io.File.createTempFile("calcite probe", ".properties");
        f.deleteOnExit();
        java.nio.file.Files.write(f.toPath(), "port=5\nmappings=C\\:\\\\Users\\\\John Doe\\\\m,1.txt\n".getBytes("UTF-8"));
        Map<String, String> file = Probe.parseArgs(f.getAbsolutePath());
        check("5".equals(file.get("port")), "file agent args");
        check("C:\\Users\\John Doe\\m,1.txt".equals(file.get("mappings")), "file args keep spaces and commas");
    }

    static void check(boolean condition, String name) {
        if (!condition) {
            failures++;
            System.err.println("FAIL: " + name);
        }
    }
}
