package calcite.probe;

import java.io.File;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * Version-adaptive access to the running Minecraft client.
 * Every operation tries the API shapes of several game versions (1.14.4 → 26.x) and reports a clear
 * error when none is available.
 */
public final class Game {

    private static final String MINECRAFT = "net.minecraft.client.Minecraft";

    private final Ref ref;
    private final boolean headless;
    private volatile Object minecraft;
    /** Desired value of Minecraft.noRender; null = leave the game alone. */
    private volatile Boolean wantNoRender;

    public Game(Ref ref, boolean headless) {
        this.ref = ref;
        this.headless = headless;
    }

    public boolean headless() {
        return headless;
    }

    /** The Minecraft singleton, or null while the game is still bootstrapping. */
    public Object minecraft() {
        Object mc = minecraft;
        if (mc != null) {
            return mc;
        }
        Class<?> k = ref.cls(MINECRAFT);
        if (k == null) {
            return null;
        }
        try {
            Method getInstance = ref.method(k, "getInstance", 0);
            if (getInstance != null) {
                mc = getInstance.invoke(null);
            }
            if (mc == null) {
                mc = ref.getStatic(k, "instance");
            }
        } catch (Throwable ignored) {
            mc = null;
        }
        minecraft = mc;
        return mc;
    }

    Object requireMinecraft() {
        Object mc = minecraft();
        if (mc == null) {
            throw new ProbeException("not_ready", "Minecraft is still starting");
        }
        return mc;
    }

