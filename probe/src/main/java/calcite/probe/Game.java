package calcite.probe;

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

    Object requirePlayer(Object mc) {
        Object player = optGet(mc, "player");
        if (player == null) {
            throw new ProbeException("not_in_game", "The client is not in a world");
        }
        return player;
    }

    // ---------------------------------------------------------------- helpers

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

    /** Component → plain text (getString), tolerating plain strings and nulls. */
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
