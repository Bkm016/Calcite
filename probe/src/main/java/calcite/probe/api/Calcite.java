package calcite.probe.api;

import java.util.Map;
import java.util.concurrent.Callable;

import calcite.probe.Ref;

/** What the probe offers an extension. */
public interface Calcite {

    /** Reflection by Mojang's official names (classes, fields, methods), resolved for the running game. */
    Ref ref();

    /** The {@code net.minecraft.client.Minecraft} instance. */
    Object minecraft();

    /** Minecraft version id, e.g. "1.21.11", or null when unknown. */
    String minecraftVersion();

    /** True when the client runs without a renderer. */
    boolean headless();

    /** Runs {@code task} on the game (render) thread and waits for it, at most {@code timeoutMs}. */
    <T> T onGameThread(Callable<T> task, long timeoutMs) throws Exception;

    /** Registers command {@code <id>.<name>}. */
    void command(String name, Handler handler);

    /**
     * Registers command {@code <id>.<name>} with a description and a JSON schema of its arguments (shown to AI agents
     * through MCP).
     */
    void command(String name, String description, Map<String, Object> argsSchema, Handler handler);

    /** Sends event {@code <id>.<name>} to the controller. Dropped while no controller is connected. */
    void emit(String name, Object data);

    /** Calls a built-in probe operation (e.g. "state", "entities", "look", "inventory") with JSON arguments. */
    Object call(String op, Map<String, Object> args) throws Exception;

    /** Writes a line to the game log, prefixed with the extension id. */
    void log(String message);
}
