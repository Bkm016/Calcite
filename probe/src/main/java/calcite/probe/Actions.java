package calcite.probe;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

import calcite.probe.Game.ProbeException;

/**
 * Player actions: looking, walking, attacking, using items/blocks and mining.
 *
 * <p>Single clicks call the game's own {@code startAttack}/{@code startUseItem} with a forced hit result, so swing,
 * cooldown and packet logic stay vanilla for every version.</p>
 */
final class Actions extends Controls {

    private static final String[] FACES = {"down", "up", "north", "south", "west", "east"};
    /** Generous reach limit; the server enforces the real one. */
    private static final double MAX_REACH = 6.0;

    private final World world;

    Actions(Game game, Ref ref, World world) {
        super(game, ref);
        this.world = world;
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
            ref.setIfPresent(player, "yRot", y);
        }
        if (!game.invoke(player, "setXRot", p)) {
            ref.setIfPresent(player, "xRot", p);
        }
        ref.setIfPresent(player, "yRotO", y);
        ref.setIfPresent(player, "xRotO", p);
        ref.setIfPresent(player, "yHeadRot", y);
        ref.setIfPresent(player, "yHeadRotO", y);
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
                ref.setIfPresent(mc, "hitResult", ref.construct("net.minecraft.world.phys.EntityHitResult", entity));
                target = world.describeHit(mc);
            } else {
                target = world.describeHit(mc);
            }
            ref.setIfPresent(mc, "missTime", 0);
            ref.callOrFail(mc, "startAttack");
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
                ref.setIfPresent(mc, "hitResult", ref.construct("net.minecraft.world.phys.EntityHitResult", entity));
            } else if (block != null) {
                ref.setIfPresent(mc, "hitResult", aimAtBlock(player, block, face));
            }
            Map<String, Object> target = world.describeHit(mc);
            ref.setIfPresent(mc, "rightClickDelay", 0);
            ref.callOrFail(mc, "startUseItem");
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
                Object state = world.blockState(mc, pos);
                if (wasGrabbed == null) {
                    mouse = game.optGet(mc, "mouseHandler");
                    wasGrabbed = grabbed != null && mouse != null && grabbed.getBoolean(mouse);
                    blockId = state == null ? null : world.registryKey("BLOCK", game.optCall(state, "getBlock"));
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
                ref.setIfPresent(mc, "hitResult", aimAtBlock(player, pos, face));
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
            Object state = world.blockState(mc, pos);
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
        Object vec = ref.construct("net.minecraft.world.phys.Vec3", hx, hy, hz);
        Object direction = ref.getStatic(ref.cls("net.minecraft.core.Direction"), side.toUpperCase(Locale.ROOT));
        return ref.construct("net.minecraft.world.phys.BlockHitResult", vec, direction, world.blockPos(pos), false);
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
}
