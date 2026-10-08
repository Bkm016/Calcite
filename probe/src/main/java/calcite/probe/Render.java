package calcite.probe;

import java.io.File;
import java.lang.reflect.Method;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/** World rendering on/off and screenshots. */
final class Render implements Ops.Module {

    private final Game game;
    private final Ref ref;
    /** Desired value of Minecraft.noRender; null = leave the game alone. */
    private volatile Boolean wantNoRender;

    Render(Game game, Ref ref) {
        this.game = game;
        this.ref = ref;
    }

    @Override
    public void register(Ops ops) {
        ops.action("render", a -> {
            if (game.headless()) {
                throw new ProbeException("headless", "The client runs without a renderer (headless)");
            }
            setRender(a.flag("enabled", false));
        });
        ops.add("screenshot", a -> screenshot(a.str("name"), a.integer("settleFrames", 3), a.millis("timeoutMs", 20000)));
    }

    /** Sets whether the world is rendered; enforced continuously by {@link #enforceRender()}. */
    void setRender(boolean render) {
        wantNoRender = !render;
        enforceRender();
    }

    /** Re-applies the desired render state (opening any screen resets Minecraft.noRender). */
    void enforceRender() {
        final Boolean want = wantNoRender;
        final Object mc = game.minecraft();
        if (want == null || mc == null) {
            return;
        }
        final java.lang.reflect.Field f = ref.field(mc.getClass(), "noRender");
        if (f == null) {
            return;
        }
        ((Executor) mc).execute(() -> {
            try {
                // Overlays (the resource-loading screen) only advance while being rendered; suppressing
                // rendering then would stall startup or a resource reload forever.
                boolean effective = want && game.optGet(mc, "overlay") == null;
                if (f.getBoolean(mc) != effective) {
                    f.setBoolean(mc, effective);
                }
            } catch (Throwable ignored) {
                // best effort
            }
        });
    }

    boolean renderToggleSupported() {
        Object mc = game.minecraft();
        return mc != null && ref.field(mc.getClass(), "noRender") != null;
    }

    /**
     * Renders a few frames (if rendering is normally off) and saves a screenshot through the game's own
     * screenshot code. Returns the absolute path of the PNG.
     */
    String screenshot(final String fileName, int settleFrames, long timeoutMs) throws Exception {
        if (game.headless()) {
            throw new ProbeException("headless", "The client runs without a renderer (headless); screenshots need a display");
        }
        final Object mc = game.requireMinecraft();
        final Boolean previous = wantNoRender;
        wantNoRender = false;
        enforceRender();
        try {
            waitFrames(mc, Math.max(2, settleFrames), timeoutMs);
            if (waitSections(mc, Math.min(5000, timeoutMs / 2))) {
                waitFrames(mc, 2, timeoutMs);
            }
            final File gameDir = (File) ref.get(mc, "gameDirectory");
            final File dir = new File(gameDir, "screenshots");
            final long started = System.currentTimeMillis();
            final CompletableFuture<Object> done = new CompletableFuture<Object>();
            game.onGameThread(() -> {
                grab(mc, gameDir, fileName, done::complete);
                return null;
            }, timeoutMs);
            Object message = done.get(timeoutMs, TimeUnit.MILLISECONDS);
            File expected = new File(dir, fileName);
            File file = expected.isFile() ? expected : newestPng(dir, started);
            if (file == null) {
                throw new ProbeException("screenshot_failed", "Screenshot was not written: " + game.text(message));
            }
            return file.getAbsolutePath();
        } finally {
            wantNoRender = previous;
            enforceRender();
        }
    }

    private void grab(Object mc, File gameDir, String name, Consumer<Object> callback) throws Exception {
        Class<?> screenshot = ref.cls("net.minecraft.client.Screenshot");
        if (screenshot == null) {
            throw new ProbeException("unsupported", "net.minecraft.client.Screenshot not found");
        }
        Object target = game.optCall(mc, "getMainRenderTarget");
        if (target == null) {
            // 26.x: the main render target belongs to the GameRenderer
            Object gameRenderer = game.optGet(mc, "gameRenderer");
            if (gameRenderer != null) target = game.optCall(gameRenderer, "mainRenderTarget");
        }
        if (target == null) {
            throw new ProbeException("unsupported", "Main render target not found");
        }
        String rt = "com.mojang.blaze3d.pipeline.RenderTarget";
        Method m;
        // 1.21.x: grab(File, String, RenderTarget, int downscale, Consumer)
        if ((m = ref.method(screenshot, "grab", 5, "java.io.File", "java.lang.String", rt, "int", "java.util.function.Consumer")) != null) {
            m.invoke(null, gameDir, name, target, 1, callback);
            return;
        }
        // 1.17 - 1.21.4: grab(File, String, RenderTarget, Consumer)
        if ((m = ref.method(screenshot, "grab", 4, "java.io.File", "java.lang.String", rt, "java.util.function.Consumer")) != null) {
            m.invoke(null, gameDir, name, target, callback);
            return;
        }
        int[] size = framebufferSize(mc, target);
        // 1.14 - 1.16: grab(File, String, int width, int height, RenderTarget, Consumer)
        if ((m = ref.method(screenshot, "grab", 6, "java.io.File", "java.lang.String", "int", "int", rt, "java.util.function.Consumer")) != null) {
            m.invoke(null, gameDir, name, size[0], size[1], target, callback);
            return;
        }
        if ((m = ref.method(screenshot, "grab", 3, "java.io.File", rt, "java.util.function.Consumer")) != null) {
            m.invoke(null, gameDir, target, callback);
            return;
        }
        if ((m = ref.method(screenshot, "grab", 5, "java.io.File", "int", "int", rt, "java.util.function.Consumer")) != null) {
            m.invoke(null, gameDir, size[0], size[1], target, callback);
            return;
        }
        throw new ProbeException("unsupported", "No compatible Screenshot#grab signature in this version");
    }

