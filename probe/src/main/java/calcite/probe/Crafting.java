package calcite.probe;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Crafting through the recipe book, like a player clicking a recipe: the server places the ingredients from the
 * inventory and the result is shift-clicked out. Uses the 2×2 inventory grid, or a crafting table: the open one,
 * or one within reach that is opened (and closed again) for the purpose.
 */
final class Crafting implements Ops.Module {

    private static final String TABLE_MENU = "minecraft:crafting";
    /** Ticks to wait for the server to fill the grid or open the table. */
    private static final int WAIT_TICKS = 20;

    private enum Phase { OPEN_TABLE, PLACE, WAIT_RESULT, TAKE }

    private final Game game;
    private final Ref ref;
    private final World world;
    private final Menus menus;
    private final Recipes recipes;
    private final Aim aim;
    private final Actions actions;
    private final Controls controls;

    Crafting(Game game, Ref ref, World world, Menus menus, Aim aim, Actions actions, Controls controls) {
        this.game = game;
        this.ref = ref;
        this.world = world;
        this.menus = menus;
        this.recipes = new Recipes(game, ref, menus);
        this.aim = aim;
        this.actions = actions;
        this.controls = controls;
    }

    @Override
    public void register(Ops ops) {
        ops.add("craft", a -> {
            long timeoutMs = a.millis("timeoutMs", 30000);
            Craft craft = new Craft(World.qualify(a.str("item")), Math.max(1, a.integer("count", 1)));
            return controls.run(craft, timeoutMs);
        });
    }

    private final class Craft extends Behavior {
        private final String item;
        private final int count;
        private List<Recipes.Recipe> candidates;
        private int candidate;
        private Phase phase = Phase.PLACE;
        private int phaseStart;
        private int startCount;
        private int crafted;
        private boolean openedTable;
        private int gridSize = 4;

        Craft(String item, int count) {
            super("craft");
            this.item = item;
            this.count = count;
        }

        @Override
        void start(Object mc, Object player) throws Exception {
            candidates = recipes.find(mc, player, item);
            if (candidates.isEmpty()) {
                throw new ProbeException("unknown_recipe", "No known crafting recipe makes " + item
                        + " (recipes unlock when the player first obtains an ingredient)");
            }
            if (menus.containerOpen(player)) {
                if (!TABLE_MENU.equals(menus.menuType(menus.menu(player)))) {
                    throw new ProbeException("container_open", "Close the open container before crafting");
                }
                gridSize = 9;
            } else if (!candidates.get(0).small) {
                int[] table = nearbyTable(mc, player);
                if (table == null) {
                    throw new ProbeException("needs_crafting_table", item + " needs a crafting table; place one or walk within reach of one");
                }
                actions.useBlock(mc, player, table);
                openedTable = true;
                gridSize = 9;
                phase = Phase.OPEN_TABLE;
            } else {
                List<Recipes.Recipe> small = new ArrayList<Recipes.Recipe>();
                for (Recipes.Recipe r : candidates) {
                    if (r.small) {
                        small.add(r);
                    }
                }
                candidates = small;
            }
            startCount = menus.countInInventory(player, item);
        }

        @Override
        void tick(Object mc, Object player) throws Exception {
            int waited = ticks - phaseStart;
            switch (phase) {
                case OPEN_TABLE:
                    if (TABLE_MENU.equals(menus.menuType(menus.menu(player)))) {
                        enter(Phase.PLACE);
                    } else if (waited > WAIT_TICKS) {
                        throw new ProbeException("no_menu", "The crafting table did not open");
                    }
                    break;
                case PLACE:
                    place(mc, player);
                    enter(Phase.WAIT_RESULT);
                    break;
                case WAIT_RESULT:
                    if (item.equals(menus.itemId(menus.slotStack(menus.slots(menus.menu(player)).get(0))))) {
                        menus.click(mc, player, 0, 0, "quick_move");
                        enter(Phase.TAKE);
                    } else if (waited > WAIT_TICKS) {
                        nextRecipe(mc, player);
                    }
                    break;
                case TAKE:
                    int total = menus.countInInventory(player, item) - startCount;
                    if (total <= crafted) {
                        finishWith(player, "inventory_full");
                        break;
                    }
                    crafted = total;
                    if (crafted >= count) {
                        finish(progress(player));
                    } else {
                        enter(Phase.PLACE);
                    }
                    break;
            }
        }

        private void enter(Phase next) {
            phase = next;
            phaseStart = ticks;
        }

        /** The grid stayed empty: the ingredients are missing for this recipe; tries the next one. */
        private void nextRecipe(Object mc, Object player) throws Exception {
            clearGrid(mc, player);
            if (++candidate < candidates.size()) {
                enter(Phase.PLACE);
            } else if (crafted > 0) {
                finishWith(player, "missing_ingredients");
            } else {
                throw new ProbeException("missing_ingredients", "The inventory lacks the ingredients for " + item);
            }
        }

        private void place(Object mc, Object player) throws Exception {
            Object gameMode = game.optGet(mc, "gameMode");
            Method m = ref.method(gameMode.getClass(), "handlePlaceRecipe", 3);
            if (m == null) {
                throw new ProbeException("unsupported", "Recipe placement is not available in this version");
            }
            m.invoke(gameMode, game.optGet(menus.menu(player), "containerId"), candidates.get(candidate).handle, false);
        }

        private void finishWith(Object player, String reason) {
            Map<String, Object> out = progress(player);
            out.put("reason", reason);
            finish(out);
        }

        @Override
        void end() throws Exception {
            Object mc = game.minecraft();
            Object player = game.optGet(mc, "player");
            if (player == null) {
                return;
            }
            clearGrid(mc, player);
            if (openedTable && TABLE_MENU.equals(menus.menuType(menus.menu(player)))) {
                ref.callOrFail(player, "closeContainer");
            }
        }

        /** Moves what is left in the grid back into the inventory. */
        private void clearGrid(Object mc, Object player) throws Exception {
            List<?> slots = menus.slots(menus.menu(player));
            for (int i = 1; i <= gridSize && i < slots.size(); i++) {
                if (menus.itemId(menus.slotStack(slots.get(i))) != null) {
                    menus.click(mc, player, i, 0, "quick_move");
                }
            }
        }

        @Override
        Map<String, Object> progress(Object player) {
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("item", item);
            out.put("crafted", crafted);
            out.put("count", count);
            out.put("phase", phase.name().toLowerCase(Locale.ROOT));
            return out;
        }
    }

    /** The nearest crafting table within reach of the player's eyes, or null. */
    private int[] nearbyTable(Object mc, Object player) throws Exception {
        double[] eye = aim.eye(player);
        int r = (int) Math.ceil(Aim.REACH);
        int ex = (int) Math.floor(eye[0]), ey = (int) Math.floor(eye[1]), ez = (int) Math.floor(eye[2]);
        int[] best = null;
        double bestDistance = Aim.REACH * Aim.REACH;
        for (int x = ex - r; x <= ex + r; x++) {
            for (int y = ey - r; y <= ey + r; y++) {
                for (int z = ez - r; z <= ez + r; z++) {
                    double d = Status.distanceSq(eye, new double[]{x + 0.5, y + 0.5, z + 0.5});
                    if (d < bestDistance && "minecraft:crafting_table".equals(world.blockId(world.blockState(mc, new int[]{x, y, z})))) {
                        best = new int[]{x, y, z};
                        bestDistance = d;
                    }
                }
            }
        }
        return best;
    }
}