    /** Runs {@code task} on the render thread and waits for the result. */
    public <T> T onGameThread(final Callable<T> task, long timeoutMs) throws Exception {
        Object mc = requireMinecraft();
        final CompletableFuture<T> future = new CompletableFuture<T>();
        ((Executor) mc).execute(new Runnable() {
            @Override
            public void run() {
                try {
                    future.complete(task.call());
                } catch (Throwable t) {
                    future.completeExceptionally(t);
                }
            }
        });
        try {
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof Exception) {
                throw (Exception) cause;
            }
            throw new RuntimeException(cause);
        }
    }

    // ---------------------------------------------------------------- state

    public Map<String, Object> state() throws Exception {
        final Object mc = minecraft();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ready", mc != null);
        out.put("headless", headless);
        if (mc == null) {
            out.put("inGame", false);
            return out;
        }
        return onGameThread(new Callable<Map<String, Object>>() {
            @Override
            public Map<String, Object> call() throws Exception {
                Map<String, Object> s = new LinkedHashMap<String, Object>();
                s.put("ready", true);
                s.put("headless", headless);
                Object level = optGet(mc, "level");
                Object player = optGet(mc, "player");
                s.put("inGame", level != null && player != null);
                s.put("loading", optGet(mc, "overlay") != null);
                Object screen = screen(mc);
                s.put("screen", screen == null ? null : ref.simpleNamed(screen.getClass()));
                if (screen != null && "DisconnectedScreen".equals(ref.simpleNamed(screen.getClass()))) {
                    s.put("disconnectReason", disconnectReason(screen));
                }
                Object fps = optGet(mc, "fps");
                if (fps instanceof Number) {
                    s.put("fps", ((Number) fps).intValue());
                }
                Object noRender = optGet(mc, "noRender");
                if (noRender instanceof Boolean) {
                    s.put("noRender", noRender);
                }
                if (player != null) {
                    Map<String, Object> p = new LinkedHashMap<String, Object>();
                    p.put("id", optCall(player, "getId"));
                    Object uuid = optCall(player, "getUUID");
                    p.put("uuid", uuid == null ? null : uuid.toString());
                    p.put("name", text(optCall(player, "getName")));
                    double[] pos = position(player);
                    if (pos != null) {
                        p.put("x", pos[0]);
                        p.put("y", pos[1]);
                        p.put("z", pos[2]);
                    }
                    p.put("yaw", rotation(player, "getYRot", "yRot"));
                    p.put("pitch", rotation(player, "getXRot", "xRot"));
                    Object health = optCall(player, "getHealth");
                    if (health instanceof Number) {
                        p.put("health", ((Number) health).doubleValue());
                    }
                    Object food = optCall(optCall(player, "getFoodData"), "getFoodLevel");
                    if (food instanceof Number) {
                        p.put("food", ((Number) food).intValue());
                    }
                    Object mode = optCall(optCall(optGet(mc, "gameMode"), "getPlayerMode"), "getName");
                    if (mode != null) {
                        p.put("gameMode", mode.toString());
                    }
                    p.put("dimension", dimension(level));
                    s.put("player", p);
                }
                return s;
            }
        }, 5000);
    }

    private String disconnectReason(Object screen) {
        Object details = optGet(screen, "details");
        if (details != null) {
            Object reason = optCall(details, "reason");
            if (reason != null) {
                return text(reason);
            }
        }
        Object reason = optGet(screen, "reason");
        return reason == null ? null : text(reason);
    }

    private String dimension(Object level) {
        if (level == null) {
            return null;
        }
        Object key = optCall(level, "dimension");
        if (key == null) {
            return null;
        }
        String s = key.toString();
        // ResourceKey[minecraft:dimension / minecraft:overworld]
        int slash = s.lastIndexOf(" / ");
        if (slash >= 0 && s.endsWith("]")) {
            return s.substring(slash + 3, s.length() - 1);
        }
        return s;
    }

    // ---------------------------------------------------------------- entities

    public List<Map<String, Object>> entities(final double radius, final int limit, final boolean includeSelf) throws Exception {
        final Object mc = requireMinecraft();
        return onGameThread(new Callable<List<Map<String, Object>>>() {
            @Override
            public List<Map<String, Object>> call() throws Exception {
                List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
                Object level = optGet(mc, "level");
                Object player = optGet(mc, "player");
                if (level == null) {
                    return out;
                }
                Object iterable = optCall(level, "entitiesForRendering");
                if (!(iterable instanceof Iterable)) {
                    throw new ProbeException("unsupported", "ClientLevel#entitiesForRendering is not available in this version");
                }
                double[] origin = player == null ? null : position(player);
                Object selfId = player == null ? null : optCall(player, "getId");
                for (Object e : (Iterable<?>) iterable) {
                    if (limit > 0 && out.size() >= limit) {
                        break;
                    }
                    Object id = optCall(e, "getId");
                    if (!includeSelf && selfId != null && selfId.equals(id)) {
                        continue;
                    }
                    double[] pos = position(e);
                    if (radius > 0 && origin != null && pos != null) {
                        double dx = pos[0] - origin[0], dy = pos[1] - origin[1], dz = pos[2] - origin[2];
                        if (dx * dx + dy * dy + dz * dz > radius * radius) {
                            continue;
                        }
                    }
                    out.add(describe(e, pos));
                }
                return out;
            }
        }, 10000);
    }

    Map<String, Object> describe(Object e, double[] pos) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("id", optCall(e, "getId"));
        Object uuid = optCall(e, "getUUID");
        m.put("uuid", uuid instanceof UUID ? uuid.toString() : uuid == null ? null : uuid.toString());
        m.put("type", entityType(e));
        if (pos != null) {
            m.put("x", pos[0]);
            m.put("y", pos[1]);
            m.put("z", pos[2]);
        }
        m.put("yaw", rotation(e, "getYRot", "yRot"));
        m.put("pitch", rotation(e, "getXRot", "xRot"));
        m.put("name", text(optCall(e, "getName")));
        Object custom = optCall(e, "getCustomName");
        if (custom != null) {
            m.put("customName", text(custom));
        }
        Object vehicle = optCall(e, "getVehicle");
        m.put("vehicleId", vehicle == null ? null : optCall(vehicle, "getId"));
        Object invisible = optCall(e, "isInvisible");
        if (invisible instanceof Boolean) {
            m.put("invisible", invisible);
        }
        Object removed = optCall(e, "isRemoved");
        if (removed == null) {
            removed = optGet(e, "removed");
        }
        if (removed instanceof Boolean) {
            m.put("removed", removed);
        }
        return m;
    }

    private String entityType(Object e) {
        Object type = optCall(e, "getType");
        if (type == null) {
            return null;
        }
        Class<?> typeClass = ref.cls("net.minecraft.world.entity.EntityType");
        if (typeClass != null) {
            Method getKey = ref.method(typeClass, "getKey", 1);
            if (getKey != null) {
                try {
                    Object key = getKey.invoke(null, type);
                    if (key != null) {
                        return key.toString();
                    }
                } catch (Throwable ignored) {
                    // fall through
                }
            }
        }
        Object shortName = optCall(type, "toShortString");
        return shortName != null ? String.valueOf(shortName) : type.toString();
    }

    /** Entity position as {x, y, z}; supports getX() (1.15+), position()/Vec3 and legacy public fields. */
    double[] position(Object e) {
        Object x = optCall(e, "getX");
        Object y = optCall(e, "getY");
        Object z = optCall(e, "getZ");
        if (x instanceof Number && y instanceof Number && z instanceof Number) {
            return new double[]{((Number) x).doubleValue(), ((Number) y).doubleValue(), ((Number) z).doubleValue()};
        }
        Object vec = optCall(e, "position");
        if (vec != null) {
            Object vx = optGet(vec, "x"), vy = optGet(vec, "y"), vz = optGet(vec, "z");
            if (vx instanceof Number && vy instanceof Number && vz instanceof Number) {
                return new double[]{((Number) vx).doubleValue(), ((Number) vy).doubleValue(), ((Number) vz).doubleValue()};
            }
        }
        x = optGet(e, "x");
        y = optGet(e, "y");
        z = optGet(e, "z");
        if (x instanceof Number && y instanceof Number && z instanceof Number) {
            return new double[]{((Number) x).doubleValue(), ((Number) y).doubleValue(), ((Number) z).doubleValue()};
        }
        return null;
    }

    Double rotation(Object e, String method, String field) {
        Object v = optCall(e, method);
        if (v == null) {
            v = optGet(e, field);
        }
        return v instanceof Number ? ((Number) v).doubleValue() : null;
    }

    // ---------------------------------------------------------------- chat / commands

    public void chat(final String message) throws Exception {
        final Object mc = requireMinecraft();
        onGameThread(new Callable<Object>() {
            @Override
            public Object call() throws Exception {
                Object player = requirePlayer(mc);
                Object conn = optGet(player, "connection");
                if (conn != null && invoke(conn, "sendChat", message)) {
                    return null; // 1.19.3+
                }
                if (invoke(player, "chatSigned", message, null)) {
                    return null; // 1.19.1 - 1.19.2
                }
                if (invoke(player, "chat", message)) {
                    return null; // <= 1.19
                }
                throw new ProbeException("unsupported", "No chat API found for this version");
            }
        }, 5000);
    }

    public void command(String raw) throws Exception {
        final String command = raw.startsWith("/") ? raw.substring(1) : raw;
        final Object mc = requireMinecraft();
        onGameThread(new Callable<Object>() {
            @Override
            public Object call() throws Exception {
                Object player = requirePlayer(mc);
                Object conn = optGet(player, "connection");
                if (conn != null && (invoke(conn, "sendCommand", command) || invoke(conn, "sendUnsignedCommand", command))) {
                    return null; // 1.19.3+
                }
                if (invoke(player, "commandUnsigned", command) || invoke(player, "commandSigned", command, null)
                        || invoke(player, "command", command)) {
                    return null; // 1.19 - 1.19.2
                }
                if (invoke(player, "chat", "/" + command)) {
                    return null; // <= 1.18
                }
                throw new ProbeException("unsupported", "No command API found for this version");
            }
        }, 5000);
    }

    public void respawn() throws Exception {
        final Object mc = requireMinecraft();
        onGameThread(new Callable<Object>() {
            @Override
            public Object call() throws Exception {
                Object player = requirePlayer(mc);
                if (!invoke(player, "respawn")) {
                    throw new ProbeException("unsupported", "LocalPlayer#respawn is not available");
                }
                // close the death screen
                setScreen(mc, null);
                return null;
            }
        }, 5000);
    }

    /**
     * Joins a server from the current screen through the game's own ConnectScreen. Used for versions without
     * Quick Play, where the --server argument can be ignored (e.g. 1.16.4+ when multiplayer privileges are unknown).
     */
    public void connect(final String host, final int port) throws Exception {
        final Object mc = requireMinecraft();
        onGameThread(new Callable<Object>() {
            @Override
            public Object call() throws Exception {
                Class<?> connect = ref.cls("net.minecraft.client.gui.screens.ConnectScreen");
                if (connect == null) {
                    throw new ProbeException("unsupported", "ConnectScreen not found");
                }
                Class<?> titleClass = ref.cls("net.minecraft.client.gui.screens.TitleScreen");
                Object parent = titleClass == null ? screen(mc) : titleClass.getConstructor().newInstance();
                // 1.17+: static startConnecting(Screen, Minecraft, ServerAddress, ServerData[, boolean[, TransferState]])
                for (int n = 6; n >= 4; n--) {
                    Method m = ref.method(connect, "startConnecting", n);
                    if (m != null && java.lang.reflect.Modifier.isStatic(m.getModifiers())) {
                        m.invoke(null, connectArgs(m.getParameterTypes(), mc, parent, host, port));
                        return null;
                    }
                }
                // 1.14 - 1.16: new ConnectScreen(Screen, Minecraft, String, int)
                for (java.lang.reflect.Constructor<?> c : connect.getConstructors()) {
                    Class<?>[] types = c.getParameterTypes();
                    if (types.length == 4 && types[2] == String.class && types[3] == int.class) {
                        Object screen = c.newInstance(connectArgs(types, mc, parent, host, port));
                        setScreen(mc, screen);
                        return null;
                    }
                }
                throw new ProbeException("unsupported", "No compatible ConnectScreen entry point in this version");
            }
        }, 10000);
    }

    private Object[] connectArgs(Class<?>[] types, Object mc, Object parent, String host, int port) throws Exception {
        Object[] args = new Object[types.length];
        boolean stringUsed = false;
        for (int i = 0; i < types.length; i++) {
            Class<?> t = types[i];
            String named = ref.named(t);
            if (t == String.class && !stringUsed) {
                args[i] = host;
                stringUsed = true;
            } else if (t == int.class) {
                args[i] = port;
            } else if (t == boolean.class) {
                args[i] = false;
            } else if (t.isInstance(mc)) {
                args[i] = mc;
            } else if (parent != null && t.isInstance(parent)) {
                args[i] = parent;
            } else if (named.endsWith(".ServerAddress")) {
                args[i] = t.getConstructor(String.class, int.class).newInstance(host, port);
            } else if (named.endsWith(".ServerData")) {
                args[i] = serverData(t, host + ":" + port);
            } else {
                args[i] = null;
            }
        }
        return args;
    }

    /** new ServerData("Calcite", ip, ...) across its constructor variants; null when none fits. */
    private Object serverData(Class<?> type, String ip) {
        for (java.lang.reflect.Constructor<?> c : type.getConstructors()) {
            Class<?>[] p = c.getParameterTypes();
            if (p.length != 3 || p[0] != String.class || p[1] != String.class) {
                continue;
            }
            try {
                if (p[2] == boolean.class) {
                    return c.newInstance("Calcite", ip, false);
                }
                if (p[2].isEnum()) {
                    Object[] constants = p[2].getEnumConstants();
                    Object other = constants[constants.length - 1];
                    Mappings.ClassEntry entry = ref.mappings().byRuntime(p[2].getName());
                    String otherName = entry == null || entry.field("OTHER") == null ? "OTHER" : entry.field("OTHER");
                    for (Object k : constants) {
                        if (otherName.equals(((Enum<?>) k).name())) {
                            other = k;
                        }
                    }
                    return c.newInstance("Calcite", ip, other);
                }
            } catch (Throwable ignored) {
                // try the next constructor
            }
        }
        return null;
    }

    Object requirePlayer(Object mc) {
        Object player = optGet(mc, "player");
        if (player == null) {
            throw new ProbeException("not_in_game", "The client is not in a world");
        }
        return player;
    }

    // ---------------------------------------------------------------- rendering

    /** Sets whether the world is rendered; enforced continuously by {@link #enforceRender()}. */
    public void setRender(boolean render) {
        wantNoRender = !render;
        enforceRender();
    }

    /** Re-applies the desired render state (opening any screen resets Minecraft.noRender). */
    public void enforceRender() {
        final Boolean want = wantNoRender;
        final Object mc = minecraft();
        if (want == null || mc == null) {
            return;
        }
        final java.lang.reflect.Field f = ref.field(mc.getClass(), "noRender");
        if (f == null) {
            return;
        }
        ((Executor) mc).execute(new Runnable() {
            @Override
            public void run() {
                try {
                    // Overlays (the resource-loading screen) only advance while being rendered; suppressing
                    // rendering then would stall startup or a resource reload forever.
                    boolean effective = want && optGet(mc, "overlay") == null;
                    if (f.getBoolean(mc) != effective) {
                        f.setBoolean(mc, effective);
                    }
                } catch (Throwable ignored) {
                    // best effort
                }
            }
        });
    }

    public boolean renderToggleSupported() {
        Object mc = minecraft();
        return mc != null && ref.field(mc.getClass(), "noRender") != null;
    }

    /**
     * Renders a few frames (if rendering is normally off) and saves a screenshot through the game's own
     * screenshot code. Returns the absolute path of the PNG.
     */
    public String screenshot(final String fileName, int settleFrames, long timeoutMs) throws Exception {
        if (headless) {
            throw new ProbeException("headless", "The client runs without a renderer (headless); screenshots need a display");
        }
        final Object mc = requireMinecraft();
        final Boolean previous = wantNoRender;
        wantNoRender = false;
        enforceRender();
        try {
            waitFrames(mc, Math.max(2, settleFrames), timeoutMs);
            if (waitSections(mc, Math.min(5000, timeoutMs / 2))) {
                waitFrames(mc, 2, timeoutMs);
            }
            final File gameDir = (File) ref.get(mc, "gameDirectory");
            final File dir = new File(gameDir, "screenshots");
            final long started = System.currentTimeMillis();
            final CompletableFuture<Object> done = new CompletableFuture<Object>();
            onGameThread(new Callable<Object>() {
                @Override
                public Object call() throws Exception {
                    grab(mc, gameDir, fileName, new Consumer<Object>() {
                        @Override
                        public void accept(Object message) {
                            done.complete(message);
                        }
                    });
                    return null;
                }
            }, timeoutMs);
            Object message = done.get(timeoutMs, TimeUnit.MILLISECONDS);
            File expected = new File(dir, fileName);
            File file = expected.isFile() ? expected : newestPng(dir, started);
            if (file == null) {
                throw new ProbeException("screenshot_failed", "Screenshot was not written: " + text(message));
            }
            return file.getAbsolutePath();
        } finally {
            wantNoRender = previous;
            enforceRender();
        }
    }

    private void grab(Object mc, File gameDir, String name, Consumer<Object> callback) throws Exception {
        Class<?> screenshot = ref.cls("net.minecraft.client.Screenshot");
        if (screenshot == null) {
            throw new ProbeException("unsupported", "net.minecraft.client.Screenshot not found");
        }
        Object target = optCall(mc, "getMainRenderTarget");
        if (target == null) {
            // 26.x: the main render target belongs to the GameRenderer
            Object gameRenderer = optGet(mc, "gameRenderer");
            if (gameRenderer != null) target = optCall(gameRenderer, "mainRenderTarget");
        }
        if (target == null) {
            throw new ProbeException("unsupported", "Main render target not found");
        }
        String rt = "com.mojang.blaze3d.pipeline.RenderTarget";
        Method m;
        // 1.21.x: grab(File, String, RenderTarget, int downscale, Consumer)
        if ((m = ref.method(screenshot, "grab", 5, "java.io.File", "java.lang.String", rt, "int", "java.util.function.Consumer")) != null) {
            m.invoke(null, gameDir, name, target, 1, callback);
            return;
        }
        // 1.17 - 1.21.4: grab(File, String, RenderTarget, Consumer)
        if ((m = ref.method(screenshot, "grab", 4, "java.io.File", "java.lang.String", rt, "java.util.function.Consumer")) != null) {
            m.invoke(null, gameDir, name, target, callback);
            return;
        }
        int[] size = framebufferSize(mc, target);
        // 1.14 - 1.16: grab(File, String, int width, int height, RenderTarget, Consumer)
        if ((m = ref.method(screenshot, "grab", 6, "java.io.File", "java.lang.String", "int", "int", rt, "java.util.function.Consumer")) != null) {
            m.invoke(null, gameDir, name, size[0], size[1], target, callback);
            return;
        }
        if ((m = ref.method(screenshot, "grab", 3, "java.io.File", rt, "java.util.function.Consumer")) != null) {
            m.invoke(null, gameDir, target, callback);
            return;
        }
        if ((m = ref.method(screenshot, "grab", 5, "java.io.File", "int", "int", rt, "java.util.function.Consumer")) != null) {
            m.invoke(null, gameDir, size[0], size[1], target, callback);
            return;
        }
        throw new ProbeException("unsupported", "No compatible Screenshot#grab signature in this version");
    }

    private int[] framebufferSize(Object mc, Object target) {
        Object w = optGet(target, "width"), h = optGet(target, "height");
        if (w instanceof Number && h instanceof Number) {
            return new int[]{((Number) w).intValue(), ((Number) h).intValue()};
        }
        Object window = optCall(mc, "getWindow");
        Object ww = optCall(window, "getWidth"), wh = optCall(window, "getHeight");
        if (ww instanceof Number && wh instanceof Number) {
            return new int[]{((Number) ww).intValue(), ((Number) wh).intValue()};
        }
        return new int[]{854, 480};
    }

    /**
     * While the world was not rendered no chunk meshes were built; waits (bounded) until the level renderer has
     * compiled every visible section so the screenshot is not missing terrain. Returns whether it had to wait.
     */
    private boolean waitSections(Object mc, long maxMs) throws InterruptedException {
        Object levelRenderer = optGet(mc, "levelRenderer");
        if (levelRenderer == null || optGet(mc, "level") == null) {
            return false;
        }
        // "All sections rendered" is also true before the first frames queued anything (right after joining or
        // after rendering was off), so the number of rendered sections must be non-zero and settled as well.
        long start = System.currentTimeMillis();
        long deadline = start + maxMs;
        boolean waited = false;
        int last = -1;
        int stable = 0;
        while (System.currentTimeMillis() < deadline) {
            Object done = optCall(levelRenderer, "hasRenderedAllSections");
            if (done == null) {
                done = optCall(levelRenderer, "hasRenderedAllChunks");
            }
            boolean queueEmpty = !Boolean.FALSE.equals(done);
            int rendered = renderedSections(levelRenderer);
            stable = rendered == last ? stable + 1 : 0;
            last = rendered;
            if (queueEmpty) {
                if (rendered == -1) {
                    return waited; // count not available in this version
                }
                if (rendered > 0 && stable >= 3) {
                    return waited;
                }
                if (rendered == 0 && System.currentTimeMillis() - start > 1500) {
                    return waited; // nothing to draw (void, or no chunks sent)
                }
            }
            waited = true;
            Thread.sleep(50);
        }
        return waited;
    }

    /**
     * Number of sections drawn in the last frame; -1 when this version offers no way to tell, -2 when reading it
     * raced with the render thread (try again).
     */
    private int renderedSections(Object levelRenderer) {
        for (String name : new String[] {"countRenderedSections", "countRenderedChunks", "visibleSections"}) {
            Method m = ref.method(levelRenderer.getClass(), name, 0);
            if (m == null) {
                continue;
            }
            try {
                Object n = m.invoke(levelRenderer);
                if (n instanceof Number) {
                    return ((Number) n).intValue();
                }
                if (n instanceof java.util.Collection) {
                    return ((java.util.Collection<?>) n).size(); // 26.x
                }
            } catch (Throwable t) {
                return -2; // e.g. ConcurrentModificationException while the render thread updates the list
            }
        }
        return -1;
    }

    /**
     * Waits until the client rendered {@code count} more frames. {@code Minecraft.frames} is the per-second fps
     * counter (reset to 0 every second), so changes of its value are counted rather than its absolute growth.
     */
    private void waitFrames(Object mc, int count, long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        java.lang.reflect.Field noRender = ref.field(mc.getClass(), "noRender");
        while (noRender != null && noRender.getBoolean(mc)) {
            if (System.currentTimeMillis() > deadline) {
                throw new ProbeException("timeout", "Rendering could not be enabled in time");
            }
            Thread.sleep(2);
        }
        java.lang.reflect.Field frames = ref.field(mc.getClass(), "frames");
        if (frames == null) {
            Thread.sleep(400);
            return;
        }
        int last = frames.getInt(mc);
        int seen = 0;
        while (seen < count) {
            if (System.currentTimeMillis() > deadline) {
                throw new ProbeException("timeout", "The client did not render frames in time");
            }
            Thread.sleep(2);
            int now = frames.getInt(mc);
            if (now != last) {
                seen++;
                last = now;
            }
        }
    }

    private static File newestPng(File dir, long since) {
        File[] files = dir.listFiles();
        File best = null;
        if (files != null) {
            for (File f : files) {
                if (f.getName().endsWith(".png") && f.lastModified() >= since - 1000 && (best == null || f.lastModified() > best.lastModified())) {
                    best = f;
                }
            }
        }
        return best;
    }

    // ---------------------------------------------------------------- helpers

    /** Component → plain text (getString), tolerating plain strings and nulls. */
    /** The open screen; 26.x keeps it in Minecraft.gui. */
    Object screen(Object mc) {
        Object screen = optGet(mc, "screen");
        if (screen == null) {
            Object gui = optGet(mc, "gui");
            screen = gui == null ? null : optGet(gui, "screen");
        }
        return screen;
    }

    void setScreen(Object mc, Object screen) throws Exception {
        Object target = mc;
        Method m = ref.method(mc.getClass(), "setScreen", 1);
        if (m == null) {
            target = optGet(mc, "gui");
            m = target == null ? null : ref.method(target.getClass(), "setScreen", 1);
        }
        if (m == null) {
            throw new ProbeException("unsupported", "setScreen is not available");
        }
        m.invoke(target, screen);
    }

    String text(Object component) {
        if (component == null) {
            return null;
        }
        if (component instanceof String) {
            return (String) component;
        }
        Object s = optCall(component, "getString");
        return s != null ? s.toString() : component.toString();
    }

    Object optGet(Object target, String field) {
        if (target == null) {
            return null;
        }
        try {
            java.lang.reflect.Field f = ref.field(target.getClass(), field);
            return f == null ? null : f.get(target);
        } catch (Throwable t) {
            return null;
        }
    }

    Object optCall(Object target, String method) {
        if (target == null) {
            return null;
        }
        try {
            Method m = ref.method(target.getClass(), method, 0);
            return m == null ? null : m.invoke(target);
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * Invokes {@code target.name(args)} when a method with that name and arity exists (String parameters are
     * preferred). Returns false when no such method exists; rethrows failures of the call itself.
     */
    boolean invoke(Object target, String name, Object... args) throws Exception {
        Method m = null;
        if (args.length > 0 && args[0] instanceof String) {
            String[] types = new String[args.length];
            types[0] = "java.lang.String";
            m = ref.method(target.getClass(), name, args.length, types);
        }
        if (m == null) {
            m = ref.method(target.getClass(), name, args.length);
        }
        if (m == null) {
            return false;
        }
        try {
            m.invoke(target, args);
        } catch (java.lang.reflect.InvocationTargetException e) {
            Throwable cause = e.getCause();
            throw cause instanceof Exception ? (Exception) cause : new RuntimeException(cause);
        }
        return true;
    }

    /** Signals an error with a stable machine-readable code. */
    public static final class ProbeException extends RuntimeException {
        public final String code;

        public ProbeException(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
