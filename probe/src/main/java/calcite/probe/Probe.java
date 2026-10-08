package calcite.probe;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.instrument.Instrumentation;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

import calcite.probe.api.Calcite;
import calcite.probe.api.CalciteException;
import calcite.probe.api.Handler;

/**
 * Java agent loaded into the Minecraft client by Calcite.
 *
 * <p>Agent arguments (comma separated {@code key=value}): {@code port}, {@code token}, {@code mappings.1},
 * {@code mappings.2}, ... (name tables to try in order: a mapping file in Mojang's format, or {@code official} for a
 * game running with official names; {@code mappings} is read when there are none), {@code headless} (true when
 * HeadlessMC replaced the renderer), {@code render} ({@code on}|{@code off}: initial world rendering),
 * {@code exitOnDisconnect}, {@code extensions.1}, {@code extensions.2}, ... (extension jars, see {@link Extensions}),
 * {@code version} (Minecraft version id).</p>
 *
 * <p>Protocol: one JSON object per line over TCP to 127.0.0.1:port. The probe sends a {@code hello} with the token,
 * then answers requests {@code {"id":1,"op":"state","args":{}}} with {@code {"id":1,"ok":true,"result":...}} or
 * {@code {"id":1,"ok":false,"code":"...","error":"..."}}; game and extension events are sent as
 * {@code {"type":"event","name":"...","data":...,"time":...}}. The operations are registered by the
 * {@link Ops.Module}s wired up in {@link #startGame}.</p>
 */
public final class Probe {

    public static final int PROTOCOL = 1;
    private static final String MINECRAFT = "net.minecraft.client.Minecraft";

    private final Map<String, String> args;
    private final Instrumentation instrumentation;
    private final ExecutorService workers = Executors.newCachedThreadPool(daemon("calcite-probe-worker"));
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(daemon("calcite-probe-timer"));
    private final Ops ops = new Ops();
    private final Extensions extensions = new Extensions(this::sendEvent);
    private volatile Game game;
    private volatile Render render;
    private volatile String initError;
    private Mappings mappings;
    private String names;
    /** Loader of the game classes; probe threads use it as context loader (Forge's transformers resolve through it). */
    private volatile ClassLoader gameLoader;
    private final Object writeLock = new Object();
    private volatile OutputStream current;

    private Probe(Map<String, String> args, Instrumentation instrumentation) {
        this.args = args;
        this.instrumentation = instrumentation;
        ops.add("ping", a -> "pong");
        ops.add("info", a -> info());
        ops.add("ext.list", a -> {
            Map<String, Object> list = new LinkedHashMap<String, Object>();
            list.put("commands", extensions.list());
            list.put("extensions", extensions.loaded());
            return list;
        });
        ops.add("ext.call", a -> extensions.call(a.str("name"), new HashMap<String, Object>(a.map("args"))));
    }

    public static void premain(String agentArgs, Instrumentation inst) {
        start(agentArgs, inst);
    }

    public static void agentmain(String agentArgs, Instrumentation inst) {
        start(agentArgs, inst);
    }

    private static void start(String agentArgs, Instrumentation inst) {
        Probe probe = new Probe(parseArgs(agentArgs), inst);
        probe.extensions.publishBridge();
        Thread t = new Thread(probe::run, "calcite-probe");
        t.setDaemon(true);
        t.start();
    }

    /**
     * Agent arguments are either the path of a properties file (preferred: paths inside it may contain spaces and
     * commas) or inline {@code key=value} pairs separated by commas.
     */
    static Map<String, String> parseArgs(String agentArgs) {
        Map<String, String> map = new HashMap<String, String>();
        if (agentArgs == null || agentArgs.trim().isEmpty()) {
            return map;
        }
        if (agentArgs.indexOf('=') < 0) {
            java.util.Properties props = new java.util.Properties();
            try (java.io.Reader r = new InputStreamReader(new java.io.FileInputStream(agentArgs.trim()), StandardCharsets.UTF_8)) {
                props.load(r);
            } catch (Exception e) {
                throw new IllegalStateException("Cannot read calcite probe config " + agentArgs, e);
            }
            for (String key : props.stringPropertyNames()) {
                map.put(key, props.getProperty(key));
            }
            return map;
        }
        for (String part : agentArgs.split(",")) {
            int eq = part.indexOf('=');
            if (eq > 0) {
                map.put(part.substring(0, eq).trim(), part.substring(eq + 1).trim());
            }
        }
        return map;
    }

    /** The name tables to try: {@code mappings.1}, {@code mappings.2}, ...; else {@code mappings} (empty = official). */
    private List<String> nameCandidates() {
        List<String> list = new ArrayList<String>();
        for (int i = 1; args.containsKey("mappings." + i); i++) {
            String value = args.get("mappings." + i);
            list.add(value.isEmpty() ? "official" : value);
        }
        if (list.isEmpty()) {
            String legacy = args.get("mappings");
            list.add(legacy == null || legacy.isEmpty() ? "official" : legacy);
        }
        return list;
    }

