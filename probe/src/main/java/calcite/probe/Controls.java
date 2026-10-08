package calcite.probe;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

import calcite.probe.Game.ProbeException;

/**
 * Held controls and multi-tick behaviors. Anything that lasts several ticks (walking, mining, holding right click)
 * holds the game's key mappings and is re-applied once per client tick by {@link #pump()}, because opening a
 * screen or a focus change resets key states.
 */
abstract class Controls {

    static final String[] CONTROLS = {"forward", "back", "left", "right", "jump", "sneak", "sprint", "attack", "use"};
    private static final String[] KEYS = {"keyUp", "keyDown", "keyLeft", "keyRight", "keyJump", "keyShift", "keySprint", "keyAttack", "keyUse"};
    static final int FORWARD = 0, JUMP = 4, SPRINT = 6, ATTACK = 7, USE = 8;

    final Game game;
    final Ref ref;

    // Everything below is only touched on the game thread.
    final boolean[] held = new boolean[CONTROLS.length];
    /** Ticks until the held controls are released; -1 holds them until changed. */
    int releaseIn = -1;
    boolean keysDirty;
    Behavior behavior;
    private Object lastPlayer;
    private int lastTick = Integer.MIN_VALUE;

    private volatile boolean active;
    private final AtomicBoolean pumping = new AtomicBoolean();

    Controls(Game game, Ref ref) {
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
        int tickCount = Ref.intValue(game.optGet(player, "tickCount"), 0);
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

    final void updateActive() {
        boolean any = keysDirty || behavior != null;
        for (boolean h : held) {
            any |= h;
        }
        active = any;
    }

    final void clearHeld() {
        for (int i = 0; i < held.length; i++) {
            if (held[i]) {
                held[i] = false;
                keysDirty = true;
            }
        }
    }

    final void applyKeys(Object mc) throws Exception {
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

    final void startBehavior(Behavior b) {
        finishBehavior(null, new ProbeException("cancelled", "Interrupted by another action"));
        clearHeld();
        releaseIn = -1;
        behavior = b;
        active = true;
    }

    final void finishBehavior(Map<String, Object> result, Throwable error) {
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
    final Map<String, Object> await(final Behavior b, long timeoutMs) throws Exception {
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

    abstract static class Behavior {
        final CompletableFuture<Map<String, Object>> done = new CompletableFuture<Map<String, Object>>();
        int ticks;

        abstract void tick(Object mc, Object player) throws Exception;

        /** Restores anything the behavior changed; runs on the game thread. */
        void end() throws Exception {
        }
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
}
