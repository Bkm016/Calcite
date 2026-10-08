package calcite.probe.nav;

/** Block spaces as the path finder sees them. */
public interface Terrain {

    Cell cell(int x, int y, int z);

    /**
     * Height of the floor a player standing with feet in block (x, y, z) stands on, or NaN when a player cannot
     * stand there. Swimming counts as standing (the floor is the water block itself).
     */
    static double floor(Terrain t, int x, int y, int z) {
        if (!t.cell(x, y + 1, z).clear()) {
            return Double.NaN;
        }
        Cell feet = t.cell(x, y, z);
        switch (feet.kind) {
            case WATER:
                return y;
            case SOLID:
                // slabs, carpets, snow layers: the player stands inside the block space, on top of it
                if (feet.height > 0.5 || feet.height > 0.2 && !t.cell(x, y + 2, z).clear()) {
                    return Double.NaN;
                }
                return y + feet.height;
            case OPEN:
                Cell below = t.cell(x, y - 1, z);
                // lower blocks put the player into the space below; fences and walls cannot be stood on
                return below.solid() && below.height > 0.5 && below.height <= 1 ? y - 1 + below.height : Double.NaN;
            default:
                return Double.NaN;
        }
    }
}
