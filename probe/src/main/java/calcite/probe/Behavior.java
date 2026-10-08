package calcite.probe;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * An action that lasts several ticks (walking, mining, crafting). {@link Controls} ticks it on the game thread
 * until it calls {@link #finish}, fails, times out, is cancelled, or (with {@link #stopOnDamage}) the player is hurt.
 */
abstract class Behavior {

    final String name;
    final CompletableFuture<Map<String, Object>> done = new CompletableFuture<Map<String, Object>>();
    /** Ticks since the behavior started. */
    int ticks;
    int timeoutTicks = Integer.MAX_VALUE;
    boolean stopOnDamage;
    /** Set by {@link Controls} when the behavior starts. */
    Controls controls;
    double lastHealth = -1;

    Behavior(String name) {
        this.name = name;
    }

    /** Ends the behavior after about {@code ms} milliseconds with the result of {@link #stopped}{@code ("timeout")}. */
    Behavior timeout(long ms) {
        timeoutTicks = (int) Math.max(20, ms / 50);
        return this;
    }

    /** Ends the behavior with {@link #stopped}{@code ("damaged")} when the player loses health. */
    Behavior stopOnDamage(boolean stop) {
        stopOnDamage = stop;
        return this;
    }

    /** Validates and prepares on the game thread before the first tick; throwing rejects the request. */
    void start(Object mc, Object player) throws Exception {
    }

    abstract void tick(Object mc, Object player) throws Exception;

    /** Restores anything the behavior changed; runs on the game thread whenever it ends. */
    void end() throws Exception {
    }

    /** Status shown while the behavior runs (game thread). */
    Map<String, Object> progress(Object player) {
        return new LinkedHashMap<String, Object>();
    }

    /** The result when the behavior is stopped early but not failed, e.g. on timeout or damage. */
    Map<String, Object> stopped(Object player, String reason) {
        Map<String, Object> out = progress(player);
        out.put("reason", reason);
        return out;
    }

    final void finish(Map<String, Object> result) {
        controls.finish(this, result, null);
    }
}
