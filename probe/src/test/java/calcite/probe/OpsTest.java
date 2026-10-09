package calcite.probe;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class OpsTest {

    @Test
    void dispatchesRegisteredOps() throws Exception {
        Ops ops = new Ops();
        ops.add("one", a -> 1);
        ops.action("noop", a -> { });
        assertEquals(1, ops.get("one").run(new Args(null)));
        assertEquals(true, ops.get("noop").run(new Args(null)), "actions answer true");
        assertNull(ops.get("missing"));
        assertNull(ops.get(null));
    }

    @Test
    void rejectsDuplicateNames() {
        Ops ops = new Ops();
        ops.add("one", a -> 1);
        assertThrows(IllegalStateException.class, () -> ops.add("one", a -> 2));
    }
}
