package calcite.probe;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

/**
 * The crafting recipes the player knows, from the client's recipe book. Each version stores them differently:
 * {@code Recipe} objects up to 1.20.1, {@code RecipeHolder}s up to 1.21.1 and, from 1.21.2, only display entries
 * of the unlocked recipes. Game thread only.
 */
final class Recipes {

    /** A crafting recipe for an item, in the form {@code handlePlaceRecipe} takes. */
    static final class Recipe {
        final Object handle;
        /** Fits the player's 2×2 inventory grid. */
        final boolean small;

        Recipe(Object handle, boolean small) {
            this.handle = handle;
            this.small = small;
        }
    }

    private final Game game;
    private final Ref ref;
    private final Menus menus;

    Recipes(Game game, Ref ref, Menus menus) {
        this.game = game;
        this.ref = ref;
        this.menus = menus;
    }

    /** Known crafting recipes producing {@code item}, those fitting the 2×2 grid first. */
    List<Recipe> find(Object mc, Object player, String item) throws Exception {
        Object book = game.optCall(player, "getRecipeBook");
        Object collections = game.optCall(book, "getCollections");
        if (!(collections instanceof Iterable)) {
            throw new ProbeException("unsupported", "The recipe book is not available in this version");
        }
        Object level = game.optGet(mc, "level");
        Map<Object, Boolean> seen = new IdentityHashMap<Object, Boolean>();
        List<Recipe> found = new ArrayList<Recipe>();
        for (Object collection : (Iterable<?>) collections) {
            Object recipes = game.optCall(collection, "getRecipes");
            if (!(recipes instanceof Iterable)) {
                continue;
            }
            for (Object entry : (Iterable<?>) recipes) {
                if (seen.put(entry, Boolean.TRUE) == null) {
                    Recipe r = "RecipeDisplayEntry".equals(ref.simpleNamed(entry.getClass()))
                            ? fromDisplay(level, entry, item) : fromRecipe(book, level, entry, item);
                    if (r != null) {
                        found.add(r);
                    }
                }
            }
        }
        Collections.sort(found, (a, b) -> Boolean.compare(b.small, a.small));
        return found;
    }

    /** 1.21.2+: a display entry of an unlocked recipe, placed by its id. */
    private Recipe fromDisplay(Object level, Object entry, String item) throws Exception {
        Object display = game.optCall(entry, "display");
        String kind = display == null ? null : ref.simpleNamed(display.getClass());
        boolean small;
        if ("ShapedCraftingRecipeDisplay".equals(kind)) {
            small = Ref.intValue(game.optCall(display, "width"), 3) <= 2 && Ref.intValue(game.optCall(display, "height"), 3) <= 2;
        } else if ("ShapelessCraftingRecipeDisplay".equals(kind)) {
            small = ((List<?>) game.optCall(display, "ingredients")).size() <= 4;
        } else {
            return null;
        }
        Method context = ref.method(ref.cls("net.minecraft.world.item.crafting.display.SlotDisplayContext"), "fromLevel", 1);
        Method results = ref.method(entry.getClass(), "resultItems", 1);
        List<?> stacks = context == null || results == null ? null : (List<?>) results.invoke(entry, context.invoke(null, level));
        if (stacks == null || stacks.isEmpty() || !item.equals(menus.itemId(stacks.get(0)))) {
            return null;
        }
        return new Recipe(game.optCall(entry, "id"), small);
    }

    /** Up to 1.21.1: a Recipe, or a RecipeHolder wrapping one; the book lists locked recipes too. */
    private Recipe fromRecipe(Object book, Object level, Object entry, String item) throws Exception {
        Object recipe = game.optCall(entry, "value");
        if (recipe == null) {
            recipe = entry;
        }
        Object crafting = ref.getStatic(ref.cls("net.minecraft.world.item.crafting.RecipeType"), "CRAFTING");
        if (game.optCall(recipe, "getType") != crafting || !item.equals(menus.itemId(result(level, recipe))) || !known(book, entry)) {
            return null;
        }
        Method fits = ref.method(recipe.getClass(), "canCraftInDimensions", 2, "int", "int");
        return new Recipe(entry, fits == null || Boolean.TRUE.equals(fits.invoke(recipe, 2, 2)));
    }

    /** getResultItem() before 1.19.4, getResultItem(RegistryAccess) after. */
    private Object result(Object level, Object recipe) throws Exception {
        Object stack = game.optCall(recipe, "getResultItem");
        if (stack == null) {
            Method withAccess = ref.method(recipe.getClass(), "getResultItem", 1);
            stack = withAccess == null ? null : withAccess.invoke(recipe, game.optCall(level, "registryAccess"));
        }
        return stack;
    }

    private boolean known(Object book, Object entry) throws Exception {
        for (String type : new String[]{"net.minecraft.world.item.crafting.RecipeHolder", "net.minecraft.world.item.crafting.Recipe"}) {
            Method contains = ref.method(book.getClass(), "contains", 1, type);
            if (contains != null && contains.getParameterTypes()[0].isInstance(entry)) {
                return Boolean.TRUE.equals(contains.invoke(book, entry));
            }
        }
        return true;
    }
}
