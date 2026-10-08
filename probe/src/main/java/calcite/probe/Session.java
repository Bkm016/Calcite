package calcite.probe;

import java.lang.reflect.Method;
import java.util.concurrent.Callable;

import calcite.probe.Game.ProbeException;

/** Chat, commands, respawning and joining servers. */
final class Session {

    private final Game game;
    private final Ref ref;

    Session(Game game, Ref ref) {
        this.game = game;
        this.ref = ref;
    }

    public void chat(final String message) throws Exception {
        final Object mc = game.requireMinecraft();
        game.onGameThread(new Callable<Object>() {
            @Override
            public Object call() throws Exception {
                Object player = game.requirePlayer(mc);
                Object conn = game.optGet(player, "connection");
                if (conn != null && game.invoke(conn, "sendChat", message)) {
                    return null; // 1.19.3+
                }
                if (game.invoke(player, "chatSigned", message, null)) {
                    return null; // 1.19.1 - 1.19.2
                }
                if (game.invoke(player, "chat", message)) {
                    return null; // <= 1.19
                }
                throw new ProbeException("unsupported", "No chat API found for this version");
            }
        }, 5000);
    }

    public void command(String raw) throws Exception {
        final String command = raw.startsWith("/") ? raw.substring(1) : raw;
        final Object mc = game.requireMinecraft();
        game.onGameThread(new Callable<Object>() {
            @Override
            public Object call() throws Exception {
                Object player = game.requirePlayer(mc);
                Object conn = game.optGet(player, "connection");
                if (conn != null && (game.invoke(conn, "sendCommand", command) || game.invoke(conn, "sendUnsignedCommand", command))) {
                    return null; // 1.19.3+
                }
                if (game.invoke(player, "commandUnsigned", command) || game.invoke(player, "commandSigned", command, null)
                        || game.invoke(player, "command", command)) {
                    return null; // 1.19 - 1.19.2
                }
                if (game.invoke(player, "chat", "/" + command)) {
                    return null; // <= 1.18
                }
                throw new ProbeException("unsupported", "No command API found for this version");
            }
        }, 5000);
    }

    public void respawn() throws Exception {
        final Object mc = game.requireMinecraft();
        game.onGameThread(new Callable<Object>() {
            @Override
            public Object call() throws Exception {
                Object player = game.requirePlayer(mc);
                if (!game.invoke(player, "respawn")) {
                    throw new ProbeException("unsupported", "LocalPlayer#respawn is not available");
                }
                // close the death screen
                game.setScreen(mc, null);
                return null;
            }
        }, 5000);
    }

    /**
     * Joins a server from the current screen through the game's own ConnectScreen. Used for versions without
     * Quick Play, where the --server argument can be ignored (e.g. 1.16.4+ when multiplayer privileges are unknown).
     */
    public void connect(final String host, final int port) throws Exception {
        final Object mc = game.requireMinecraft();
        game.onGameThread(new Callable<Object>() {
            @Override
            public Object call() throws Exception {
                Class<?> connect = ref.cls("net.minecraft.client.gui.screens.ConnectScreen");
                if (connect == null) {
                    throw new ProbeException("unsupported", "ConnectScreen not found");
                }
                Class<?> titleClass = ref.cls("net.minecraft.client.gui.screens.TitleScreen");
                Object parent = titleClass == null ? game.screen(mc) : titleClass.getConstructor().newInstance();
                // 1.17+: static startConnecting(Screen, Minecraft, ServerAddress, ServerData[, boolean[, TransferState]])
                for (int n = 6; n >= 4; n--) {
                    Method m = ref.method(connect, "startConnecting", n);
                    if (m != null && java.lang.reflect.Modifier.isStatic(m.getModifiers())) {
                        m.invoke(null, connectArgs(m.getParameterTypes(), mc, parent, host, port));
                        return null;
                    }
                }
                // 1.14 - 1.16: new ConnectScreen(Screen, Minecraft, String, int)
                for (java.lang.reflect.Constructor<?> c : connect.getConstructors()) {
                    Class<?>[] types = c.getParameterTypes();
                    if (types.length == 4 && types[2] == String.class && types[3] == int.class) {
                        Object screen = c.newInstance(connectArgs(types, mc, parent, host, port));
                        game.setScreen(mc, screen);
                        return null;
                    }
                }
                throw new ProbeException("unsupported", "No compatible ConnectScreen entry point in this version");
            }
        }, 10000);
    }

    private Object[] connectArgs(Class<?>[] types, Object mc, Object parent, String host, int port) throws Exception {
        Object[] args = new Object[types.length];
        boolean stringUsed = false;
        for (int i = 0; i < types.length; i++) {
            Class<?> t = types[i];
            String named = ref.named(t);
            if (t == String.class && !stringUsed) {
                args[i] = host;
                stringUsed = true;
            } else if (t == int.class) {
                args[i] = port;
            } else if (t == boolean.class) {
                args[i] = false;
            } else if (t.isInstance(mc)) {
                args[i] = mc;
            } else if (parent != null && t.isInstance(parent)) {
                args[i] = parent;
            } else if (named.endsWith(".ServerAddress")) {
                args[i] = t.getConstructor(String.class, int.class).newInstance(host, port);
            } else if (named.endsWith(".ServerData")) {
                args[i] = serverData(t, host + ":" + port);
            } else {
                args[i] = null;
            }
        }
        return args;
    }

    /** new ServerData("Calcite", ip, ...) across its constructor variants; null when none fits. */
    private Object serverData(Class<?> type, String ip) {
        for (java.lang.reflect.Constructor<?> c : type.getConstructors()) {
            Class<?>[] p = c.getParameterTypes();
            if (p.length != 3 || p[0] != String.class || p[1] != String.class) {
                continue;
            }
            try {
                if (p[2] == boolean.class) {
                    return c.newInstance("Calcite", ip, false);
                }
                if (p[2].isEnum()) {
                    Object[] constants = p[2].getEnumConstants();
                    Object other = constants[constants.length - 1];
                    Mappings.ClassEntry entry = ref.mappings().byRuntime(p[2].getName());
                    String otherName = entry == null || entry.field("OTHER") == null ? "OTHER" : entry.field("OTHER");
                    for (Object k : constants) {
                        if (otherName.equals(((Enum<?>) k).name())) {
                            other = k;
                        }
                    }
                    return c.newInstance("Calcite", ip, other);
                }
            } catch (Throwable ignored) {
                // try the next constructor
            }
        }
        return null;
    }
}
