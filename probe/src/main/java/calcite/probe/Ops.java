package calcite.probe;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** The operations the controller can call. Feature classes register theirs once the game is ready. */
final class Ops {

    interface Op {
        Object run(Args args) throws Exception;
    }

    /** An operation without a result; answers {@code true}. */
    interface Action {
        void run(Args args) throws Exception;
    }

    /** Implemented by the classes that contribute operations. */
    interface Module {
        void register(Ops ops);
    }

    private final Map<String, Op> ops = new ConcurrentHashMap<String, Op>();

    void add(String name, Op op) {
        if (ops.put(name, op) != null) {
            throw new IllegalStateException("Operation registered twice: " + name);
        }
    }

    void action(String name, final Action action) {
        add(name, a -> {
            action.run(a);
            return true;
        });
    }

    Op get(String name) {
        return name == null ? null : ops.get(name);
    }
}