    private void run() {
        workers.submit(this::initGame);
        int port = Integer.parseInt(args.get("port"));
        boolean exitOnDisconnect = !"false".equals(args.get("exitOnDisconnect"));
        long lostSince = 0;
        while (true) {
            try {
                Socket socket = new Socket();
                socket.connect(new InetSocketAddress("127.0.0.1", port), 5000);
                socket.setTcpNoDelay(true);
                lostSince = 0;
                serve(socket);
            } catch (Throwable t) {
                // controller not reachable
            }
            if (lostSince == 0) {
                lostSince = System.currentTimeMillis();
            } else if (exitOnDisconnect && System.currentTimeMillis() - lostSince > 15000) {
                System.err.println("[calcite-probe] controller is gone, shutting the client down");
                Runtime.getRuntime().halt(0);
            }
            sleep(1000);
        }
    }

    /** Loads mappings, waits for the Minecraft class and singleton, then starts the game features. */
    private void initGame() {
        try {
            List<String> candidates = nameCandidates();
            Map<String, Mappings> tables = new HashMap<String, Mappings>();
            Ref ref = null;
            while (ref == null) {
                Map<String, Class<?>> loaded = new HashMap<String, Class<?>>();
                for (Class<?> k : instrumentation.getAllLoadedClasses()) {
                    loaded.put(k.getName(), k);
                }
                for (String candidate : candidates) {
                    Mappings m = tables.get(candidate);
                    if (m == null) {
                        m = "official".equals(candidate) ? Mappings.identity() : Mappings.load(new File(candidate).toPath());
                        tables.put(candidate, m);
                    }
                    String runtimeName = m.runtimeClass(MINECRAFT);
                    Class<?> minecraft = runtimeName == null ? null : loaded.get(runtimeName);
                    if (minecraft == null) {
                        continue;
                    }
                    // reflection loads field and method types; they must come from (and be transformed by) the game loader
                    Thread.currentThread().setContextClassLoader(minecraft.getClassLoader());
                    Ref r = new Ref(m, minecraft.getClassLoader());
                    // loaders may keep official class names but rename members: the table must know the fields too
                    if (candidates.size() > 1 && r.field(minecraft, "player") == null) {
                        continue;
                    }
                    mappings = m;
                    names = candidate;
                    gameLoader = minecraft.getClassLoader();
                    ref = r;
                    break;
                }
                if (ref == null) {
                    sleep(500);
                }
            }
            Game g = new Game(ref, "true".equals(args.get("headless")));
            while (g.minecraft() == null) {
                sleep(250);
            }
            startGame(g, ref);
        } catch (Throwable t) {
            initError = t.toString();
            t.printStackTrace();
        }
    }

    /** Registers the game operations, starts the timers and loads the extensions. */
    private void startGame(Game g, Ref ref) {
        World world = new World(g, ref);
        Aim aim = new Aim(g, ref, world);
        Menus menus = new Menus(g, ref, world);
        Controls controls = new Controls(g);
        Status status = new Status(g, ref);
        BlockTerrain terrain = new BlockTerrain(g, ref, world);
        Actions actions = new Actions(g, ref, world, aim, controls);
        Render r = new Render(g, ref);
        Ops.Module[] modules = {
                world, controls, status, actions, r,
                new Session(g, ref),
                new Inventory(g, ref, menus),
                new Navigator(g, aim, controls, terrain, workers),
                new BlockSearch(g, ref, world),
                new Surroundings(g, ref, world, status, terrain),
                new Crafting(g, ref, world, menus, aim, actions, controls),
        };
        for (Ops.Module m : modules) {
            m.register(ops);
        }
        Watcher watcher = new Watcher(g, ref, menus, this::sendEvent);
        render = r;
        game = g;
        timer.scheduleAtFixedRate(guarded(controls::pump), 10, 10, TimeUnit.MILLISECONDS);
        List<String> jars = new ArrayList<String>();
        for (int i = 1; args.containsKey("extensions." + i); i++) {
            jars.add(args.get("extensions." + i));
        }
        if (!jars.isEmpty()) {
            extensions.load(jars, gameLoader, new Base(g, ref));
        }
        if ("off".equals(args.get("render")) && !g.headless()) {
            r.setRender(false);
        }
        timer.scheduleAtFixedRate(guarded(() -> {
            r.enforceRender();
            watcher.poll();
        }), 250, 250, TimeUnit.MILLISECONDS);
    }

    /** A timer task that runs with the game's class loader and never kills the timer. */
    private Runnable guarded(Runnable task) {
        return () -> {
            try {
                useGameLoader();
                task.run();
            } catch (Throwable ignored) {
                // keep the timer alive
            }
        };
    }

