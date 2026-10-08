package calcite.probe;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import calcite.probe.Game.ProbeException;

/**
 * Reflection by official (Mojang) names, resolved through {@link Mappings}.
 * Lookups walk the runtime class hierarchy, so members declared in super classes/interfaces are found.
 * Results (including misses) are cached.
 */
public final class Ref {

    private static final Object MISS = new Object();

    private final Mappings mappings;
    private final ClassLoader loader;
    private final Map<String, Object> cache = new ConcurrentHashMap<String, Object>();

    public Ref(Mappings mappings, ClassLoader loader) {
        this.mappings = mappings;
        this.loader = loader;
    }

    public Mappings mappings() {
        return mappings;
    }

    /** Loads a class by official name; returns null when missing. */
    public Class<?> cls(String named) {
        String key = "c:" + named;
        Object hit = cache.get(key);
        if (hit != null) {
            return hit == MISS ? null : (Class<?>) hit;
        }
        Class<?> result = null;
        String runtime = mappings.runtimeClass(named);
        if (runtime != null) {
            try {
                result = Class.forName(runtime, false, loader);
            } catch (Throwable ignored) {
                // not present in this version
            }
        }
        cache.put(key, result == null ? MISS : result);
        return result;
    }

    /** First class that exists among the official names. */
    public Class<?> cls(String... candidates) {
        for (String c : candidates) {
            Class<?> k = cls(c);
            if (k != null) {
                return k;
            }
        }
        return null;
    }

    /** Official name of a runtime class (falls back to the runtime name). */
    public String named(Class<?> k) {
        return mappings.namedClass(k.getName());
    }

    /** Simple official name, e.g. "DisconnectedScreen". */
    public String simpleNamed(Class<?> k) {
        String n = named(k);
        int dot = n.lastIndexOf('.');
        n = dot < 0 ? n : n.substring(dot + 1);
        int dollar = n.lastIndexOf('$');
        return dollar < 0 ? n : n.substring(dollar + 1);
    }

    /** Field by official name, searched through the hierarchy of {@code owner}. */
    public Field field(Class<?> owner, String name) {
        String key = "f:" + owner.getName() + "#" + name;
        Object hit = cache.get(key);
        if (hit != null) {
            return hit == MISS ? null : (Field) hit;
        }
        Field result = null;
        for (Class<?> k = owner; k != null && result == null; k = k.getSuperclass()) {
            String runtimeName = runtimeFieldName(k, name);
            if (runtimeName == null) {
                continue;
            }
            try {
                Field f = k.getDeclaredField(runtimeName);
                f.setAccessible(true);
                result = f;
            } catch (Throwable ignored) {
                // keep searching
            }
        }
        cache.put(key, result == null ? MISS : result);
        return result;
    }

    private String runtimeFieldName(Class<?> k, String name) {
        if (mappings.isIdentity()) {
            return name;
        }
        Mappings.ClassEntry e = mappings.byRuntime(k.getName());
        return e == null ? null : e.field(name);
    }

    /**
     * Method by official name and parameter count, searched through the hierarchy of {@code owner}.
     * {@code paramTypes} (official names, optional) disambiguates overloads.
     */
    public Method method(Class<?> owner, String name, int paramCount, String... paramTypes) {
        StringBuilder key = new StringBuilder("m:").append(owner.getName()).append('#').append(name).append('/').append(paramCount);
        for (String p : paramTypes) {
            key.append(',').append(p);
        }
        Object hit = cache.get(key.toString());
        if (hit != null) {
            return hit == MISS ? null : (Method) hit;
        }
        Method result = findMethod(owner, name, paramCount, paramTypes);
        cache.put(key.toString(), result == null ? MISS : result);
        return result;
    }

    private Method findMethod(Class<?> owner, String name, int paramCount, String[] wanted) {
        Deque<Class<?>> queue = new ArrayDeque<Class<?>>();
        Set<Class<?>> seen = new HashSet<Class<?>>();
        queue.add(owner);
        while (!queue.isEmpty()) {
            Class<?> k = queue.poll();
            if (!seen.add(k)) {
                continue;
            }
            Method m = findDeclared(k, name, paramCount, wanted);
            if (m != null) {
                return m;
            }
            if (k.getSuperclass() != null) {
                queue.add(k.getSuperclass());
            }
            for (Class<?> i : k.getInterfaces()) {
                queue.add(i);
            }
        }
        return null;
    }

    private Method findDeclared(Class<?> k, String name, int paramCount, String[] wanted) {
        Method[] declared;
        try {
            declared = k.getDeclaredMethods();
        } catch (Throwable t) {
            return null;
        }
        if (mappings.isIdentity() || !isMinecraftClass(k)) {
            // official names at runtime (unobfuscated game, or JDK/library types)
            for (Method m : declared) {
                if (m.getName().equals(name) && m.getParameterTypes().length == paramCount && paramsMatch(m, wanted, null)) {
                    m.setAccessible(true);
                    return m;
                }
            }
            return null;
        }
        Mappings.ClassEntry e = mappings.byRuntime(k.getName());
        if (e == null) {
            return null;
        }
        List<Mappings.MethodEntry> entries = e.methods(name);
        for (Mappings.MethodEntry entry : entries) {
            if (entry.paramTypes.length != paramCount || !namedParamsMatch(entry.paramTypes, wanted)) {
                continue;
            }
            for (Method m : declared) {
                if (m.getName().equals(entry.runtimeName) && m.getParameterTypes().length == paramCount
                        && paramsMatch(m, null, entry.paramTypes)) {
                    m.setAccessible(true);
                    return m;
                }
            }
        }
        return null;
    }

