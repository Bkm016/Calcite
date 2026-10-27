package calcite.probe;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Looking, attacking, using items/blocks and mining.
 *
 * <p>Single clicks call the game's own {@code startAttack}/{@code startUseItem} with a forced hit result, so swing,
 * cooldown and packet logic stay vanilla for every version.</p>
 */
final class Actions implements Ops.Module {

    private final Game game;
    private final Ref ref;
    private final World world;
    private final Aim aim;
    private final Controls controls;

    Actions(Game game, Ref ref, World world, Aim aim, Controls controls) {
        this.game = game;
        this.ref = ref;
        this.world = world;
        this.aim = aim;
        this.controls = controls;
    }

    @Override
    public void register(Ops ops) {
        ops.add("look", a -> look(a.optNum("yaw"), a.optNum("pitch"), a.has("x") ? new double[]{a.num("x"), a.num("y"), a.num("z")} : null));
        ops.add("attack", a -> {
            Integer entityId = a.optInt("entityId");
            int ticks = a.integer("ticks", 0);
            if (ticks > 0) {
                if (entityId == null) {
                    throw new ProbeException("bad_request", "A continuous attack needs entityId");
                }
                return controls.run(new Attack(entityId).stopOnDamage(a.flag("stopOnDamage", false)), ticks * 50L);
            }
            return attack(entityId, a.flag("charged", false), a.millis("timeoutMs", 2000));
        });
        ops.add("use", a -> use(a.optInt("entityId"), a.optBlockPos(), a.str("face", null), a.integer("holdTicks", 0)));
        ops.add("dig", a -> controls.run(new Dig(a.blockPos(), a.str("face", null)).stopOnDamage(a.flag("stopOnDamage", false)),
                a.millis("timeoutMs", 30000)));
    }

    Map<String, Object> look(final Double yaw, final Double pitch, final double[] at) throws Exception {
        return game.withPlayer((mc, player) -> {
            if (at != null) {
                aim.lookAt(player, at[0], at[1], at[2]);
            } else {
                Double y = yaw != null ? yaw : game.yaw(player);
                Double p = pitch != null ? pitch : game.pitch(player);
                aim.setRotation(player, y == null ? 0 : y, p == null ? 0 : p);
            }
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("yaw", game.yaw(player));
            out.put("pitch", game.pitch(player));
            return out;
        });
    }

    /** Attack cooldown at which a hit does (nearly) full damage. */
    private static final double FULL_STRENGTH = 0.95;

    /** How charged the attack cooldown is, 0 to 1; a hit below 1 does proportionally less damage. */
    private double attackStrength(Object player) {
        Method m = ref.method(player.getClass(), "getAttackStrengthScale", 1);
        try {
            Object v = m == null ? null : m.invoke(player, 0f);
            return v instanceof Number ? Status.round(((Number) v).doubleValue(), 2) : 1.0;
        } catch (ReflectiveOperationException e) {
            return 1.0;
        }
    }

    private double strength() throws Exception {
        return game.withPlayer((mc, player) -> attackStrength(player));
    }

    /** Left click: attacks entity {@code entityId} (facing it first), or whatever the crosshair targets. */
    Map<String, Object> attack(final Integer entityId, final boolean charged, final long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (charged && strength() < FULL_STRENGTH && System.currentTimeMillis() < deadline) {
            Thread.sleep(25);
        }
        return game.withPlayer((mc, player) -> {
            game.requireAlive(player);
            if (entityId != null) {
                aim.targetEntity(mc, player, aim.entityInReach(mc, player, entityId));
            }
            Map<String, Object> target = world.describeHit(mc);
            target.put("strength", attackStrength(player));
            ref.setIfPresent(mc, "missTime", 0);
            ref.callOrFail(mc, "startAttack");
            return target;
        });
    }

    /**
     * Right click on an entity, a block face, or (neither) whatever the crosshair targets. With {@code holdTicks}
     * the use key stays pressed afterwards, e.g. to eat, drink, block or draw a bow.
     */
    Map<String, Object> use(final Integer entityId, final int[] block, final String face, final int holdTicks) throws Exception {
        return game.withPlayer((mc, player) -> {
            game.requireAlive(player);
            if (entityId != null) {
                aim.targetEntity(mc, player, aim.entityInReach(mc, player, entityId));
            } else if (block != null) {
                Object state = world.blockState(mc, block);
                if (state == null || game.isAir(state)) {
                    // a click on air does nothing; the block may just not have reached the client yet (waitFor {block})
                    throw new ProbeException("no_block", "The client sees no block at " + block[0] + " " + block[1] + " " + block[2]
                            + (state == null ? " (chunk not loaded)" : " (air); to place a block target the solid neighbour and its face"));
                }
                aim.targetBlock(mc, player, block, face);
            }
            Map<String, Object> target = world.describeHit(mc);
            click(mc);
            if (holdTicks > 0) {
                controls.holdFor(mc, Controls.Key.USE, holdTicks);
                target.put("holdTicks", holdTicks);
            }
            return target;
        });
    }

