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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * Java agent loaded into the Minecraft client by Calcite.
 *
 * <p>Agent arguments (comma separated {@code key=value}): {@code port}, {@code token}, {@code mappings.1},
 * {@code mappings.2}, ... (name tables to try in order: a mapping file in Mojang's format, or {@code official} for a
 * game running with official names; {@code mappings} is read when there are none), {@code headless} (true when
 * HeadlessMC replaced the renderer), {@code render} ({@code on}|{@code off}: initial world rendering),
 * {@code exitOnDisconnect}.</p>
 *
 * <p>Protocol: one JSON object per line over TCP to 127.0.0.1:port. The probe sends a {@code hello} with the token,
 * then answers requests {@code {"id":1,"op":"state","args":{}}} with {@code {"id":1,"ok":true,"result":...}} or
 * {@code {"id":1,"ok":false,"code":"...","error":"..."}}.</p>
 */
public final class Probe {

    public static final int PROTOCOL = 1;
    private static final String MINECRAFT = "net.minecraft.client.Minecraft";

    private final Map<String, String> args;
    private final Instrumentation instrumentation;
    private final ExecutorService workers = Executors.newCachedThreadPool(daemon("calcite-probe-worker"));
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(daemon("calcite-probe-timer"));
    private volatile Game game;
    private volatile Actions actions;
    private volatile World world;
    private volatile Inventory inventory;
    private volatile Session session;
    private volatile Render render;
    private volatile String initError;
    private Mappings mappings;
    private String names;
    /** Loader of the game classes; probe threads use it as context loader (Forge's transformers resolve through it). */
    private volatile ClassLoader gameLoader;
    private final Object writeLock = new Object();

    private Probe(Map<String, String> args, Instrumentation instrumentation) {
        this.args = args;
        this.instrumentation = instrumentation;
    }

    public static void premain(String agentArgs, Instrumentation inst) {
        start(agentArgs, inst);
    }

    public static void agentmain(String agentArgs, Instrumentation inst) {
        start(agentArgs, inst);
    }

