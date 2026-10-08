package calcite.probe;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.Executor;

import calcite.probe.Controls.Key;
import calcite.probe.nav.Goal;
import calcite.probe.nav.Path;
import calcite.probe.nav.Pathfinder;

/**
 * Walking to a position along a path found by {@link Pathfinder}: the player is steered from block to block with
 * the movement keys like a human would (jumping up steps, swimming), and the path is re-planned when the player
 * gets stuck or pushed off it. With {@code direct} the player walks in a straight line instead.
 */
final class Navigator implements Ops.Module {

    private static final int MAX_NODES = 40000;
    private static final long PLAN_MS = 3000;
    private static final int MAX_REPLANS = 6;
    /** Ticks without getting closer before the player counts as stuck. */
    private static final int STUCK_TICKS = 40;

    private final Game game;
    private final Aim aim;
    private final Controls controls;
    private final BlockTerrain terrain;
    private final Executor planner;

    Navigator(Game game, Aim aim, Controls controls, BlockTerrain terrain, Executor planner) {
        this.game = game;
        this.aim = aim;
        this.controls = controls;
        this.terrain = terrain;
        this.planner = planner;
    }

    @Override
    public void register(Ops ops) {
        ops.add("walk_to", a -> {
            Double y = a.optNum("y");
            Goal goal = new Goal(a.num("x"), y == null ? Double.NaN : y, a.num("z"), Math.max(0.2, a.num("range", 0.5)));
            long timeoutMs = a.millis("timeoutMs", 60000);
            Walk walk = new Walk(goal, a.flag("sprint", true), a.flag("direct", false));
            return controls.run(walk.stopOnDamage(a.flag("stopOnDamage", false)), timeoutMs);
        });
    }

    private final class Walk extends Behavior {
        private final Goal goal;
        private final boolean sprint;
        private final boolean direct;
        private CompletableFuture<Path> planning;
        private Path path;
        private int index;
        private int replans = -1;
        private double best = Double.MAX_VALUE;
        private int lastProgress;

        Walk(Goal goal, boolean sprint, boolean direct) {
            super("walk_to");
            this.goal = goal;
            this.sprint = sprint;
            this.direct = direct;
        }

        @Override
        void start(Object mc, Object player) {
            if (!direct) {
                plan(mc, player);
            }
        }

        private void plan(Object mc, Object player) {
            final Object level = game.optGet(mc, "level");
            final double[] p = game.position(player);
            replans++;
            planning = CompletableFuture.supplyAsync(() -> {
                try {
                    // any block centre near the target will do; the last stretch is walked straight to the exact point
                    Goal near = new Goal(goal.x, goal.y, goal.z, goal.range + 0.75);
                    return new Pathfinder(terrain.of(level)).find(p[0], p[1], p[2], near, MAX_NODES, PLAN_MS);
                } catch (Exception e) {
                    throw new CompletionException(e);
                }
            }, planner);
        }

        @Override
        void tick(Object mc, Object player) throws Exception {
            double[] pos = game.position(player);
            if (arrived(pos)) {
                finish(result(player, true, null));
                return;
            }
            if (planning != null && !takePlan(player)) {
                return;
            }
            double remaining = remaining(pos);
            if (remaining < best - 0.3) {
                best = remaining;
                lastProgress = ticks;
            } else if (ticks - lastProgress > STUCK_TICKS) {
                // stuck on the last stretch means the exact point cannot be reached: re-planning will not help
                replanOr(mc, player, "stuck", path != null && path.complete && index == path.steps.size() - 1);
                return;
            }
            if (direct) {
                steer(player, goal.x, goal.z, false, true, true);
                return;
            }
            List<Path.Step> steps = path.steps;
            while (index < steps.size() - 1 && at(pos, steps.get(index))) {
                index++;
            }
            Path.Step step = steps.get(index);
            if (index == steps.size() - 1 && at(pos, step)) {
                if (path.complete) {
                    steer(player, goal.x, goal.z, false, false, true); // last stretch to the exact point
                } else {
                    replanOr(mc, player, "no_path", false);
                }
                return;
            }
            double toStep = horizontal(pos, step.x + 0.5, step.z + 0.5);
            if (toStep > 3) {
                replanOr(mc, player, "off_path", false);
                return;
            }
            boolean dive = step.swim && step.y < pos[1] - 0.5;
            steer(player, step.x + 0.5, step.z + 0.5, step.jump && toStep < 1.4, straightAhead(steps), !dive);
        }

