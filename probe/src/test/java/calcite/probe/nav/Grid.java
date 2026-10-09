package calcite.probe.nav;

/**
 * A small hand-drawn world: layers from y = 1 upwards, each a '/'-separated list of rows (z) of columns (x).
 * {@code #} is a full block, {@code _} a bottom slab, {@code ~} water, {@code !} lava, anything else air.
 * Below y = 1 is solid ground; outside the drawing is not loaded.
 */
public final class Grid implements Terrain {
    private final String[][] layers;

    public Grid(String... layers) {
        this.layers = new String[layers.length][];
        for (int i = 0; i < layers.length; i++) {
            this.layers[i] = layers[i].split("/");
        }
    }

    @Override
    public Cell cell(int x, int y, int z) {
        String[] rows = layers[0];
        if (z < 0 || z >= rows.length || x < 0 || x >= rows[z].length()) {
            return Cell.UNLOADED;
        }
        if (y < 1) {
            return Cell.FULL;
        }
        if (y > layers.length) {
            return Cell.OPEN;
        }
        switch (layers[y - 1][z].charAt(x)) {
            case '#':
                return Cell.FULL;
            case '_':
                return Cell.solid(0.5);
            case '~':
                return Cell.WATER;
            case '!':
                return Cell.DANGER;
            default:
                return Cell.OPEN;
        }
    }
}