    private static void start(String agentArgs, Instrumentation inst) {
        final Probe probe = new Probe(parseArgs(agentArgs), inst);
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                probe.run();
            }
        }, "calcite-probe");
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
        workers.submit(new Runnable() {
            @Override
            public void run() {
                initGame();
            }
        });
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

    /** Loads mappings, waits for the Minecraft class and singleton, then applies the initial render mode. */
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
            World w = new World(g, ref);
            final Actions a = new Actions(g, ref, w);
            final Render r = new Render(g, ref);
            world = w;
            actions = a;
            inventory = new Inventory(g, ref, w);
            session = new Session(g, ref);
            render = r;
            game = g;
            timer.scheduleAtFixedRate(new Runnable() {
                @Override
                public void run() {
                    try {
                        useGameLoader();
                        a.pump();
                    } catch (Throwable ignored) {
                        // keep the timer alive
                    }
                }
            }, 10, 10, TimeUnit.MILLISECONDS);
            if ("off".equals(args.get("render")) && !g.headless()) {
                r.setRender(false);
            }
            timer.scheduleAtFixedRate(new Runnable() {
                @Override
                public void run() {
                    try {
                        useGameLoader();
                        r.enforceRender();
                    } catch (Throwable ignored) {
                        // keep the timer alive
                    }
                }
            }, 250, 250, TimeUnit.MILLISECONDS);
        } catch (Throwable t) {
            initError = t.toString();
            t.printStackTrace();
        }
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
        BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.trim().isEmpty()) {
                continue;
            }
            final String request = line;
            workers.submit(new Runnable() {
                @Override
                public void run() {
                    handle(out, request);
                }
            });
        }
        socket.close();
    }

    @SuppressWarnings("unchecked")
    private void handle(OutputStream out, String line) {
        useGameLoader();
        Object id = null;
        Map<String, Object> response = new LinkedHashMap<String, Object>();
        try {
            Map<String, Object> req = (Map<String, Object>) Json.parse(line);
            id = req.get("id");
            String op = (String) req.get("op");
            Map<String, Object> a = req.get("args") instanceof Map ? (Map<String, Object>) req.get("args") : new HashMap<String, Object>();
            response.put("id", id);
            response.put("ok", true);
            response.put("result", dispatch(op, a));
        } catch (Throwable t) {
            Throwable cause = t;
            while (cause instanceof java.lang.reflect.InvocationTargetException && cause.getCause() != null) {
                cause = cause.getCause();
            }
            response.clear();
            response.put("id", id);
            response.put("ok", false);
            response.put("code", cause instanceof Game.ProbeException ? ((Game.ProbeException) cause).code : "error");
            response.put("error", cause.getMessage() == null ? cause.toString() : cause.getMessage());
        }
        try {
            send(out, response);
        } catch (Throwable ignored) {
            // connection closed
        }
    }

    private Object dispatch(String op, Map<String, Object> a) throws Exception {
        if ("ping".equals(op)) {
            return "pong";
        }
        if ("info".equals(op)) {
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
            return info;
        }
        Game g = game;
        if (g == null) {
            if (initError != null) {
                throw new Game.ProbeException("init_failed", initError);
            }
            throw new Game.ProbeException("not_ready", "Minecraft is still starting");
        }
        if ("state".equals(op)) {
            return g.state();
        }
        if ("entities".equals(op)) {
            return g.entities(num(a.get("radius"), 0), (int) num(a.get("limit"), 0), Boolean.TRUE.equals(a.get("includeSelf")));
        }
        if ("chat".equals(op)) {
            session.chat(str(a, "message"));
            return true;
        }
        if ("command".equals(op)) {
            session.command(str(a, "command"));
            return true;
        }
        if ("render".equals(op)) {
            if (g.headless()) {
                throw new Game.ProbeException("headless", "The client runs without a renderer (headless)");
            }
            render.setRender(Boolean.TRUE.equals(a.get("enabled")));
            return true;
        }
        if ("screenshot".equals(op)) {
            return render.screenshot(str(a, "name"), (int) num(a.get("settleFrames"), 3), (long) num(a.get("timeoutMs"), 20000));
        }
        if ("connect".equals(op)) {
            session.connect(str(a, "host"), (int) num(a.get("port"), 25565));
            return true;
        }
        if ("respawn".equals(op)) {
            session.respawn();
            return true;
        }
        Actions act = actions;
        if ("look".equals(op)) {
            double[] at = a.containsKey("x") ? new double[]{num(a.get("x"), 0), num(a.get("y"), 0), num(a.get("z"), 0)} : null;
            return act.look(optNum(a.get("yaw")), optNum(a.get("pitch")), at);
        }
        if ("move".equals(op)) {
            return act.move(a, (int) num(a.get("ticks"), 0));
        }
        if ("stop".equals(op)) {
            act.stop();
            return true;
        }
        if ("walk_to".equals(op)) {
            return act.walkTo(num(a.get("x"), 0), num(a.get("z"), 0), num(a.get("range"), 0.5),
                    !Boolean.FALSE.equals(a.get("sprint")), (long) num(a.get("timeoutMs"), 60000));
        }
        if ("attack".equals(op)) {
            return act.attack(optInt(a.get("entityId")));
        }
        if ("use".equals(op)) {
            return act.use(optInt(a.get("entityId")), a.containsKey("x") ? pos(a) : null, (String) a.get("face"), (int) num(a.get("holdTicks"), 0));
        }
        if ("dig".equals(op)) {
            return act.dig(pos(a), (String) a.get("face"), (long) num(a.get("timeoutMs"), 30000));
        }
        if ("block".equals(op)) {
            return world.block(pos(a));
        }
        if ("target".equals(op)) {
            return world.target();
        }
        if ("inventory".equals(op)) {
            return inventory.inventory();
        }
        if ("select_slot".equals(op)) {
            return inventory.selectSlot((int) num(a.get("slot"), -1));
        }
        if ("container".equals(op)) {
            return inventory.container((long) num(a.get("waitMs"), 0));
        }
        if ("click".equals(op)) {
            Object mode = a.get("mode");
            return inventory.click((int) num(a.get("slot"), -1), (int) num(a.get("button"), 0), mode instanceof String ? (String) mode : "pickup");
        }
        if ("close_container".equals(op)) {
            inventory.closeContainer();
            return true;
        }
        if ("drop".equals(op)) {
            return inventory.drop(Boolean.TRUE.equals(a.get("all")));
        }
        throw new Game.ProbeException("unknown_op", "Unknown operation: " + op);
    }

    private static String str(Map<String, Object> a, String key) {
        Object v = a.get(key);
        if (!(v instanceof String)) {
            throw new Game.ProbeException("bad_request", "Missing string argument: " + key);
        }
        return (String) v;
    }

    private static int[] pos(Map<String, Object> a) {
        for (String k : new String[]{"x", "y", "z"}) {
            if (!(a.get(k) instanceof Number)) {
                throw new Game.ProbeException("bad_request", "Missing block coordinate: " + k);
            }
        }
        return new int[]{(int) Math.floor(num(a.get("x"), 0)), (int) Math.floor(num(a.get("y"), 0)), (int) Math.floor(num(a.get("z"), 0))};
    }

    private static Double optNum(Object v) {
        return v instanceof Number ? ((Number) v).doubleValue() : null;
    }

    private static Integer optInt(Object v) {
        return v instanceof Number ? ((Number) v).intValue() : null;
    }

    private static double num(Object v, double def) {
        return v instanceof Number ? ((Number) v).doubleValue() : def;
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
