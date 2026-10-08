package calcite.probe;

import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BiConsumer;
import java.util.function.Function;

import calcite.probe.api.Calcite;
import calcite.probe.api.CalciteException;
import calcite.probe.api.CalciteExtension;
import calcite.probe.api.Handler;

/**
 * Extension commands and events.
 *
 * <p>Two sources: jars passed to the probe ({@code extensions.N}, loaded through {@link ServiceLoader}), and mods in
 * the game, which need no Calcite classes: they put entries into the map stored in the system property
 * {@value #BRIDGE_COMMANDS} (key = command name, value = a {@code java.util.function.Function<Map<String, Object>,
 * Object>}, or a {@code Map} with {@code handler}, {@code description}, {@code schema}) and send events through the
 * {@code java.util.function.BiConsumer<String, Object>} in {@value #BRIDGE_EMIT}.</p>
 */
public final class Extensions {

    public static final String BRIDGE_COMMANDS = "calcite.commands";
    public static final String BRIDGE_EMIT = "calcite.emit";

    /** Sends an event to the controller (set by the probe). */
    public interface Sink {
        void event(String name, Object data);
    }

    private static final class Command {
        final String name;
        final String description;
        final Map<String, Object> schema;
        final Handler handler;
        final String source;

        Command(String name, String description, Map<String, Object> schema, Handler handler, String source) {
            this.name = name;
            this.description = description;
            this.schema = schema;
            this.handler = handler;
            this.source = source;
        }
    }

    private final Map<String, Command> commands = new ConcurrentHashMap<String, Command>();
    private final Map<String, Object> bridge = new ConcurrentHashMap<String, Object>();
    private final List<Map<String, Object>> loaded = new ArrayList<Map<String, Object>>();
    private final Sink sink;

    public Extensions(Sink sink) {
        this.sink = sink;
    }

    /** Publishes the mod bridge through system properties (before mods load, so they can find it). */
    public void publishBridge() {
        System.getProperties().put(BRIDGE_COMMANDS, bridge);
        System.getProperties().put(BRIDGE_EMIT, new BiConsumer<String, Object>() {
            @Override
            public void accept(String name, Object data) {
                sink.event(name, data);
            }
        });
    }

