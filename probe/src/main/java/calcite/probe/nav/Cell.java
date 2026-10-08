package calcite.probe.nav;

/** What one block space means for a walking player. Instances are shared; compare kinds, not identities. */
public final class Cell {

    public enum Kind {
        /** No collision: air, grass, flowers, open trapdoors... */
        OPEN,
        WATER,
        /** Has a collision box; {@link #height} is its top (0-1.5). */
        SOLID,
        /** Hurts or traps: lava, fire, cactus, magma, cobwebs, sweet berry bushes, powder snow... */
        DANGER,
        /** Not loaded, or outside the world. */
        UNLOADED
    }

    public static final Cell OPEN = new Cell(Kind.OPEN, 0);
    public static final Cell WATER = new Cell(Kind.WATER, 0);
    public static final Cell DANGER = new Cell(Kind.DANGER, 0);
    public static final Cell UNLOADED = new Cell(Kind.UNLOADED, 0);
    public static final Cell FULL = solid(1);

    public final Kind kind;
    public final double height;

    private Cell(Kind kind, double height) {
        this.kind = kind;
        this.height = height;
    }

    /** A block with a collision box whose top is {@code height} above its bottom. */
    public static Cell solid(double height) {
        return new Cell(Kind.SOLID, height);
    }

    /** A player's body can be in this space. */
    public boolean clear() {
        return kind == Kind.OPEN || kind == Kind.WATER;
    }

    public boolean solid() {
        return kind == Kind.SOLID;
    }

    @Override
    public String toString() {
        return kind == Kind.SOLID ? "SOLID(" + height + ")" : kind.name();
    }
}