    private int[] framebufferSize(Object mc, Object target) {
        Object w = game.optGet(target, "width"), h = game.optGet(target, "height");
        if (w instanceof Number && h instanceof Number) {
            return new int[]{((Number) w).intValue(), ((Number) h).intValue()};
        }
        Object window = game.optCall(mc, "getWindow");
        Object ww = game.optCall(window, "getWidth"), wh = game.optCall(window, "getHeight");
        if (ww instanceof Number && wh instanceof Number) {
            return new int[]{((Number) ww).intValue(), ((Number) wh).intValue()};
        }
        return new int[]{854, 480};
    }

    /**
     * While the world was not rendered no chunk meshes were built; waits (bounded) until the level renderer has
     * compiled every visible section so the screenshot is not missing terrain. Returns whether it had to wait.
     */
    private boolean waitSections(Object mc, long maxMs) throws InterruptedException {
        Object levelRenderer = game.optGet(mc, "levelRenderer");
        if (levelRenderer == null || game.optGet(mc, "level") == null) {
            return false;
        }
        // "All sections rendered" is also true before the first frames queued anything (right after joining or
        // after rendering was off), so the number of rendered sections must be non-zero and settled as well.
        long start = System.currentTimeMillis();
        long deadline = start + maxMs;
        boolean waited = false;
        int last = -1;
        int stable = 0;
        while (System.currentTimeMillis() < deadline) {
            Object done = game.optCall(levelRenderer, "hasRenderedAllSections");
            if (done == null) {
                done = game.optCall(levelRenderer, "hasRenderedAllChunks");
            }
            boolean queueEmpty = !Boolean.FALSE.equals(done);
            int rendered = renderedSections(levelRenderer);
            stable = rendered == last ? stable + 1 : 0;
            last = rendered;
            if (queueEmpty) {
                if (rendered == -1) {
                    return waited; // count not available in this version
                }
                if (rendered > 0 && stable >= 3) {
                    return waited;
                }
                if (rendered == 0 && System.currentTimeMillis() - start > 1500) {
                    return waited; // nothing to draw (void, or no chunks sent)
                }
            }
            waited = true;
            Thread.sleep(50);
        }
        return waited;
    }

    /**
     * Number of sections drawn in the last frame; -1 when this version offers no way to tell, -2 when reading it
     * raced with the render thread (try again).
     */
    private int renderedSections(Object levelRenderer) {
        for (String name : new String[] {"countRenderedSections", "countRenderedChunks", "visibleSections"}) {
            Method m = ref.method(levelRenderer.getClass(), name, 0);
            if (m == null) {
                continue;
            }
            try {
                Object n = m.invoke(levelRenderer);
                if (n instanceof Number) {
                    return ((Number) n).intValue();
                }
                if (n instanceof java.util.Collection) {
                    return ((java.util.Collection<?>) n).size(); // 26.x
                }
            } catch (Throwable t) {
                return -2; // e.g. ConcurrentModificationException while the render thread updates the list
            }
        }
        return -1;
    }

    /**
     * Waits until the client rendered {@code count} more frames. {@code Minecraft.frames} is the per-second fps
     * counter (reset to 0 every second), so changes of its value are counted rather than its absolute growth.
     */
    private void waitFrames(Object mc, int count, long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        java.lang.reflect.Field noRender = ref.field(mc.getClass(), "noRender");
        while (noRender != null && noRender.getBoolean(mc)) {
            if (System.currentTimeMillis() > deadline) {
                throw new ProbeException("timeout", "Rendering could not be enabled in time");
            }
            Thread.sleep(2);
        }
        java.lang.reflect.Field frames = ref.field(mc.getClass(), "frames");
        if (frames == null) {
            Thread.sleep(400);
            return;
        }
        int last = frames.getInt(mc);
        int seen = 0;
        while (seen < count) {
            if (System.currentTimeMillis() > deadline) {
                throw new ProbeException("timeout", "The client did not render frames in time");
            }
            Thread.sleep(2);
            int now = frames.getInt(mc);
            if (now != last) {
                seen++;
                last = now;
            }
        }
    }

    private static File newestPng(File dir, long since) {
        File[] files = dir.listFiles();
        File best = null;
        if (files != null) {
            for (File f : files) {
                if (f.getName().endsWith(".png") && f.lastModified() >= since - 1000 && (best == null || f.lastModified() > best.lastModified())) {
                    best = f;
                }
            }
        }
        return best;
    }
}
