package calcite.probe;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Mojang (ProGuard format) client mappings: named (official) names -> runtime (obfuscated) names.
 * An empty instance means the game runs with official names (unobfuscated versions such as 26.1+).
 */
public final class Mappings {

    /** A mapped method: runtime name plus its official parameter type names. */
    public static final class MethodEntry {
        public final String runtimeName;
        public final String[] paramTypes;

        MethodEntry(String runtimeName, String[] paramTypes) {
            this.runtimeName = runtimeName;
            this.paramTypes = paramTypes;
        }
    }

    /** All mapped members of one class. */
    public static final class ClassEntry {
        public final String named;
        public final String runtime;
        final Map<String, String> fields = new HashMap<String, String>();
        final Map<String, List<MethodEntry>> methods = new HashMap<String, List<MethodEntry>>();

        ClassEntry(String named, String runtime) {
            this.named = named;
            this.runtime = runtime;
        }

        public String field(String name) {
            return fields.get(name);
        }

        public List<MethodEntry> methods(String name) {
            List<MethodEntry> list = methods.get(name);
            return list == null ? Collections.<MethodEntry>emptyList() : list;
        }
    }

    private final Map<String, ClassEntry> byNamed = new HashMap<String, ClassEntry>();
    private final Map<String, ClassEntry> byRuntime = new HashMap<String, ClassEntry>();
    private final boolean identity;

    private Mappings(boolean identity) {
        this.identity = identity;
    }

    /** Mappings for an unobfuscated game: every name maps to itself. */
    public static Mappings identity() {
        return new Mappings(true);
    }

    public static Mappings load(Path file) throws IOException {
        try (Reader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            return parse(reader);
        }
    }

    public static Mappings parse(Reader in) throws IOException {
        Mappings m = new Mappings(false);
        BufferedReader reader = in instanceof BufferedReader ? (BufferedReader) in : new BufferedReader(in);
        ClassEntry current = null;
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.isEmpty() || line.charAt(0) == '#') {
                continue;
            }
            if (line.charAt(0) != ' ') {
                // net.minecraft.client.Minecraft -> fgo:
                int arrow = line.indexOf(" -> ");
                if (arrow < 0 || !line.endsWith(":")) {
                    current = null;
                    continue;
                }
                String named = line.substring(0, arrow);
                String runtime = line.substring(arrow + 4, line.length() - 1);
                current = new ClassEntry(named, runtime);
                m.byNamed.put(named, current);
                m.byRuntime.put(runtime, current);
                continue;
            }
            if (current == null) {
                continue;
            }
            String member = line.trim();
            if (member.startsWith("#")) {
                continue;
            }
            int arrow = member.indexOf(" -> ");
            if (arrow < 0) {
                continue;
            }
            String runtime = member.substring(arrow + 4);
            String left = member.substring(0, arrow);
            // strip "12:34:" line number prefix of methods
            int i = 0;
            while (i < left.length() && (Character.isDigit(left.charAt(i)) || left.charAt(i) == ':')) {
                i++;
            }
            left = left.substring(i);
            int space = left.indexOf(' ');
            if (space < 0) {
                continue;
            }
            String rest = left.substring(space + 1);
            int paren = rest.indexOf('(');
            if (paren < 0) {
                current.fields.put(rest, runtime);
            } else {
                String name = rest.substring(0, paren);
                String params = rest.substring(paren + 1, rest.lastIndexOf(')'));
                String[] types = params.isEmpty() ? new String[0] : params.split(",");
                List<MethodEntry> list = current.methods.get(name);
                if (list == null) {
                    list = new ArrayList<MethodEntry>(1);
                    current.methods.put(name, list);
                }
                list.add(new MethodEntry(runtime, types));
            }
        }
        return m;
    }

    public boolean isIdentity() {
        return identity;
    }

    public int size() {
        return byNamed.size();
    }

    /** Runtime binary name for an official class name. */
    public String runtimeClass(String named) {
        if (identity) {
            return named;
        }
        ClassEntry e = byNamed.get(named);
        return e == null ? null : e.runtime;
    }

    /** Official class name for a runtime class name, or the input itself if unmapped. */
    public String namedClass(String runtime) {
        if (identity) {
            return runtime;
        }
        ClassEntry e = byRuntime.get(runtime);
        return e == null ? runtime : e.named;
    }

    /** Mapping entry for a runtime class name, or null. */
    public ClassEntry byRuntime(String runtime) {
        return byRuntime.get(runtime);
    }

    /** Converts an official type name (e.g. "net.minecraft.world.entity.Entity[]") into a runtime type name. */
    public String runtimeType(String named) {
        if (identity) {
            return named;
        }
        String base = named;
        String suffix = "";
        while (base.endsWith("[]")) {
            base = base.substring(0, base.length() - 2);
            suffix += "[]";
        }
        ClassEntry e = byNamed.get(base);
        return (e == null ? base : e.runtime) + suffix;
    }
}