    private void useGameLoader() {
        ClassLoader loader = gameLoader;
        if (loader != null && Thread.currentThread().getContextClassLoader() != loader) {
            Thread.currentThread().setContextClassLoader(loader);
        }
    }

    private void serve(final Socket socket) throws Exception {
        final OutputStream out = socket.getOutputStream();
        Map<String, Object> hello = new LinkedHashMap<String, Object>();
        hello.put("type", "hello");
        hello.put("token", args.get("token"));
        hello.put("protocol", PROTOCOL);
        hello.put("java", System.getProperty("java.version"));
        send(out, hello);
        current = out;
        BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.trim().isEmpty()) {
                continue;
            }
            final String request = line;
            workers.submit(() -> handle(out, request));
        }
        current = null;
        socket.close();
    }

    private void sendEvent(String name, Object data) {
        OutputStream out = current;
        if (out == null) {
            return;
        }
        Map<String, Object> event = new LinkedHashMap<String, Object>();
        event.put("type", "event");
        event.put("name", name);
        event.put("data", data);
        event.put("time", System.currentTimeMillis());
        try {
            send(out, event);
        } catch (Throwable ignored) {
            // connection closed
        }
    }

    @SuppressWarnings("unchecked")
    private void handle(OutputStream out, String line) {
        useGameLoader();
        Object id = null;
        Map<String, Object> response = new LinkedHashMap<String, Object>();
        try {
            Map<String, Object> req = (Map<String, Object>) Json.parse(line);
            id = req.get("id");
            Object a = req.get("args");
            Object result = dispatch((String) req.get("op"), a instanceof Map ? (Map<String, Object>) a : new HashMap<String, Object>());
            response.put("id", id);
            response.put("ok", true);
            response.put("result", result);
        } catch (Throwable t) {
            Exception cause = ProbeException.unwrap(t);
            response.clear();
            response.put("id", id);
            response.put("ok", false);
            response.put("code", cause instanceof CalciteException ? ((CalciteException) cause).code() : "error");
            response.put("error", cause.getMessage() == null ? cause.toString() : cause.getMessage());
        }
        try {
            send(out, response);
        } catch (Throwable ignored) {
            // connection closed
        }
    }

    private Object dispatch(String name, Map<String, Object> a) throws Exception {
        Ops.Op op = ops.get(name);
        if (op != null) {
            return op.run(new Args(a));
        }
        if (game == null) {
            // game operations are registered once the game is up
            if (initError != null) {
                throw new ProbeException("init_failed", initError);
            }
            throw new ProbeException("not_ready", "Minecraft is still starting");
        }
        throw new ProbeException("unknown_op", "Unknown operation: " + name);
    }

    private Map<String, Object> info() {
        Map<String, Object> info = new LinkedHashMap<String, Object>();
        info.put("protocol", PROTOCOL);
        info.put("java", System.getProperty("java.version"));
        info.put("ready", game != null);
        info.put("initError", initError);
        info.put("mappedClasses", mappings == null ? 0 : mappings.size());
        info.put("obfuscated", mappings != null && !mappings.isIdentity());
        info.put("names", names);
        if (game != null) {
            info.put("headless", game.headless());
            info.put("renderToggle", render.renderToggleSupported());
        }
        info.put("extensions", extensions.loaded());
        return info;
    }

    /** What extensions get from the probe (unscoped; {@link Extensions} adds the id prefix). */
    private final class Base implements Calcite {
        private final Game g;
        private final Ref ref;

        Base(Game g, Ref ref) {
            this.g = g;
            this.ref = ref;
        }

        @Override
        public Ref ref() {
            return ref;
        }

        @Override
        public Object minecraft() {
            return g.minecraft();
        }

        @Override
        public String minecraftVersion() {
            return args.get("version");
        }

        @Override
        public boolean headless() {
            return g.headless();
        }

        @Override
        public <T> T onGameThread(Callable<T> task, long timeoutMs) throws Exception {
            return g.onGameThread(task, timeoutMs);
        }

        @Override
        public void command(String name, Handler handler) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void command(String name, String description, Map<String, Object> argsSchema, Handler handler) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void emit(String name, Object data) {
            sendEvent(name, data);
        }

        @Override
        public Object call(String op, Map<String, Object> callArgs) throws Exception {
            return dispatch(op, callArgs == null ? new HashMap<String, Object>() : callArgs);
        }

        @Override
        public void log(String message) {
            System.out.println("[calcite] " + message);
        }
    }

    private void send(OutputStream out, Object message) throws Exception {
        byte[] bytes = (Json.write(message) + "\n").getBytes(StandardCharsets.UTF_8);
        synchronized (writeLock) {
            out.write(bytes);
            out.flush();
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static ThreadFactory daemon(final String name) {
        return new ThreadFactory() {
            private int n;

            @Override
            public synchronized Thread newThread(Runnable r) {
                Thread t = new Thread(r, name + "-" + (n++));
                t.setDaemon(true);
                return t;
            }
        };
    }
}
