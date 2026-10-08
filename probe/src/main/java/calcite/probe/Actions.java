package calcite.probe;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

import calcite.probe.Game.ProbeException;

/**
 * Player actions: looking, movement, attacking, using items/blocks, mining, inventory and containers.
 *
 * <p>Single clicks call the game's own {@code startAttack}/{@code startUseItem} with a forced hit result, so swing,
 * cooldown and packet logic stay vanilla for every version. Anything that lasts several ticks (walking, mining,
 * holding right click) holds the game's key mappings and is re-applied once per client tick by {@link #pump()},
 * because opening a screen or a focus change resets key states.</p>
 */
final class Actions {

    static final String[] CONTROLS = {"forward", "back", "left", "right", "jump", "sneak", "sprint", "attack", "use"};
    private static final String[] KEYS = {"keyUp", "keyDown", "keyLeft", "keyRight", "keyJump", "keyShift", "keySprint", "keyAttack", "keyUse"};
    private static final int FORWARD = 0, JUMP = 4, SPRINT = 6, ATTACK = 7, USE = 8;
    private static final String[] FACES = {"down", "up", "north", "south", "west", "east"};
    /** Generous reach limit; the server enforces the real one. */
    private static final double MAX_REACH = 6.0;

    private final Game game;
    private final Ref ref;

    // Everything below is only touched on the game thread.
    private final boolean[] held = new boolean[CONTROLS.length];
    /** Ticks until the held controls are released; -1 holds them until changed. */
    private int releaseIn = -1;
    private boolean keysDirty;
    private Behavior behavior;
    private Object lastPlayer;
    private int lastTick = Integer.MIN_VALUE;

    private volatile boolean active;
    private final AtomicBoolean pumping = new AtomicBoolean();

    Actions(Game game, Ref ref) {
        this.game = game;
        this.ref = ref;
    }

    // ---------------------------------------------------------------- tick pump

    /** Called every few milliseconds from the probe timer; runs {@link #tick} once per new client tick. */
    void pump() {
        if (!active) {
            return;
        }
        final Object mc = game.minecraft();
        if (mc == null || !pumping.compareAndSet(false, true)) {
            return;
        }
        try {
            ((Executor) mc).execute(() -> {
                try {
                    tick(mc);
                } catch (Throwable t) {
                    finishBehavior(null, t);
                } finally {
                    pumping.set(false);
                }
            });
        } catch (Throwable t) {
            pumping.set(false);
        }
    }

    private void tick(Object mc) throws Exception {
        Object player = game.optGet(mc, "player");
        if (player == null) {
            finishBehavior(null, new ProbeException("not_in_game", "The client left the world"));
            clearHeld();
            applyKeys(mc);
            updateActive();
            return;
        }
        int tickCount = intValue(game.optGet(player, "tickCount"), 0);
        if (player == lastPlayer && tickCount == lastTick) {
            applyKeys(mc); // a behavior may have been ended between ticks
            updateActive();
            return;
        }
        lastPlayer = player;
        lastTick = tickCount;
        if (behavior != null) {
            try {
                behavior.ticks++;
                behavior.tick(mc, player);
            } catch (Throwable t) {
                finishBehavior(null, t);
            }
        }
        if (releaseIn > 0 && --releaseIn == 0) {
            clearHeld();
            releaseIn = -1;
        }
        applyKeys(mc);
        updateActive();
    }

    private void updateActive() {
        boolean any = keysDirty || behavior != null;
        for (boolean h : held) {
            any |= h;
        }
        active = any;
    }

    private void clearHeld() {
        for (int i = 0; i < held.length; i++) {
            if (held[i]) {
                held[i] = false;
                keysDirty = true;
            }
        }
    }

    private void applyKeys(Object mc) throws Exception {
        boolean any = false;
        for (boolean h : held) {
            any |= h;
        }
        if (!any && !keysDirty) {
            return;
        }
        Object options = game.optGet(mc, "options");
        for (int i = 0; i < KEYS.length; i++) {
            Object key = game.optGet(options, KEYS[i]);
            if (key != null) {
                game.invoke(key, "setDown", held[i]);
            }
        }
        keysDirty = any;
    }

    private void startBehavior(Behavior b) {
        finishBehavior(null, new ProbeException("cancelled", "Interrupted by another action"));
        clearHeld();
        releaseIn = -1;
        behavior = b;
        active = true;
    }

