package calcite.probe.api;

/**
 * A Calcite probe extension: adds commands (callable from Node.js, the CLI and MCP) and events to the bot.
 *
 * <p>Package an implementation in a jar with the file
 * {@code META-INF/services/calcite.probe.api.CalciteExtension} naming the class, and pass the jar to Calcite
 * ({@code extensions} option, {@code --ext} on the command line). Compile against {@code calcite-probe.jar}
 * (shipped in the npm package under {@code vendor/}); do not bundle it.</p>
 *
 * <p>Extensions see the game through {@link Calcite#ref()}, which resolves Mojang's official names on every
 * version and mod loader, so the same jar works on vanilla, Fabric, Forge and NeoForge.</p>
 */
public interface CalciteExtension {

    /** Short id, used as the prefix of the extension's commands and events ({@code id.command}). */
    String id();

    /** Called once when the game is ready; register commands here. */
    void init(Calcite calcite) throws Exception;
}
