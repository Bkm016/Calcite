package calcite.probe;

import java.lang.reflect.Method;
import java.util.Locale;

/** Turning the player, reach checks and synthetic hit results for clicks. Game thread only. */
final class Aim {

    static final String[] FACES = {"down", "up", "north", "south", "west", "east"};
    /** Generous reach limit; the server enforces the real one. */
    static final double MAX_REACH = 6.0;

    private final Game game;
    private final Ref ref;
    private final World world;

    Aim(Game game, Ref ref, World world) {
        this.game = game;
        this.ref = ref;
        this.world = world;
    }

    void setRotation(Object player, double yaw, double pitch) throws Exception {
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

    /** Turns horizontally towards (x, z), keeping the pitch. */
    void face(Object player, double x, double z) throws Exception {
        double[] pos = game.position(player);
        Double pitch = game.rotation(player, "getXRot", "xRot");
        setRotation(player, yawTowards(x - pos[0], z - pos[2]), pitch == null ? 0 : pitch);
    }

    void lookAt(Object player, double x, double y, double z) throws Exception {
        double[] eye = eye(player);
        double dx = x - eye[0], dy = y - eye[1], dz = z - eye[2];
        setRotation(player, yawTowards(dx, dz), -Math.toDegrees(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz))));
    }

    void lookAtEntity(Object player, Object entity) throws Exception {
        double[] pos = game.position(entity);
        lookAt(player, pos[0], pos[1] + height(entity) * 0.6, pos[2]);
    }

    static double yawTowards(double dx, double dz) {
        return Math.toDegrees(Math.atan2(-dx, dz));
    }

    double[] eye(Object player) {
        double[] pos = game.position(player);
        if (pos == null) {
            throw new ProbeException("unsupported", "Player position is not available");
        }
        Object eyeY = game.optCall(player, "getEyeY");
        return new double[]{pos[0], eyeY instanceof Number ? ((Number) eyeY).doubleValue() : pos[1] + 1.62, pos[2]};
    }

    /** The entity with this id, failing when it is unknown or out of reach. */
    Object entityInReach(Object mc, Object player, int entityId) throws Exception {
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

    private double height(Object entity) {
        Object h = game.optCall(entity, "getBbHeight");
        return h instanceof Number ? ((Number) h).doubleValue() : 1.0;
    }

    void checkReach(Object player, double x, double y, double z) {
        double d = Math.sqrt(Status.distanceSq(eye(player), new double[]{x, y, z}));
        if (d > MAX_REACH) {
            throw new ProbeException("out_of_reach", String.format(Locale.ROOT, "Target is %.1f blocks away; walk closer (reach is about 4.5)", d));
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
