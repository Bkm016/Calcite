package calcite.probe;

import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executor;

/** Singleplayer: opening or creating a world from the title screen and closing it with everything saved. */
final class Worlds implements Ops.Module {

    private static final String CREATE_SCREEN = "net.minecraft.client.gui.screens.worldselection.CreateWorldScreen";
    private static final long SCREEN_TIMEOUT_MS = 60000;

    private final Game game;
    private final Ref ref;

    Worlds(Game game, Ref ref) {
        this.game = game;
        this.ref = ref;
    }

    @Override
    public void register(Ops ops) {
        ops.add("open_world", a -> open(a.str("name"), a.flag("create", true), a.str("gameMode", "survival"), a.str("seed", "")));
        ops.add("close_world", a -> close());
    }

    /** Opens the save {@code name}, creating it first when it does not exist. Returns once loading has begun. */
    Map<String, Object> open(final String name, boolean create, String gameMode, String seed) throws Exception {
        final Object mc = game.requireMinecraft();
        boolean exists = game.onGameThread(() -> Boolean.TRUE.equals(ref.call(ref.call(mc, "getLevelSource"), "levelExists", name)), 10000);
        if (!exists && !create) {
            throw new ProbeException("unknown_world", "No singleplayer world named \"" + name + "\"");
        }
        if (exists) {
            game.onGameThread(() -> {
                load(mc, name);
                return null;
            }, 10000);
        } else {
            Object screen = openCreateScreen(mc);
            configure(screen, name, gameMode, seed);
            later(mc, () -> ref.call(screen, "onCreate"));
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("name", name);
        out.put("created", !exists);
        return out;
    }

    /** WorldOpenFlows (1.19+) or Minecraft#loadLevel; loading runs on the game thread after this returns. */
    private void load(final Object mc, final String name) throws Exception {
        final Runnable backToTitle = () -> {
            try {
                game.setScreen(mc, titleScreen(mc));
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        };
        final Object flows = game.optCall(mc, "createWorldOpenFlows");
        later(mc, () -> {
            if (flows == null) {
                ref.call(mc, "loadLevel", name); // <= 1.18
            } else if (!game.invoke(flows, "openWorld", name, backToTitle) // 1.20.5+
                    && !game.invoke(flows, "checkForBackupAndLoad", name, backToTitle) // 1.20.3 - 1.20.4
                    && !game.invoke(flows, "loadLevel", titleScreen(mc), name)) { // 1.19 - 1.20.2
                throw new ProbeException("unsupported", "No way to open a world in this version");
            }
            return null;
        });
    }

    /** Opens the game's own create-world screen and waits until it is showing (1.19+ loads data packs first). */
    private Object openCreateScreen(final Object mc) throws Exception {
        final Class<?> type = ref.cls(CREATE_SCREEN);
        if (type == null) {
            throw new ProbeException("unsupported", "CreateWorldScreen not found");
        }
        game.onGameThread(() -> {
            Object title = titleScreen(mc);
            Method fresh = ref.method(type, "openFresh", 2);
            if (fresh != null) {
                Object parent = fresh.getParameterTypes()[1] == Runnable.class ? (Runnable) () -> { } : title;
                fresh.invoke(null, mc, parent); // 1.18.2+
            } else {
                game.setScreen(mc, ref.method(type, "create", 1).invoke(null, title)); // <= 1.18.1
            }
            return null;
        }, 10000);
        long deadline = System.currentTimeMillis() + SCREEN_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            Object screen = game.onGameThread(() -> game.screen(mc), 10000);
            if (type.isInstance(screen)) {
                return screen;
            }
            Thread.sleep(100);
        }
        throw new ProbeException("timeout", "The create-world screen did not open");
    }

    private void configure(final Object screen, final String name, final String gameMode, final String seed) throws Exception {
        game.onGameThread(() -> {
            Object ui = game.optGet(screen, "uiState");
            if (ui != null) { // 1.19.4+
                ref.call(ui, "setName", name);
                ref.call(ui, "setGameMode", constant(ui, "setGameMode", gameMode));
                if (!game.invoke(ui, "setAllowCommands", true)) {
                    ref.call(ui, "setAllowCheats", true);
                }
                if (!seed.isEmpty()) {
                    ref.call(ui, "setSeed", seed);
                }
                return null;
            }
            ref.call(game.optGet(screen, "nameEdit"), "setValue", name); // also picks the folder name
            Object mode = constant(screen, "setGameMode", gameMode);
            if (!game.invoke(screen, "setGameMode", mode)) {
                ref.set(screen, "gameMode", mode);
            }
            ref.set(screen, "commands", true);
            ref.setIfPresent(screen, "commandsChanged", true);
            Object seedEdit = game.optGet(game.optGet(screen, "worldGenSettingsComponent"), "seedEdit");
            if (!seed.isEmpty() && seedEdit != null) {
                ref.call(seedEdit, "setValue", seed);
            }
            return null;
        }, 10000);
    }

    /** The SelectedGameMode constant ("survival", "creative", "hardcore") taken by {@code owner.setter}. */
    private Object constant(Object owner, String setter, String gameMode) throws Exception {
        Method m = ref.method(owner.getClass(), setter, 1);
        Class<?> type = m != null ? m.getParameterTypes()[0] : ref.field(owner.getClass(), "gameMode").getType();
        for (Object k : type.getEnumConstants()) {
            if (ref.enumName(k).equalsIgnoreCase(gameMode)) {
                return k;
            }
        }
        throw new ProbeException("bad_request", "gameMode must be survival, creative or hardcore");
    }

    /**
     * Stops the integrated server, which saves the world and the player, and waits for it. The client is left on a
     * disconnected screen; the controller exits the game next.
     */
    Map<String, Object> close() throws Exception {
        Object mc = game.requireMinecraft();
        Object server = game.optCall(mc, "getSingleplayerServer");
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("saved", server != null);
        if (server != null) {
            ref.call(server, "halt", true); // off the game thread: the server may still need it while stopping
        }
        return out;
    }

    private Object titleScreen(Object mc) throws Exception {
        Class<?> title = ref.cls("net.minecraft.client.gui.screens.TitleScreen");
        return title == null ? game.screen(mc) : title.getConstructor().newInstance();
    }

    /** Queues a long-running step (world loading blocks the game thread) and logs a failure instead of waiting. */
    private static void later(Object mc, final java.util.concurrent.Callable<Object> step) {
        ((Executor) mc).execute(() -> {
            try {
                step.call();
            } catch (Throwable t) {
                Throwable cause = t instanceof java.lang.reflect.InvocationTargetException ? t.getCause() : t;
                System.err.println("[Calcite] opening the world failed: " + cause);
            }
        });
    }
}
