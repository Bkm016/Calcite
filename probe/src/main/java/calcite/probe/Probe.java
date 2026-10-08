package calcite.probe;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.instrument.Instrumentation;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * Java agent loaded into the Minecraft client by Calcite.
 *
 * <p>Agent arguments (comma separated {@code key=value}): {@code port}, {@code token}, {@code mappings} (path to the
 * Mojang client mappings, empty for unobfuscated versions), {@code headless} (true when HeadlessMC replaced the
 * renderer), {@code render} ({@code on}|{@code off}: initial world rendering), {@code exitOnDisconnect}.</p>
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
    private volatile String initError;
    private Mappings mappings;
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
            String mappingsPath = args.get("mappings");
            mappings = mappingsPath == null || mappingsPath.isEmpty()
                    ? Mappings.identity()
                    : Mappings.load(new File(mappingsPath).toPath());
            String runtimeName = mappings.runtimeClass(MINECRAFT);
            if (runtimeName == null) {
                throw new IllegalStateException("Mappings do not contain " + MINECRAFT);
            }
            Class<?> minecraft = null;
            while (minecraft == null) {
                for (Class<?> k : instrumentation.getAllLoadedClasses()) {
                    if (k.getName().equals(runtimeName)) {
                        minecraft = k;
                        break;
                    }
                }
                if (minecraft == null) {
                    sleep(500);
                }
            }
            Ref ref = new Ref(mappings, minecraft.getClassLoader());
            Game g = new Game(ref, "true".equals(args.get("headless")));
            while (g.minecraft() == null) {
                sleep(250);
            }
            game = g;
            if ("off".equals(args.get("render")) && !g.headless()) {
                g.setRender(false);
            }
            timer.scheduleAtFixedRate(new Runnable() {
                @Override
                public void run() {
                    try {
                        game.enforceRender();
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
            if (game != null) {
                info.put("headless", game.headless());
                info.put("renderToggle", game.renderToggleSupported());
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
            g.chat(str(a, "message"));
            return true;
        }
        if ("command".equals(op)) {
            g.command(str(a, "command"));
            return true;
        }
        if ("render".equals(op)) {
            if (g.headless()) {
                throw new Game.ProbeException("headless", "The client runs without a renderer (headless)");
            }
            g.setRender(Boolean.TRUE.equals(a.get("enabled")));
            return true;
        }
        if ("screenshot".equals(op)) {
            return g.screenshot(str(a, "name"), (int) num(a.get("settleFrames"), 3), (long) num(a.get("timeoutMs"), 20000));
        }
        if ("connect".equals(op)) {
            g.connect(str(a, "host"), (int) num(a.get("port"), 25565));
            return true;
        }
        if ("respawn".equals(op)) {
            g.respawn();
            return true;
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