    /** Right clicks a block face, e.g. to open a crafting table (game thread). */
    void useBlock(Object mc, Object player, int[] block) throws Exception {
        aim.targetBlock(mc, player, block, null);
        click(mc);
    }

    private void click(Object mc) throws Exception {
        ref.setIfPresent(mc, "rightClickDelay", 0);
        ref.callOrFail(mc, "startUseItem");
    }

    /**
     * Keeps hitting one entity until it dies, walks out of reach, or the behavior times out. The view follows the
     * entity smoothly and each hit is forced onto it, so a moving target stays locked instead of being re-aimed
     * with a visible snap every tick.
     */
    private final class Attack extends Behavior {
        private final int entityId;
        private int attacks;
        private Map<String, Object> entityInfo;

        Attack(int entityId) {
            super("attack");
            this.entityId = entityId;
        }

        @Override
        void start(Object mc, Object player) throws Exception {
            game.requireAlive(player);
            if (aim.entity(mc, entityId) == null) {
                throw new ProbeException("no_entity", "No entity with id " + entityId + " near the player");
            }
        }

        @Override
        void tick(Object mc, Object player) throws Exception {
            game.requireAlive(player);
            Object entity = aim.entity(mc, entityId);
            if (entity == null || game.isRemoved(entity) || game.health(entity) == 0) {
                Map<String, Object> out = progress(player);
                out.put("killed", true);
                finish(out);
                return;
            }
            double[] pos = game.position(entity);
            if (aim.distance(player, pos[0], pos[1] + 0.5, pos[2]) > Aim.MAX_REACH) {
                Map<String, Object> out = progress(player);
                out.put("killed", false);
                out.put("reason", "out_of_reach");
                finish(out);
                return;
            }
            entityInfo = game.describe(entity);
            aim.trackEntity(mc, player, entity);
            // the game ignores clicks until the cooldown is full (a hit then does full damage)
            if (attackStrength(player) >= FULL_STRENGTH) {
                ref.setIfPresent(mc, "missTime", 0);
                ref.callOrFail(mc, "startAttack");
                attacks++;
            }
        }

        @Override
        Map<String, Object> progress(Object player) {
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("type", "entity");
            if (entityInfo != null) {
                out.put("entity", entityInfo);
            }
            out.put("attacks", attacks);
            return out;
        }

        @Override
        Map<String, Object> stopped(Object player, String reason) {
            Map<String, Object> out = super.stopped(player, reason);
            out.put("killed", false);
            return out;
        }
    }

    /**
     * Mines a block by aiming at it and holding the attack key, exactly like a player; works in survival (taking the
     * block's break time) and creative. Ends when the block is gone.
     */
    private final class Dig extends Behavior {
        private final int[] pos;
        private final String face;
        private final Field grabbed = ref.field(ref.cls("net.minecraft.client.MouseHandler"), "mouseGrabbed");
        private Object mouse;
        private boolean wasGrabbed;
        private String blockId;

        Dig(int[] pos, String face) {
            super("dig");
            this.pos = pos;
            this.face = face;
        }

        @Override
        void start(Object mc, Object player) throws Exception {
            game.requireAlive(player);
            Object state = world.blockState(mc, pos);
            if (state == null || game.isAir(state)) {
                throw new ProbeException("no_block", "There is no block at " + pos[0] + " " + pos[1] + " " + pos[2] + (state == null ? " (chunk not loaded)" : ""));
            }
            aim.checkReach(player, pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5);
            blockId = world.blockId(state);
            mouse = game.optGet(mc, "mouseHandler");
            wasGrabbed = grabbed != null && mouse != null && grabbed.getBoolean(mouse);
        }

        @Override
        void tick(Object mc, Object player) throws Exception {
            Object state = world.blockState(mc, pos);
            if (state != null && game.isAir(state)) {
                Map<String, Object> out = progress(player);
                out.put("broken", true);
                finish(out);
                return;
            }
            if (game.screen(mc) != null) {
                throw new ProbeException("screen_open", "Close the open screen before digging");
            }
            // aim every tick: the game re-picks its hit result each tick from the player's rotation
            aim.targetBlock(mc, player, pos, face);
            // continueAttack only mines while the mouse is "grabbed" (focused game window)
            if (grabbed != null && mouse != null) {
                grabbed.setBoolean(mouse, true);
            }
            controls.hold(Controls.Key.ATTACK, true);
        }

        @Override
        void end() throws Exception {
            if (grabbed != null && mouse != null) {
                grabbed.setBoolean(mouse, wasGrabbed);
            }
        }

        @Override
        Map<String, Object> progress(Object player) {
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("block", blockId);
            out.put("ticks", ticks);
            return out;
        }

        @Override
        Map<String, Object> stopped(Object player, String reason) {
            Map<String, Object> out = super.stopped(player, reason);
            out.put("broken", false);
            return out;
        }
    }
}
