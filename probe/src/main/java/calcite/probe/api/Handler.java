package calcite.probe.api;

import java.util.Map;

/** Handles one extension command. Runs on a probe worker thread; use {@link Calcite#onGameThread} for game state. */
public interface Handler {

    /**
     * @param args the JSON arguments (maps, lists, strings, numbers, booleans, null)
     * @return a JSON-compatible result: Map, Collection, array, String, Number, Boolean or null (anything else is
     *     sent as its {@code toString()})
     */
    Object handle(Map<String, Object> args) throws Exception;
}