    private void finishBehavior(Map<String, Object> result, Throwable error) {
        Behavior b = behavior;
        if (b == null) {
            return;
        }
        behavior = null;
        try {
            b.end();
        } catch (Throwable ignored) {
            // best effort
        }
        clearHeld();
        if (error != null) {
            b.done.completeExceptionally(error);
        } else {
            b.done.complete(result);
        }
    }

    /** Waits for a behavior started on the game thread; cancels it when the caller gives up. */
    private Map<String, Object> await(final Behavior b, long timeoutMs) throws Exception {
        try {
            return b.done.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            game.onGameThread(() -> {
                if (behavior == b) {
                    finishBehavior(null, new ProbeException("timeout", "Action timed out"));
                }
                return null;
            }, 5000);
            throw new ProbeException("timeout", "Action timed out after " + timeoutMs + "ms");
        } catch (java.util.concurrent.ExecutionException e) {
            Throwable cause = e.getCause();
            throw cause instanceof Exception ? (Exception) cause : new RuntimeException(cause);
        }
    }

    private abstract static class Behavior {
        final CompletableFuture<Map<String, Object>> done = new CompletableFuture<Map<String, Object>>();
        int ticks;

        abstract void tick(Object mc, Object player) throws Exception;

        /** Restores anything the behavior changed; runs on the game thread. */
        void end() throws Exception {
        }
    }

    // ---------------------------------------------------------------- looking

