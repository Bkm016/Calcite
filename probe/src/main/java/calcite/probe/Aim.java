package calcite.probe;

import java.lang.reflect.Method;
import java.util.Locale;

/** Turning the player, reach checks and synthetic hit results for clicks. Game thread only. */
final class Aim {

    static final String[] FACES = {"down", "up", "north", "south", "west", "east"};
    /** Survival reach from the eyes. */
    static final double REACH = 4.5;
    /** Generous limit for targeting; the server enforces the real reach. */
    static final double MAX_REACH = 6.0;
    /** Largest turn per client tick for continuous aiming: 20° per tick, i.e. 400° per second. */
    static final double TURN_RATE = 20;

    private final Game game;
    private final Ref ref;
    private final World world;

    Aim(Game game, Ref ref, World world) {
        this.game = game;
        this.ref = ref;
        this.world = world;
    }

    void setRotation(Object player, double yaw, double pitch) throws Exception {
        applyRotation(player, yaw, pitch, yaw, pitch);
    }

    /**
     * Writes a rotation, keeping {@code previousYaw}/{@code previousPitch} as the rotation of the last frame so the
     * renderer can interpolate towards the new one.
     */
    private void applyRotation(Object player, double yaw, double pitch, double previousYaw, double previousPitch) throws Exception {
        float y = (float) yaw;
        float p = (float) Math.max(-90, Math.min(90, pitch));
        float y0 = (float) previousYaw;
        float p0 = (float) Math.max(-90, Math.min(90, previousPitch));
        if (!game.invoke(player, "setYRot", y)) {
            ref.setIfPresent(player, "yRot", y);
        }
        if (!game.invoke(player, "setXRot", p)) {
            ref.setIfPresent(player, "xRot", p);
        }
        ref.setIfPresent(player, "yRotO", y0);
        ref.setIfPresent(player, "xRotO", p0);
        ref.setIfPresent(player, "yHeadRot", y);
        ref.setIfPresent(player, "yHeadRotO", y0);
    }

    /**
     * Turns towards a rotation by at most {@code maxStep} degrees, so continuous aiming sweeps instead of
     * teleporting. {@code targetPitch} null keeps the current pitch. Returns the yaw after this step.
     */
    double turnTowards(Object player, double targetYaw, Double targetPitch, double maxStep) throws Exception {
        Double currentYaw = game.yaw(player);
        Double currentPitch = game.pitch(player);
        if (currentYaw == null || currentPitch == null) {
            throw new ProbeException("unsupported", "Player rotation is not available");
        }
        double yaw = stepAngle(currentYaw, targetYaw, maxStep);
        double pitch = targetPitch == null ? currentPitch : currentPitch + clamp(targetPitch - currentPitch, maxStep);
        applyRotation(player, yaw, pitch, currentYaw, currentPitch);
        return yaw;
    }

    /** Like {@link #turnTowards} towards (x, z), at most {@link #TURN_RATE} degrees this tick, keeping the pitch. */
    double faceSmooth(Object player, double x, double z) throws Exception {
        double[] pos = game.position(player);
        return turnTowards(player, yawTowards(x - pos[0], z - pos[2]), null, TURN_RATE);
    }