        /** Takes a finished plan; false while it is still being computed. */
        private boolean takePlan(Object player) {
            if (!planning.isDone()) {
                releaseMovement();
                return false;
            }
            path = planning.join();
            planning = null;
            index = 0;
            best = Double.MAX_VALUE;
            lastProgress = ticks;
            if (path.isEmpty() && !path.complete) {
                finish(result(player, false, "no_path"));
                return false;
            }
            return true;
        }

        private void replanOr(Object mc, Object player, String reason, boolean giveUp) {
            if (giveUp || direct || replans >= MAX_REPLANS) {
                finish(result(player, false, reason));
            } else {
                releaseMovement();
                plan(mc, player);
            }
        }

        /** Faces (x, z) and walks there, jumping when asked or against a wall; in water {@code swimUp} keeps afloat. */
        private void steer(Object player, double x, double z, boolean jump, boolean straight, boolean swimUp) throws Exception {
            aim.face(player, x, z);
            boolean swimming = game.inFluid(player);
            boolean blocked = Boolean.TRUE.equals(game.optGet(player, "horizontalCollision"));
            controls.hold(Key.FORWARD, true);
            controls.hold(Key.SPRINT, sprint && straight && !swimming && remaining(game.position(player)) > 3);
            controls.hold(Key.JUMP, swimming ? swimUp || blocked : (jump || blocked) && game.onGround(player));
        }

        /** Sprinting overshoots turns: only along three steps in one direction. */
        private boolean straightAhead(List<Path.Step> steps) {
            if (index + 2 >= steps.size()) {
                return false;
            }
            Path.Step a = steps.get(index), b = steps.get(index + 1), c = steps.get(index + 2);
            return b.x - a.x == c.x - b.x && b.z - a.z == c.z - b.z && !b.jump && !c.jump && a.y == b.y && b.y == c.y;
        }

        private void releaseMovement() {
            controls.hold(Key.FORWARD, false);
            controls.hold(Key.SPRINT, false);
            controls.hold(Key.JUMP, false);
        }

        private boolean at(double[] pos, Path.Step step) {
            return horizontal(pos, step.x + 0.5, step.z + 0.5) < 0.45 && Math.abs(pos[1] - step.floor) < 1.3;
        }

        private boolean arrived(double[] pos) {
            return horizontal(pos, goal.x, goal.z) <= goal.range && (Double.isNaN(goal.y) || Math.abs(pos[1] - goal.y) <= 1);
        }

        private double remaining(double[] pos) {
            double h = horizontal(pos, goal.x, goal.z);
            double v = Double.isNaN(goal.y) ? 0 : pos[1] - goal.y;
            return Math.sqrt(h * h + v * v);
        }

        @Override
        Map<String, Object> progress(Object player) {
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("mode", direct ? "direct" : "path");
            out.put("distance", Status.round(remaining(game.position(player)), 2));
            if (path != null) {
                out.put("waypoint", index);
                out.put("waypoints", path.steps.size());
            }
            out.put("planning", planning != null);
            out.put("replans", Math.max(0, replans));
            return out;
        }

        @Override
        Map<String, Object> stopped(Object player, String reason) {
            return result(player, false, reason);
        }

        private Map<String, Object> result(Object player, boolean arrived, String reason) {
            double[] pos = game.position(player);
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("arrived", arrived);
            if (reason != null) {
                out.put("reason", reason);
            }
            out.put("distance", Status.round(remaining(pos), 2));
            out.put("x", pos[0]);
            out.put("y", pos[1]);
            out.put("z", pos[2]);
            if (!direct) {
                out.put("replans", Math.max(0, replans));
            }
            return out;
        }
    }

    private static double horizontal(double[] pos, double x, double z) {
        double dx = x - pos[0], dz = z - pos[2];
        return Math.sqrt(dx * dx + dz * dz);
    }
}
