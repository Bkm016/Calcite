package calcite.probe.nav;

import java.util.Collections;
import java.util.List;

/** The result of a search: block positions to walk through, starting at the player's own. */
public final class Path {

    /** One block space of the path. */
    public static final class Step {
        public final int x;
        public final int y;
        public final int z;
        /** Height the player stands at. */
        public final double floor;
        /** Reaching this step from the previous one needs a jump. */
        public final boolean jump;
        public final boolean swim;

        Step(int x, int y, int z, double floor, boolean jump, boolean swim) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.floor = floor;
            this.jump = jump;
            this.swim = swim;
        }

        @Override
        public String toString() {
            return x + " " + y + " " + z + (jump ? " jump" : "") + (swim ? " swim" : "");
        }
    }

    public final List<Step> steps;
    /** False when the search ran out of budget or options and the path only gets closer to the goal. */
    public final boolean complete;

    Path(List<Step> steps, boolean complete) {
        this.steps = Collections.unmodifiableList(steps);
        this.complete = complete;
    }

    /** True when the path does not get the player anywhere. */
    public boolean isEmpty() {
        return steps.size() < 2;
    }
}
