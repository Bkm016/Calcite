package calcite.probe;

import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Version-adaptive access to the running Minecraft client.
 * Helpers try the API shapes of several game versions (1.14.4 → 26.x) and report a clear error when none fits.
 */
public final class Game {

    private static final String MINECRAFT = "net.minecraft.client.Minecraft";
    static final long TIMEOUT_MS = 5000;

    /** Work that needs the player; runs on the game thread. */
    interface PlayerTask<T> {
        T run(Object mc, Object player) throws Exception;
    }

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

    /** Runs {@code task} on the render thread and waits for the result (directly when already on it). */
    public <T> T onGameThread(final Callable<T> task, long timeoutMs) throws Exception {
        Object mc = requireMinecraft();
        if (Boolean.TRUE.equals(optCall(mc, "isSameThread"))) {
            return task.call();
        }
        final CompletableFuture<T> future = new CompletableFuture<T>();
        ((Executor) mc).execute(() -> {
            try {
                future.complete(task.call());
            } catch (Throwable t) {
                future.completeExceptionally(t);
            }
        });
        try {
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.ExecutionException e) {
            throw ProbeException.unwrap(e);
        }
    }

    /**
     * Queues {@code task} on the game thread without waiting, unless the task queued earlier with the same
     * {@code busy} flag has not run yet. For polling from the probe timer, which must never block.
     */
    void runLater(final AtomicBoolean busy, final Runnable task) {
        Object mc = minecraft();
        if (mc == null || !busy.compareAndSet(false, true)) {
            return;
        }
        try {
            ((Executor) mc).execute(() -> {
                try {
                    task.run();
                } finally {
                    busy.set(false);
                }
            });
        } catch (RuntimeException e) {
            busy.set(false);
        }
    }

    /** Runs {@code task} with the local player on the game thread; fails with {@code not_in_game} outside a world. */
    <T> T withPlayer(final PlayerTask<T> task) throws Exception {
        final Object mc = requireMinecraft();
        return onGameThread(() -> task.run(mc, requirePlayer(mc)), TIMEOUT_MS);
    }

    Object requirePlayer(Object mc) {
        Object player = optGet(mc, "player");
        if (player == null) {
            throw new ProbeException("not_in_game", "The client is not in a world");
        }
        return player;
    }

    // ---------------------------------------------------------------- entities

    /** id, type, position, rotation and name of an entity. */
    Map<String, Object> describe(Object e) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("id", optCall(e, "getId"));
        Object uuid = optCall(e, "getUUID");
        m.put("uuid", uuid == null ? null : uuid.toString());
        m.put("type", entityType(e));
        double[] pos = position(e);
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

    /** Registry id of an entity's type, e.g. "minecraft:zombie". */
    String entityType(Object e) {
        Object type = optCall(e, "getType");
        if (type == null) {
            return null;
        }
        Class<?> typeClass = ref.cls("net.minecraft.world.entity.EntityType");
        Method getKey = typeClass == null ? null : ref.method(typeClass, "getKey", 1);
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
        Object shortName = optCall(type, "toShortString");
        return shortName != null ? String.valueOf(shortName) : type.toString();
    }

    /** Entity position as {x, y, z}; supports getX() (1.15+), position()/Vec3 and legacy public fields. */
    double[] position(Object e) {
        double[] p = vec(optCall(e, "getX"), optCall(e, "getY"), optCall(e, "getZ"));
        if (p == null) {
            Object v = optCall(e, "position");
            p = v == null ? null : vec(optGet(v, "x"), optGet(v, "y"), optGet(v, "z"));
        }
        return p != null ? p : vec(optGet(e, "x"), optGet(e, "y"), optGet(e, "z"));
    }

    private static double[] vec(Object x, Object y, Object z) {
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

    /** Health of a living entity, or -1 when unknown. */
    double health(Object living) {
        Object v = optCall(living, "getHealth");
        return v instanceof Number ? ((Number) v).doubleValue() : -1;
    }

    boolean onGround(Object entity) {
        Object v = optCall(entity, "onGround");
        if (v == null) {
            v = optCall(entity, "isOnGround");
        }
        if (v == null) {
            v = optGet(entity, "onGround");
        }
        return Boolean.TRUE.equals(v);
    }

    boolean inFluid(Object entity) {
        return Boolean.TRUE.equals(optCall(entity, "isInWater")) || Boolean.TRUE.equals(optCall(entity, "isInLava"));
    }

    /** Dimension id of a level, e.g. "minecraft:overworld". */
    String dimension(Object level) {
        return level == null ? null : keyLocation(optCall(level, "dimension"));
    }

    /** "minecraft:overworld" from a ResourceKey, whose toString is "ResourceKey[minecraft:dimension / minecraft:overworld]". */
    static String keyLocation(Object key) {
        if (key == null) {
            return null;
        }
        String s = key.toString();
        int slash = s.lastIndexOf(" / ");
        return slash >= 0 && s.endsWith("]") ? s.substring(slash + 3, s.length() - 1) : s;
    }

    // ---------------------------------------------------------------- screens

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

    // ---------------------------------------------------------------- reflection shortcuts

    /** Component → plain text (getString), tolerating plain strings and nulls. */
    String text(Object component) {
        if (component == null || component instanceof String) {
            return (String) component;
        }
        Object s = optCall(component, "getString");
        return s != null ? s.toString() : component.toString();
    }

    /** Field value by official name, or null when missing. */
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

    /** Result of a no-argument method by official name, or null when missing or failing. */
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
            throw ProbeException.unwrap(e);
        }
        return true;
    }
}
