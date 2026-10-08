package calcite.probe;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** Typed access to the JSON arguments of a request; missing required values fail with {@code bad_request}. */
final class Args {

    private final Map<String, Object> map;

    Args(Map<String, Object> map) {
        this.map = map == null ? Collections.<String, Object>emptyMap() : map;
    }

    Map<String, Object> raw() {
        return map;
    }

    boolean has(String key) {
        return map.get(key) != null;
    }

    String str(String key) {
        Object v = map.get(key);
        if (!(v instanceof String)) {
            throw bad("Missing string argument: " + key);
        }
        return (String) v;
    }

    String str(String key, String def) {
        Object v = map.get(key);
        return v instanceof String ? (String) v : def;
    }

    double num(String key) {
        Double v = optNum(key);
        if (v == null) {
            throw bad("Missing number argument: " + key);
        }
        return v;
    }

    double num(String key, double def) {
        Double v = optNum(key);
        return v == null ? def : v;
    }

    Double optNum(String key) {
        Object v = map.get(key);
        return v instanceof Number ? ((Number) v).doubleValue() : null;
    }

    int integer(String key, int def) {
        Object v = map.get(key);
        return v instanceof Number ? ((Number) v).intValue() : def;
    }

    Integer optInt(String key) {
        Object v = map.get(key);
        return v instanceof Number ? ((Number) v).intValue() : null;
    }

    long millis(String key, long def) {
        Object v = map.get(key);
        return v instanceof Number ? ((Number) v).longValue() : def;
    }

    /** A boolean argument; anything but a JSON boolean counts as {@code def}. */
    boolean flag(String key, boolean def) {
        Object v = map.get(key);
        return v instanceof Boolean ? (Boolean) v : def;
    }

    /** Block coordinates {@code x}, {@code y}, {@code z} (floored). */
    int[] blockPos() {
        return new int[]{floor(num("x")), floor(num("y")), floor(num("z"))};
    }

    /** Block coordinates when {@code x} is present, else null. */
    int[] optBlockPos() {
        return has("x") ? blockPos() : null;
    }

    @SuppressWarnings("unchecked")
    Map<String, Object> map(String key) {
        Object v = map.get(key);
        return v instanceof Map ? (Map<String, Object>) v : Collections.<String, Object>emptyMap();
    }

    /** A string or a list of strings. */
    List<String> strings(String key) {
        Object v = map.get(key);
        List<String> out = new ArrayList<String>();
        if (v instanceof String) {
            out.add((String) v);
        } else if (v instanceof List) {
            for (Object o : (List<?>) v) {
                if (o instanceof String) {
                    out.add((String) o);
                }
            }
        }
        if (out.isEmpty()) {
            throw bad("Missing string or string list argument: " + key);
        }
        return out;
    }

    private static int floor(double v) {
        return (int) Math.floor(v);
    }

    private static ProbeException bad(String message) {
        return new ProbeException("bad_request", message);
    }
}
