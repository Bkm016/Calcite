package calcite.probe;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Held controls and the running {@link Behavior}. Held keys are re-applied once per client tick by {@link #pump()},
 * because opening a screen or a focus change resets key states. At most one behavior runs at a time; starting
 * another cancels it.
 */
final class Controls implements Ops.Module {

    enum Key {
        FORWARD("forward", "keyUp"), BACK("back", "keyDown"), LEFT("left", "keyLeft"), RIGHT("right", "keyRight"),
        JUMP("jump", "keyJump"), SNEAK("sneak", "keyShift"), SPRINT("sprint", "keySprint"),
        ATTACK("attack", "keyAttack"), USE("use", "keyUse");

        final String label;
        final String option;

        Key(String label, String option) {
            this.label = label;
            this.option = option;
        }
    }

    private static final Key[] KEYS = Key.values();

    private final Game game;

    // Everything below is only touched on the game thread.
    private final boolean[] held = new boolean[KEYS.length];
    /** Ticks until the held controls are released; -1 holds them until changed. */
    private int releaseIn = -1;
    private boolean keysDirty;
    private Behavior behavior;
    private Object lastPlayer;
    private int lastTick = Integer.MIN_VALUE;

    private volatile boolean active;
    private final AtomicBoolean pumping = new AtomicBoolean();

    Controls(Game game) {
        this.game = game;
    }

    @Override
    public void register(Ops ops) {
        ops.add("move", a -> move(a.raw(), a.integer("ticks", 0)));
        ops.action("stop", a -> stop());
        ops.add("task", a -> game.withPlayer((mc, player) -> task(player)));
    }

    // ---------------------------------------------------------------- behaviors

    /** Starts {@code b} on the game thread and waits for its result; it ends itself after about {@code timeoutMs}. */
    Map<String, Object> run(final Behavior b, long timeoutMs) throws Exception {
        b.timeout(timeoutMs);
        game.withPlayer((mc, player) -> {
            b.start(mc, player);
            cancel("Interrupted by " + b.name);
            clearHeld();
            releaseIn = -1;
            b.controls = this;
            b.lastHealth = game.health(player);
            behavior = b;
            active = true;
            return null;
        });
        try {
            // the behavior's own timeout normally fires first and reports how far it got
            return b.done.get(timeoutMs + 5000, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            game.onGameThread(() -> {
                if (behavior == b) {
                    finish(b, null, new ProbeException("timeout", "Action timed out"));
                }
                return null;
            }, Game.TIMEOUT_MS);
            throw new ProbeException("timeout", "Action timed out after " + timeoutMs + "ms");
        } catch (ExecutionException e) {
            throw ProbeException.unwrap(e);
        }
    }

    /** Ends {@code b} if it is still running (game thread). */
    void finish(Behavior b, Map<String, Object> result, Throwable error) {
        if (behavior != b || b == null) {
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

    private void cancel(String why) {
        finish(behavior, null, new ProbeException("cancelled", why));
    }

    private Map<String, Object> task(Object player) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        Behavior b = behavior;
        out.put("running", b != null);
        if (b != null) {
            out.put("name", b.name);
            out.put("ticks", b.ticks);
            out.putAll(b.progress(player));
        }
        return out;
    }

    // ---------------------------------------------------------------- keys

    /** Presses or releases a key until changed (game thread). */
    void hold(Key key, boolean down) {
        if (held[key.ordinal()] != down) {
            held[key.ordinal()] = down;
            keysDirty = true;
        }
        if (down) {
            active = true;
        }
    }

    /** Cancels the running behavior and holds {@code key} for {@code ticks} ticks (game thread). */
    void holdFor(Object mc, Key key, int ticks) throws Exception {
        cancel("Interrupted by holding " + key.label);
        hold(key, true);
        releaseIn = ticks;
        applyKeys(mc);
    }

    /** Holds (or releases) movement controls, optionally for {@code ticks} ticks. */
    Map<String, Object> move(final Map<String, Object> controls, final int ticks) throws Exception {
        return game.withPlayer((mc, player) -> {
            cancel("Interrupted by move");
            for (Key key : KEYS) {
                Object v = controls.get(key.label);
                if (v instanceof Boolean) {
                    hold(key, (Boolean) v);
                }
            }
            releaseIn = ticks > 0 ? ticks : -1;
            applyKeys(mc);
            updateActive();
            return heldState();
        });
    }

    /** Releases every control and cancels a running behavior. */
    void stop() throws Exception {
        final Object mc = game.requireMinecraft();
        game.onGameThread(() -> {
            cancel("Stopped");
            clearHeld();
            releaseIn = -1;
            applyKeys(mc);
            updateActive();
            return null;
        }, Game.TIMEOUT_MS);
    }

    private Map<String, Object> heldState() {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        for (Key key : KEYS) {
            if (held[key.ordinal()]) {
                out.put(key.label, true);
            }
        }
        if (releaseIn > 0) {
            out.put("releaseInTicks", releaseIn);
        }
        return out;
    }

    // ---------------------------------------------------------------- tick pump

    /** Called every few milliseconds from the probe timer; runs {@link #tick} once per new client tick. */
    void pump() {
        if (active) {
            game.runLater(pumping, () -> {
                Object mc = game.minecraft();
                try {
                    tick(mc);
                } catch (Throwable t) {
                    finish(behavior, null, t);
                }
            });
        }
    }

    private void tick(Object mc) throws Exception {
        Object player = game.optGet(mc, "player");
        if (player == null) {
            finish(behavior, null, new ProbeException("not_in_game", "The client left the world"));
            clearHeld();
            applyKeys(mc);
            updateActive();
            return;
        }
        int tickCount = Ref.intValue(game.optGet(player, "tickCount"), 0);
        if (player != lastPlayer || tickCount != lastTick) {
            lastPlayer = player;
            lastTick = tickCount;
            tickBehavior(mc, player);
            if (releaseIn > 0 && --releaseIn == 0) {
                clearHeld();
                releaseIn = -1;
            }
        }
        applyKeys(mc);
        updateActive();
    }

    private void tickBehavior(Object mc, Object player) {
        Behavior b = behavior;
        if (b == null) {
            return;
        }
        try {
            b.ticks++;
            double health = game.health(player);
            boolean hurt = health >= 0 && b.lastHealth >= 0 && health < b.lastHealth;
            b.lastHealth = health;
            if (b.stopOnDamage && hurt) {
                finish(b, b.stopped(player, "damaged"), null);
            } else if (b.ticks > b.timeoutTicks) {
                finish(b, b.stopped(player, "timeout"), null);
            } else {
                b.tick(mc, player);
            }
        } catch (Throwable t) {
            finish(b, null, t);
        }
    }

    private void updateActive() {
        boolean any = keysDirty || behavior != null;
        for (boolean h : held) {
            any |= h;
        }
        active = any;
    }

    private void clearHeld() {
        for (Key key : KEYS) {
            hold(key, false);
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
        for (Key key : KEYS) {
            Object mapping = game.optGet(options, key.option);
            if (mapping != null) {
                game.invoke(mapping, "setDown", held[key.ordinal()]);
            }
        }
        keysDirty = any;
    }
}
