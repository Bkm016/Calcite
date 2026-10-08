package calcite.probe.nav;

/** Where a path should end: within {@code range} blocks of (x, z), and within a block of {@code y} when it is set. */
public final class Goal {

    public final double x;
    /** Feet height to reach, or NaN for any. */
    public final double y;
    public final double z;
    public final double range;

    public Goal(double x, double y, double z, double range) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.range = range;
    }

    boolean reached(int bx, double floor, int bz) {
        return horizontal(bx, bz) <= range && (Double.isNaN(y) || Math.abs(floor - y) <= 1);
    }

    /** Lower bound of the remaining path cost (A* heuristic). */
    double estimate(int bx, double floor, int bz) {
        double h = Math.max(0, horizontal(bx, bz) - range);
        double v = Double.isNaN(y) ? 0 : Math.max(0, Math.abs(floor - y) - 1);
        return Math.sqrt(h * h + v * v);
    }

    private double horizontal(int bx, int bz) {
        double dx = bx + 0.5 - x, dz = bz + 0.5 - z;
        return Math.sqrt(dx * dx + dz * dz);
    }
}