    /** Yaw and pitch from the eyes to a point: {yaw, pitch} in degrees. */
    double[] rotationTowards(Object player, double x, double y, double z) throws Exception {
        double[] eye = eye(player);
        double dx = x - eye[0], dy = y - eye[1], dz = z - eye[2];
        return new double[]{yawTowards(dx, dz), -Math.toDegrees(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)))};
    }

    void lookAt(Object player, double x, double y, double z) throws Exception {
        double[] rotation = rotationTowards(player, x, y, z);
        setRotation(player, rotation[0], rotation[1]);
    }

    /** Turns towards a point over several ticks instead of jumping the view onto it. */
    void lookAtSmooth(Object player, double x, double y, double z) throws Exception {
        double[] rotation = rotationTowards(player, x, y, z);
        turnTowards(player, rotation[0], rotation[1], TURN_RATE);
    }

    void lookAtEntity(Object player, Object entity) throws Exception {
        double[] pos = game.position(entity);
        lookAt(player, pos[0], pos[1] + height(entity) * 0.6, pos[2]);
    }

    static double yawTowards(double dx, double dz) {
        return Math.toDegrees(Math.atan2(-dx, dz));
    }

    /** Moves {@code current} towards {@code target} by at most {@code maxStep} degrees along the shorter arc. */
    static double stepAngle(double current, double target, double maxStep) {
        return wrapDegrees(current + clamp(wrapDegrees(target - current), maxStep));
    }

    /** Wraps an angle into [-180, 180). */
    static double wrapDegrees(double degrees) {
        double d = degrees % 360;
        if (d >= 180) {
            d -= 360;
        }
        if (d < -180) {
            d += 360;
        }
        return d;
    }

    private static double clamp(double value, double max) {
        return Math.max(-max, Math.min(max, value));
    }

    double[] eye(Object player) {
        double[] pos = game.position(player);
        if (pos == null) {
            throw new ProbeException("unsupported", "Player position is not available");
        }
        Object eyeY = game.optCall(player, "getEyeY");
        return new double[]{pos[0], eyeY instanceof Number ? ((Number) eyeY).doubleValue() : pos[1] + 1.62, pos[2]};
    }

    /** The entity with this id in the client level, or null when it does not exist (game thread). */
    Object entity(Object mc, int entityId) throws Exception {
        Object level = game.optGet(mc, "level");
        Method getEntity = level == null ? null : ref.method(level.getClass(), "getEntity", 1, "int");
        return getEntity == null ? null : getEntity.invoke(level, entityId);
    }

    /** The entity with this id, failing when it is unknown or out of reach. */
    Object entityInReach(Object mc, Object player, int entityId) throws Exception {
        Object entity = entity(mc, entityId);
        if (entity == null) {
            throw new ProbeException("no_entity", "No entity with id " + entityId + " near the player");
        }
        double[] pos = game.position(entity);
        checkReach(player, pos[0], pos[1] + height(entity) / 2, pos[2]);
        return entity;
    }

    private double height(Object entity) {
        Object h = game.optCall(entity, "getBbHeight");
        return h instanceof Number ? ((Number) h).doubleValue() : 1.0;
    }

    /** Distance from the eyes to a point. */
    double distance(Object player, double x, double y, double z) {
        return Math.sqrt(Status.distanceSq(eye(player), new double[]{x, y, z}));
    }

    void checkReach(Object player, double x, double y, double z) {
        double d = distance(player, x, y, z);
        if (d > MAX_REACH) {
            throw new ProbeException("out_of_reach", String.format(Locale.ROOT, "Target is %.1f blocks away; walk within %.1f", d, REACH));
        }
    }

    /** Faces the given (or nearest) face of a block and returns the matching BlockHitResult. */
    Object aimAtBlock(Object player, int[] pos, String face) throws Exception {
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

    /** Makes the crosshair target an entity, so the game's own click handling acts on it. */
    void targetEntity(Object mc, Object player, Object entity) throws Exception {
        lookAtEntity(player, entity);
        ref.setIfPresent(mc, "hitResult", ref.construct("net.minecraft.world.phys.EntityHitResult", entity));
    }

    /**
     * Follows a moving entity smoothly but still forces the hit result onto it, so repeated hits land while the view
     * is sweeping instead of snapping onto the target every tick.
     */
    void trackEntity(Object mc, Object player, Object entity) throws Exception {
        double[] pos = game.position(entity);
        lookAtSmooth(player, pos[0], pos[1] + height(entity) * 0.6, pos[2]);
        ref.setIfPresent(mc, "hitResult", ref.construct("net.minecraft.world.phys.EntityHitResult", entity));
    }

    /** Makes the crosshair target a block face. */
    void targetBlock(Object mc, Object player, int[] pos, String face) throws Exception {
        ref.setIfPresent(mc, "hitResult", aimAtBlock(player, pos, face));
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