    private boolean isMinecraftClass(Class<?> k) {
        return mappings.byRuntime(k.getName()) != null;
    }

    private static boolean namedParamsMatch(String[] actual, String[] wanted) {
        if (wanted == null || wanted.length == 0) {
            return true;
        }
        for (int i = 0; i < wanted.length && i < actual.length; i++) {
            if (wanted[i] != null && !wanted[i].equals(actual[i])) {
                return false;
            }
        }
        return true;
    }

    /** Compares runtime parameter types against official names (wanted) or mapped official names (named). */
    private boolean paramsMatch(Method m, String[] wanted, String[] named) {
        Class<?>[] types = m.getParameterTypes();
        String[] expect = named != null ? named : wanted;
        if (expect == null || expect.length == 0) {
            return true;
        }
        for (int i = 0; i < expect.length && i < types.length; i++) {
            if (expect[i] == null) {
                continue;
            }
            String runtime = mappings.runtimeType(expect[i]);
            if (!runtime.equals(typeName(types[i]))) {
                return false;
            }
        }
        return true;
    }

    private static String typeName(Class<?> k) {
        if (k.isArray()) {
            return typeName(k.getComponentType()) + "[]";
        }
        return k.getName();
    }

    // ---- invocation helpers ----

    public Object get(Object target, String name) throws ReflectiveOperationException {
        if (target == null) {
            return null;
        }
        Field f = field(target instanceof Class ? (Class<?>) target : target.getClass(), name);
        if (f == null) {
            throw new NoSuchFieldException(name);
        }
        return f.get(Modifier.isStatic(f.getModifiers()) ? null : target);
    }

    public Object getStatic(Class<?> owner, String name) throws ReflectiveOperationException {
        Field f = field(owner, name);
        if (f == null) {
            throw new NoSuchFieldException(name);
        }
        return f.get(null);
    }

    public void set(Object target, String name, Object value) throws ReflectiveOperationException {
        Field f = field(target.getClass(), name);
        if (f == null) {
            throw new NoSuchFieldException(name);
        }
        f.set(target, value);
    }

    public Object call(Object target, String name, Object... args) throws ReflectiveOperationException {
        Method m = method(target.getClass(), name, args.length);
        if (m == null) {
            throw new NoSuchMethodException(target.getClass().getName() + "#" + name + "/" + args.length);
        }
        return m.invoke(target, args);
    }

    /** True when {@code target} has a method with that official name and parameter count. */
    public boolean has(Object target, String name, int paramCount) {
        return target != null && method(target.getClass(), name, paramCount) != null;
    }

    /** Sets a field when this version has it. */
    public void setIfPresent(Object target, String name, Object value) throws ReflectiveOperationException {
        Field f = field(target.getClass(), name);
        if (f != null) {
            f.set(target, value);
        }
    }

    /** Calls a no-argument method, failing with an "unsupported" error when this version lacks it. */
    public Object callOrFail(Object target, String name) throws Exception {
        Method m = method(target.getClass(), name, 0);
        if (m == null) {
            throw new ProbeException("unsupported", simpleNamed(target.getClass()) + "#" + name + " is not available in this version");
        }
        try {
            return m.invoke(target);
        } catch (java.lang.reflect.InvocationTargetException e) {
            Throwable cause = e.getCause();
            throw cause instanceof Exception ? (Exception) cause : new RuntimeException(cause);
        }
    }

    /** {@code new named(args)}, picking the constructor whose parameters accept the arguments. */
    public Object construct(String named, Object... args) throws Exception {
        Class<?> k = cls(named);
        if (k == null) {
            throw new ProbeException("unsupported", named + " not found");
        }
        for (Constructor<?> c : k.getDeclaredConstructors()) {
            Class<?>[] types = c.getParameterTypes();
            if (types.length != args.length) {
                continue;
            }
            boolean fits = true;
            for (int i = 0; i < types.length && fits; i++) {
                fits = accepts(types[i], args[i]);
            }
            if (fits) {
                c.setAccessible(true);
                return c.newInstance(args);
            }
        }
        throw new ProbeException("unsupported", "No matching constructor for " + named);
    }

    private static boolean accepts(Class<?> type, Object arg) {
        if (!type.isPrimitive()) {
            return arg == null || type.isInstance(arg);
        }
        return (type == int.class && arg instanceof Integer) || (type == double.class && arg instanceof Double)
                || (type == float.class && arg instanceof Float) || (type == boolean.class && arg instanceof Boolean)
                || (type == long.class && arg instanceof Long);
    }

    static int intValue(Object v, int def) {
        return v instanceof Number ? ((Number) v).intValue() : def;
    }
}