    /** Loads the extension jars with a loader that sees the probe API and the game classes. */
    public void load(List<String> jars, final ClassLoader gameLoader, Calcite base) {
        final ClassLoader probeLoader = Extensions.class.getClassLoader();
        ClassLoader parent = new ClassLoader(null) {
            @Override
            protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
                if (name.startsWith("calcite.probe.")) {
                    return probeLoader.loadClass(name);
                }
                return gameLoader.loadClass(name);
            }

            @Override
            public URL getResource(String name) {
                return gameLoader.getResource(name);
            }
        };
        for (String jar : jars) {
            Map<String, Object> info = new LinkedHashMap<String, Object>();
            info.put("jar", jar);
            List<String> ids = new ArrayList<String>();
            try {
                URLClassLoader loader = new URLClassLoader(new URL[]{new File(jar).toURI().toURL()}, parent);
                Iterator<CalciteExtension> it = ServiceLoader.load(CalciteExtension.class, loader).iterator();
                while (it.hasNext()) {
                    CalciteExtension ext = it.next();
                    String id = ext.id();
                    if (id == null || !id.matches("[A-Za-z0-9_\\-]+")) {
                        throw new IllegalStateException("Invalid extension id \"" + id + "\" in " + ext.getClass().getName());
                    }
                    Thread.currentThread().setContextClassLoader(loader);
                    try {
                        ext.init(new Scoped(base, id));
                    } finally {
                        Thread.currentThread().setContextClassLoader(gameLoader);
                    }
                    ids.add(id);
                }
                if (ids.isEmpty()) {
                    throw new IllegalStateException("No META-INF/services/" + CalciteExtension.class.getName() + " entry");
                }
            } catch (Throwable t) {
                info.put("error", t.toString());
                System.err.println("[calcite-probe] extension " + jar + " failed: " + t);
                t.printStackTrace();
            }
            info.put("ids", ids);
            synchronized (loaded) {
                loaded.add(info);
            }
        }
    }

    void register(String name, String description, Map<String, Object> schema, Handler handler, String source) {
        if (handler == null) {
            throw new IllegalArgumentException("Command " + name + " has no handler");
        }
        commands.put(name, new Command(name, description, schema, handler, source));
    }

    /** Commands from extensions and from the mod bridge. */
    public List<Map<String, Object>> list() {
        List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
        for (Command c : commands.values()) {
            out.add(describe(c.name, c.description, c.schema, c.source));
        }
        for (Map.Entry<String, Object> e : bridge.entrySet()) {
            if (commands.containsKey(e.getKey())) {
                continue;
            }
            Object v = e.getValue();
            Map<?, ?> meta = v instanceof Map ? (Map<?, ?>) v : null;
            out.add(describe(e.getKey(), meta == null ? null : str(meta.get("description")), meta == null ? null : meta.get("schema"), "mod"));
        }
        java.util.Collections.sort(out, new java.util.Comparator<Map<String, Object>>() {
            @Override
            public int compare(Map<String, Object> a, Map<String, Object> b) {
                return String.valueOf(a.get("name")).compareTo(String.valueOf(b.get("name")));
            }
        });
        return out;
    }

    public List<Map<String, Object>> loaded() {
        synchronized (loaded) {
            return new ArrayList<Map<String, Object>>(loaded);
        }
    }

    @SuppressWarnings("unchecked")
    public Object call(String name, Map<String, Object> args) throws Exception {
        Command c = commands.get(name);
        if (c != null) {
            return c.handler.handle(args);
        }
        Object v = bridge.get(name);
        if (v instanceof Map) {
            v = ((Map<?, ?>) v).get("handler");
        }
        if (v instanceof Function) {
            return ((Function<Map<String, Object>, Object>) v).apply(args);
        }
        if (v instanceof Callable) {
            return ((Callable<Object>) v).call();
        }
        if (v instanceof Runnable) {
            ((Runnable) v).run();
            return null;
        }
        throw new CalciteException("unknown_command", "No extension command \"" + name + "\" (see list_extensions)");
    }

    private static Map<String, Object> describe(String name, String description, Object schema, String source) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("name", name);
        if (description != null) {
            m.put("description", description);
        }
        if (schema != null) {
            m.put("schema", schema);
        }
        m.put("source", source);
        return m;
    }

    private static String str(Object o) {
        return o == null ? null : o.toString();
    }

    /** The {@link Calcite} an extension gets: commands and events are prefixed with its id. */
    private final class Scoped implements Calcite {
        private final Calcite base;
        private final String id;

        Scoped(Calcite base, String id) {
            this.base = base;
            this.id = id;
        }

        @Override
        public Ref ref() {
            return base.ref();
        }

        @Override
        public Object minecraft() {
            return base.minecraft();
        }

        @Override
        public String minecraftVersion() {
            return base.minecraftVersion();
        }

        @Override
        public boolean headless() {
            return base.headless();
        }

        @Override
        public <T> T onGameThread(Callable<T> task, long timeoutMs) throws Exception {
            return base.onGameThread(task, timeoutMs);
        }

        @Override
        public void command(String name, Handler handler) {
            command(name, null, null, handler);
        }

        @Override
        public void command(String name, String description, Map<String, Object> argsSchema, Handler handler) {
            register(id + "." + name, description, argsSchema, handler, id);
        }

        @Override
        public void emit(String name, Object data) {
            sink.event(id + "." + name, data);
        }

        @Override
        public Object call(String op, Map<String, Object> args) throws Exception {
            return base.call(op, args);
        }

        @Override
        public void log(String message) {
            System.out.println("[calcite:" + id + "] " + message);
        }
    }
}