    Map<String, Object> look(final Double yaw, final Double pitch, final double[] at) throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            Object player = game.requirePlayer(mc);
            if (at != null) {
                lookAt(player, at[0], at[1], at[2]);
            } else {
                Double y = yaw != null ? yaw : game.rotation(player, "getYRot", "yRot");
                Double p = pitch != null ? pitch : game.rotation(player, "getXRot", "xRot");
                setRotation(player, y == null ? 0 : y, p == null ? 0 : p);
            }
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("yaw", game.rotation(player, "getYRot", "yRot"));
            out.put("pitch", game.rotation(player, "getXRot", "xRot"));
            return out;
        }, 5000);
    }

    private void setRotation(Object player, double yaw, double pitch) throws Exception {
        float y = (float) yaw;
        float p = (float) Math.max(-90, Math.min(90, pitch));
        if (!game.invoke(player, "setYRot", y)) {
            setField(player, "yRot", y);
        }
        if (!game.invoke(player, "setXRot", p)) {
            setField(player, "xRot", p);
        }
        setField(player, "yRotO", y);
        setField(player, "xRotO", p);
        setField(player, "yHeadRot", y);
        setField(player, "yHeadRotO", y);
    }

    private void lookAt(Object player, double x, double y, double z) throws Exception {
        double[] eye = eye(player);
        double dx = x - eye[0], dy = y - eye[1], dz = z - eye[2];
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        double pitch = -Math.toDegrees(Math.atan2(dy, horizontal));
        setRotation(player, yaw, pitch);
    }

    private double[] eye(Object player) {
        double[] pos = game.position(player);
        if (pos == null) {
            throw new ProbeException("unsupported", "Player position is not available");
        }
        Object eyeY = game.optCall(player, "getEyeY");
        return new double[]{pos[0], eyeY instanceof Number ? ((Number) eyeY).doubleValue() : pos[1] + 1.62, pos[2]};
    }

    // ---------------------------------------------------------------- movement

    /** Holds (or releases) movement controls, optionally for {@code ticks} ticks. */
    Map<String, Object> move(final Map<String, Object> controls, final int ticks) throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            game.requirePlayer(mc);
            if (behavior != null) {
                finishBehavior(null, new ProbeException("cancelled", "Interrupted by move"));
            }
            for (int i = 0; i < CONTROLS.length; i++) {
                Object v = controls.get(CONTROLS[i]);
                if (v instanceof Boolean) {
                    held[i] = (Boolean) v;
                    keysDirty = true;
                }
            }
            releaseIn = ticks > 0 ? ticks : -1;
            applyKeys(mc);
            updateActive();
            return heldState();
        }, 5000);
    }

    /** Releases every control and cancels a running walk/dig/use. */
    void stop() throws Exception {
        final Object mc = game.requireMinecraft();
        game.onGameThread(() -> {
            finishBehavior(null, new ProbeException("cancelled", "Stopped"));
            clearHeld();
            releaseIn = -1;
            applyKeys(mc);
            updateActive();
            return null;
        }, 5000);
    }

    private Map<String, Object> heldState() {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        for (int i = 0; i < CONTROLS.length; i++) {
            if (held[i]) {
                out.put(CONTROLS[i], true);
            }
        }
        if (releaseIn > 0) {
            out.put("releaseInTicks", releaseIn);
        }
        return out;
    }

    /**
     * Walks in a straight line to (x, z): faces the target, holds forward and jumps over one-block steps. Ends
     * when within {@code range}, when no progress was made for 3 seconds ("stuck") or after the timeout.
     */
    Map<String, Object> walkTo(final double x, final double z, final double range, final boolean sprint, long timeoutMs) throws Exception {
        final Object mc = game.requireMinecraft();
        final int maxTicks = (int) Math.max(20, timeoutMs / 50);
        final Behavior b = new Behavior() {
            double best = Double.MAX_VALUE;
            int lastProgress;

            @Override
            void tick(Object mc, Object player) throws Exception {
                double[] pos = game.position(player);
                double dx = x - pos[0], dz = z - pos[2];
                double dist = Math.sqrt(dx * dx + dz * dz);
                if (dist <= range) {
                    finishBehavior(walkResult(player, true, null, dist), null);
                    return;
                }
                if (dist < best - 0.2) {
                    best = dist;
                    lastProgress = ticks;
                } else if (ticks - lastProgress > 60) {
                    finishBehavior(walkResult(player, false, "stuck", dist), null);
                    return;
                }
                if (ticks > maxTicks) {
                    finishBehavior(walkResult(player, false, "timeout", dist), null);
                    return;
                }
                Double pitch = game.rotation(player, "getXRot", "xRot");
                setRotation(player, Math.toDegrees(Math.atan2(-dx, dz)), pitch == null ? 0 : pitch);
                boolean blocked = Boolean.TRUE.equals(game.optGet(player, "horizontalCollision"));
                boolean inWater = Boolean.TRUE.equals(game.optCall(player, "isInWater")) || Boolean.TRUE.equals(game.optCall(player, "isInLava"));
                held[FORWARD] = true;
                held[SPRINT] = sprint && dist > 3;
                held[JUMP] = (blocked && onGround(player)) || inWater;
                keysDirty = true;
            }
        };
        game.onGameThread(() -> {
            game.requirePlayer(mc);
            startBehavior(b);
            return null;
        }, 5000);
        return await(b, timeoutMs + 5000);
    }

    private Map<String, Object> walkResult(Object player, boolean arrived, String reason, double distance) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("arrived", arrived);
        if (reason != null) {
            out.put("reason", reason);
        }
        out.put("distance", Math.round(distance * 100) / 100.0);
        double[] pos = game.position(player);
        out.put("x", pos[0]);
        out.put("y", pos[1]);
        out.put("z", pos[2]);
        return out;
    }

    private boolean onGround(Object player) {
        Object v = game.optCall(player, "onGround");
        if (v == null) {
            v = game.optCall(player, "isOnGround");
        }
        if (v == null) {
            v = game.optGet(player, "onGround");
        }
        return Boolean.TRUE.equals(v);
    }

    // ---------------------------------------------------------------- attack / use

    /** Left click: attacks entity {@code entityId} (facing it first), or whatever the crosshair targets. */
    Map<String, Object> attack(final Integer entityId) throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            Object player = game.requirePlayer(mc);
            Map<String, Object> target;
            if (entityId != null) {
                Object entity = entityInReach(mc, player, entityId);
                lookAtEntity(player, entity);
                setField(mc, "hitResult", construct("net.minecraft.world.phys.EntityHitResult", entity));
                target = describeHit(mc);
            } else {
                target = describeHit(mc);
            }
            setField(mc, "missTime", 0);
            call(mc, "startAttack");
            return target;
        }, 5000);
    }

    /**
     * Right click on an entity, a block face, or (neither) whatever the crosshair targets. With {@code holdTicks}
     * the use key stays pressed afterwards, e.g. to eat, drink, block or draw a bow.
     */
    Map<String, Object> use(final Integer entityId, final int[] block, final String face, final int holdTicks) throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            Object player = game.requirePlayer(mc);
            if (entityId != null) {
                Object entity = entityInReach(mc, player, entityId);
                lookAtEntity(player, entity);
                setField(mc, "hitResult", construct("net.minecraft.world.phys.EntityHitResult", entity));
            } else if (block != null) {
                setField(mc, "hitResult", aimAtBlock(player, block, face));
            }
            Map<String, Object> target = describeHit(mc);
            setField(mc, "rightClickDelay", 0);
            call(mc, "startUseItem");
            if (holdTicks > 0) {
                if (behavior != null) {
                    finishBehavior(null, new ProbeException("cancelled", "Interrupted by use"));
                }
                held[USE] = true;
                keysDirty = true;
                releaseIn = holdTicks;
                applyKeys(mc);
                updateActive();
                target.put("holdTicks", holdTicks);
            }
            return target;
        }, 5000);
    }

    /**
     * Mines the block at {@code pos} by aiming at it and holding the attack key, exactly like a player; works in
     * survival (taking the block's break time) and creative. Ends when the block is gone or after the timeout.
     */
    Map<String, Object> dig(final int[] pos, final String face, long timeoutMs) throws Exception {
        final Object mc = game.requireMinecraft();
        final int maxTicks = (int) Math.max(20, timeoutMs / 50);
        final Field grabbed = ref.field(ref.cls("net.minecraft.client.MouseHandler"), "mouseGrabbed");
        final Behavior b = new Behavior() {
            Object mouse;
            Boolean wasGrabbed;
            String blockId;

            @Override
            void tick(Object mc, Object player) throws Exception {
                Object state = blockState(mc, pos);
                if (wasGrabbed == null) {
                    mouse = game.optGet(mc, "mouseHandler");
                    wasGrabbed = grabbed != null && mouse != null && grabbed.getBoolean(mouse);
                    blockId = state == null ? null : registryKey("BLOCK", game.optCall(state, "getBlock"));
                }
                if (state != null && Boolean.TRUE.equals(game.optCall(state, "isAir"))) {
                    Map<String, Object> out = new LinkedHashMap<String, Object>();
                    out.put("broken", true);
                    out.put("block", blockId);
                    out.put("ticks", ticks);
                    finishBehavior(out, null);
                    return;
                }
                if (ticks > maxTicks) {
                    Map<String, Object> out = new LinkedHashMap<String, Object>();
                    out.put("broken", false);
                    out.put("reason", "timeout");
                    out.put("block", blockId);
                    finishBehavior(out, null);
                    return;
                }
                if (game.screen(mc) != null) {
                    throw new ProbeException("screen_open", "Close the open screen before digging");
                }
                // aim every tick: the game re-picks its hit result each tick from the player's rotation
                setField(mc, "hitResult", aimAtBlock(player, pos, face));
                // continueAttack only mines while the mouse is "grabbed" (focused game window)
                if (grabbed != null && mouse != null) {
                    grabbed.setBoolean(mouse, true);
                }
                held[ATTACK] = true;
                keysDirty = true;
            }

            @Override
            void end() throws Exception {
                if (grabbed != null && mouse != null && wasGrabbed != null) {
                    grabbed.setBoolean(mouse, wasGrabbed);
                }
            }
        };
        game.onGameThread(() -> {
            Object player = game.requirePlayer(mc);
            Object state = blockState(mc, pos);
            if (state != null && Boolean.TRUE.equals(game.optCall(state, "isAir"))) {
                throw new ProbeException("no_block", "There is no block at " + pos[0] + " " + pos[1] + " " + pos[2]);
            }
            checkReach(player, pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5);
            startBehavior(b);
            return null;
        }, 5000);
        return await(b, timeoutMs + 5000);
    }

    private Object entityInReach(Object mc, Object player, int entityId) throws Exception {
        Object level = game.optGet(mc, "level");
        Method getEntity = level == null ? null : ref.method(level.getClass(), "getEntity", 1, "int");
        Object entity = getEntity == null ? null : getEntity.invoke(level, entityId);
        if (entity == null) {
            throw new ProbeException("no_entity", "No entity with id " + entityId + " near the player");
        }
        double[] pos = game.position(entity);
        checkReach(player, pos[0], pos[1] + height(entity) / 2, pos[2]);
        return entity;
    }

    private void lookAtEntity(Object player, Object entity) throws Exception {
        double[] pos = game.position(entity);
        lookAt(player, pos[0], pos[1] + height(entity) * 0.6, pos[2]);
    }

    private double height(Object entity) {
        Object h = game.optCall(entity, "getBbHeight");
        return h instanceof Number ? ((Number) h).doubleValue() : 1.0;
    }

    private void checkReach(Object player, double x, double y, double z) {
        double[] eye = eye(player);
        double dx = x - eye[0], dy = y - eye[1], dz = z - eye[2];
        double d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > MAX_REACH) {
            throw new ProbeException("out_of_reach", String.format(Locale.ROOT, "Target is %.1f blocks away; walk closer (reach is about 4.5)", d));
        }
    }

    /** Faces the given (or nearest) face of a block and returns the matching BlockHitResult. */
    private Object aimAtBlock(Object player, int[] pos, String face) throws Exception {
        double[] eye = eye(player);
        double cx = pos[0] + 0.5, cy = pos[1] + 0.5, cz = pos[2] + 0.5;
        String side = face != null ? face.toLowerCase(Locale.ROOT) : nearestFace(eye[0] - cx, eye[1] - cy, eye[2] - cz);
        int[] n = normal(side);
        double hx = cx + n[0] * 0.5, hy = cy + n[1] * 0.5, hz = cz + n[2] * 0.5;
        checkReach(player, hx, hy, hz);
        lookAt(player, hx, hy, hz);
        Object vec = construct("net.minecraft.world.phys.Vec3", hx, hy, hz);
        Object direction = ref.getStatic(ref.cls("net.minecraft.core.Direction"), side.toUpperCase(Locale.ROOT));
        return construct("net.minecraft.world.phys.BlockHitResult", vec, direction, blockPos(pos), false);
    }

    static String nearestFace(double dx, double dy, double dz) {
        double ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
        if (ay >= ax && ay >= az) {
            return dy > 0 ? "up" : "down";
        }
        if (ax >= az) {
            return dx > 0 ? "east" : "west";
        }
        return dz > 0 ? "south" : "north";
    }

    static int[] normal(String face) {
        switch (face) {
            case "down": return new int[]{0, -1, 0};
            case "up": return new int[]{0, 1, 0};
            case "north": return new int[]{0, 0, -1};
            case "south": return new int[]{0, 0, 1};
            case "west": return new int[]{-1, 0, 0};
            case "east": return new int[]{1, 0, 0};
            default: throw new ProbeException("bad_request", "face must be one of " + String.join(", ", FACES));
        }
    }

    // ---------------------------------------------------------------- world queries

    Map<String, Object> block(final int[] pos) throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            game.requirePlayer(mc);
            Object state = blockState(mc, pos);
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("x", pos[0]);
            out.put("y", pos[1]);
            out.put("z", pos[2]);
            if (state == null) {
                out.put("loaded", false);
                return out;
            }
            out.put("id", registryKey("BLOCK", game.optCall(state, "getBlock")));
            out.put("air", game.optCall(state, "isAir"));
            String s = state.toString();
            int bracket = s.indexOf('[');
            if (bracket > 0 && s.endsWith("]")) {
                out.put("properties", s.substring(bracket + 1, s.length() - 1));
            }
            return out;
        }, 5000);
    }

    /** What the crosshair points at. */
    Map<String, Object> target() throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            game.requirePlayer(mc);
            return describeHit(mc);
        }, 5000);
    }

    private Map<String, Object> describeHit(Object mc) throws Exception {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        Object hit = game.optGet(mc, "hitResult");
        Object type = hit == null ? null : game.optCall(hit, "getType");
        String kind = type == null ? "miss" : ((Enum<?>) type).name();
        Mappings.ClassEntry entry = type == null ? null : ref.mappings().byRuntime(type.getClass().getName());
        if (entry != null && !ref.mappings().isIdentity()) {
            for (String named : new String[]{"MISS", "BLOCK", "ENTITY"}) {
                if (kind.equals(entry.field(named))) {
                    kind = named;
                }
            }
        }
        kind = kind.toLowerCase(Locale.ROOT);
        out.put("type", kind);
        if ("block".equals(kind)) {
            Object pos = game.optCall(hit, "getBlockPos");
            int[] p = blockCoords(pos);
            out.put("x", p[0]);
            out.put("y", p[1]);
            out.put("z", p[2]);
            Object dir = game.optCall(hit, "getDirection");
            out.put("face", dir == null ? null : faceName(dir));
            Object state = blockState(mc, p);
            if (state != null) {
                out.put("block", registryKey("BLOCK", game.optCall(state, "getBlock")));
            }
        } else if ("entity".equals(kind)) {
            Object e = game.optCall(hit, "getEntity");
            out.put("entity", game.describe(e, game.position(e)));
        }
        return out;
    }

    private String faceName(Object direction) {
        Object name = game.optCall(direction, "getSerializedName");
        if (name == null) {
            name = game.optCall(direction, "getName");
        }
        return name == null ? direction.toString().toLowerCase(Locale.ROOT) : name.toString();
    }

    private Object blockState(Object mc, int[] pos) throws Exception {
        Object level = game.optGet(mc, "level");
        if (level == null) {
            return null;
        }
        Method get = ref.method(level.getClass(), "getBlockState", 1);
        return get == null ? null : get.invoke(level, blockPos(pos));
    }

    private Object blockPos(int[] pos) throws Exception {
        return construct("net.minecraft.core.BlockPos", pos[0], pos[1], pos[2]);
    }

    private int[] blockCoords(Object pos) {
        return new int[]{intValue(game.optCall(pos, "getX"), 0), intValue(game.optCall(pos, "getY"), 0), intValue(game.optCall(pos, "getZ"), 0)};
    }

    // ---------------------------------------------------------------- inventory

    Map<String, Object> inventory() throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            Object player = game.requirePlayer(mc);
            Object inv = playerInventory(player);
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("selected", selectedSlot(inv));
            List<Map<String, Object>> items = new ArrayList<Map<String, Object>>();
            int size = intValue(game.optCall(inv, "getContainerSize"), 41);
            Method getItem = ref.method(inv.getClass(), "getItem", 1, "int");
            for (int i = 0; i < size; i++) {
                Map<String, Object> item = item(getItem.invoke(inv, i));
                if (item != null) {
                    Map<String, Object> m = new LinkedHashMap<String, Object>();
                    m.put("slot", i);
                    m.putAll(item);
                    items.add(m);
                }
            }
            out.put("items", items);
            out.put("slots", "0-8 hotbar, 9-35 main, 36-39 armor (feet..head), 40 offhand");
            return out;
        }, 5000);
    }

    Map<String, Object> selectSlot(final int slot) throws Exception {
        if (slot < 0 || slot > 8) {
            throw new ProbeException("bad_request", "Hotbar slot must be 0-8");
        }
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            Object inv = playerInventory(game.requirePlayer(mc));
            if (!game.invoke(inv, "setSelectedSlot", slot)) {
                setField(inv, "selected", slot); // the client sends the change on its next tick
            }
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("selected", slot);
            Method getItem = ref.method(inv.getClass(), "getItem", 1, "int");
            out.put("item", item(getItem.invoke(inv, slot)));
            return out;
        }, 5000);
    }

    private Object playerInventory(Object player) {
        Object inv = game.optCall(player, "getInventory");
        if (inv == null) {
            inv = game.optGet(player, "inventory");
        }
        if (inv == null) {
            throw new ProbeException("unsupported", "Player inventory not found");
        }
        return inv;
    }

    private int selectedSlot(Object inv) {
        Object v = game.optCall(inv, "getSelectedSlot");
        if (v == null) {
            v = game.optGet(inv, "selected");
        }
        return intValue(v, 0);
    }

    /** id/count/name of a stack, or null for an empty one. */
    private Map<String, Object> item(Object stack) {
        if (stack == null || Boolean.TRUE.equals(game.optCall(stack, "isEmpty"))) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("id", registryKey("ITEM", game.optCall(stack, "getItem")));
        m.put("count", game.optCall(stack, "getCount"));
        m.put("name", game.text(game.optCall(stack, "getHoverName")));
        int max = intValue(game.optCall(stack, "getMaxDamage"), 0);
        if (max > 0) {
            m.put("damage", game.optCall(stack, "getDamageValue"));
            m.put("maxDamage", max);
        }
        return m;
    }

    // ---------------------------------------------------------------- containers

    /** The open container (chest, furnace, ...) or the player's inventory menu; optionally waits for one to open. */
    Map<String, Object> container(long waitMs) throws Exception {
        final Object mc = game.requireMinecraft();
        long deadline = System.currentTimeMillis() + waitMs;
        while (true) {
            Map<String, Object> state = game.onGameThread(() -> containerState(mc), 5000);
            if (Boolean.TRUE.equals(state.get("open")) || System.currentTimeMillis() >= deadline) {
                return state;
            }
            Thread.sleep(50);
        }
    }

    private Map<String, Object> containerState(Object mc) throws Exception {
        Object player = game.requirePlayer(mc);
        Object menu = game.optGet(player, "containerMenu");
        Object inventoryMenu = game.optGet(player, "inventoryMenu");
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        boolean open = menu != null && menu != inventoryMenu;
        out.put("open", open);
        if (menu == null) {
            return out;
        }
        out.put("containerId", game.optGet(menu, "containerId"));
        if (open) {
            Object type = game.optCall(menu, "getType");
            out.put("type", type == null ? null : registryKey("MENU", type));
        }
        Object screen = game.screen(mc);
        if (screen != null) {
            out.put("title", game.text(game.optCall(screen, "getTitle")));
        }
        Class<?> inventoryClass = ref.cls("net.minecraft.world.entity.player.Inventory");
        List<?> slots = (List<?>) game.optGet(menu, "slots");
        List<Map<String, Object>> items = new ArrayList<Map<String, Object>>();
        int containerSlots = 0;
        for (int i = 0; i < slots.size(); i++) {
            Object slot = slots.get(i);
            Object container = game.optGet(slot, "container");
            boolean playerSlot = inventoryClass != null && inventoryClass.isInstance(container);
            if (!playerSlot) {
                containerSlots++;
            }
            Map<String, Object> item = item(game.optCall(slot, "getItem"));
            if (item != null) {
                Map<String, Object> m = new LinkedHashMap<String, Object>();
                m.put("slot", i);
                m.putAll(item);
                if (playerSlot) {
                    m.put("inventorySlot", game.optGet(slot, "slot"));
                }
                items.add(m);
            }
        }
        out.put("size", slots.size());
        out.put("containerSlots", containerSlots);
        out.put("items", items);
        Map<String, Object> carried = item(game.optCall(menu, "getCarried"));
        if (carried != null) {
            out.put("carried", carried);
        }
        return out;
    }

    /**
     * Clicks a slot of the open menu (the player's inventory when none is open). {@code mode}: pickup (default),
     * quick_move (shift click), swap (button = hotbar slot 0-8, 40 = offhand), clone, throw (button 1 = whole
     * stack), quick_craft, pickup_all. Slot -999 clicks outside the window (drops the carried stack).
     */
    Map<String, Object> click(final int slot, final int button, final String mode) throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            Object player = game.requirePlayer(mc);
            Object menu = game.optGet(player, "containerMenu");
            List<?> slots = (List<?>) game.optGet(menu, "slots");
            if (slot != -999 && (slot < 0 || slot >= slots.size())) {
                throw new ProbeException("bad_request", "Slot must be 0-" + (slots.size() - 1) + " or -999");
            }
            Class<?> typeClass = ref.cls("net.minecraft.world.inventory.ContainerInput", "net.minecraft.world.inventory.ClickType");
            Object type;
            try {
                type = ref.getStatic(typeClass, mode.toUpperCase(Locale.ROOT));
            } catch (NoSuchFieldException e) {
                throw new ProbeException("bad_request", "Unknown click mode " + mode);
            }
            Object gameMode = game.optGet(mc, "gameMode");
            Object id = game.optGet(menu, "containerId");
            Method m = ref.method(gameMode.getClass(), "handleContainerInput", 5);
            if (m == null) {
                m = ref.method(gameMode.getClass(), "handleInventoryMouseClick", 5);
            }
            if (m == null) {
                throw new ProbeException("unsupported", "No container click API in this version");
            }
            m.invoke(gameMode, id, slot, button, type, player);
            return containerState(mc);
        }, 5000);
    }

    void closeContainer() throws Exception {
        final Object mc = game.requireMinecraft();
        game.onGameThread(() -> {
            Object player = game.requirePlayer(mc);
            if (game.optGet(player, "containerMenu") != game.optGet(player, "inventoryMenu")) {
                call(player, "closeContainer");
            } else if (game.screen(mc) != null) {
                game.setScreen(mc, null);
            }
            return null;
        }, 5000);
    }

    /** Drops the selected hotbar item (one, or the whole stack), like pressing Q. */
    Map<String, Object> drop(final boolean all) throws Exception {
        final Object mc = game.requireMinecraft();
        return game.onGameThread(() -> {
            Object player = game.requirePlayer(mc);
            Object inv = playerInventory(player);
            int selected = selectedSlot(inv);
            Method getItem = ref.method(inv.getClass(), "getItem", 1, "int");
            Map<String, Object> dropped = item(getItem.invoke(inv, selected));
            if (dropped == null) {
                throw new ProbeException("empty_hand", "Nothing in the selected hotbar slot");
            }
            Method drop = ref.method(player.getClass(), "drop", 1, "boolean");
            if (drop != null) {
                drop.invoke(player, all);
            } else {
                // 26.x: throw the stack out of the matching slot of the open menu
                Object menu = game.optGet(player, "containerMenu");
                List<?> slots = (List<?>) game.optGet(menu, "slots");
                int index = -1;
                for (int i = 0; i < slots.size(); i++) {
                    Object s = slots.get(i);
                    if (game.optGet(s, "container") == inv && intValue(game.optGet(s, "slot"), -1) == selected) {
                        index = i;
                    }
                }
                if (index < 0) {
                    throw new ProbeException("unsupported", "Cannot drop items in this version");
                }
                Class<?> typeClass = ref.cls("net.minecraft.world.inventory.ContainerInput", "net.minecraft.world.inventory.ClickType");
                Object gameMode = game.optGet(mc, "gameMode");
                Method m = ref.method(gameMode.getClass(), "handleContainerInput", 5);
                if (m == null) {
                    m = ref.method(gameMode.getClass(), "handleInventoryMouseClick", 5);
                }
                m.invoke(gameMode, game.optGet(menu, "containerId"), index, all ? 1 : 0, ref.getStatic(typeClass, "THROW"), player);
            }
            if (!all) {
                dropped.put("count", 1);
            }
            return dropped;
        }, 5000);
    }

    // ---------------------------------------------------------------- reflection helpers

    /** Registry id ("minecraft:stone") of a value in BuiltInRegistries.NAME (1.19.3+) or Registry.NAME. */
    private String registryKey(String registry, Object value) {
        if (value == null) {
            return null;
        }
        for (String holder : new String[]{"net.minecraft.core.registries.BuiltInRegistries", "net.minecraft.core.Registry"}) {
            Class<?> k = ref.cls(holder);
            if (k == null) {
                continue;
            }
            try {
                Object reg = ref.getStatic(k, registry);
                Method getKey = ref.method(reg.getClass(), "getKey", 1);
                Object key = getKey == null ? null : getKey.invoke(reg, value);
                if (key != null) {
                    return key.toString();
                }
            } catch (Throwable ignored) {
                // try the next holder
            }
        }
        return value.toString();
    }

    /** {@code new named(args)}, picking the constructor whose parameters accept the arguments. */
    private Object construct(String named, Object... args) throws Exception {
        Class<?> k = ref.cls(named);
        if (k == null) {
            throw new ProbeException("unsupported", named + " not found");
        }
        for (Constructor<?> c : k.getDeclaredConstructors()) {
            Class<?>[] types = c.getParameterTypes();
            if (types.length != args.length) {
                continue;
            }
            boolean fits = true;
            for (int i = 0; i < types.length && fits; i++) {
                fits = accepts(types[i], args[i]);
            }
            if (fits) {
                c.setAccessible(true);
                return c.newInstance(args);
            }
        }
        throw new ProbeException("unsupported", "No matching constructor for " + named);
    }

    private static boolean accepts(Class<?> type, Object arg) {
        if (!type.isPrimitive()) {
            return arg == null || type.isInstance(arg);
        }
        return (type == int.class && arg instanceof Integer) || (type == double.class && arg instanceof Double)
                || (type == float.class && arg instanceof Float) || (type == boolean.class && arg instanceof Boolean)
                || (type == long.class && arg instanceof Long);
    }

    private void setField(Object target, String name, Object value) throws Exception {
        Field f = ref.field(target.getClass(), name);
        if (f != null) {
            f.set(target, value);
        }
    }

    private Object call(Object target, String name) throws Exception {
        Method m = ref.method(target.getClass(), name, 0);
        if (m == null) {
            throw new ProbeException("unsupported", ref.simpleNamed(target.getClass()) + "#" + name + " is not available in this version");
        }
        try {
            return m.invoke(target);
        } catch (java.lang.reflect.InvocationTargetException e) {
            Throwable cause = e.getCause();
            throw cause instanceof Exception ? (Exception) cause : new RuntimeException(cause);
        }
    }

    private static int intValue(Object v, int def) {
        return v instanceof Number ? ((Number) v).intValue() : def;
    }
}
