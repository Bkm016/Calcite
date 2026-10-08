package calcite.probe;

import java.lang.reflect.InvocationTargetException;
import java.util.concurrent.ExecutionException;

import calcite.probe.api.CalciteException;

/** A failure reported to the controller as {@code {"ok":false,"code":...,"error":...}}. */
public final class ProbeException extends CalciteException {

    public ProbeException(String code, String message) {
        super(code, message);
    }

    /** The exception behind reflection and future wrappers, as something a {@code throws Exception} method can throw. */
    public static Exception unwrap(Throwable t) {
        Throwable cause = t;
        while ((cause instanceof InvocationTargetException || cause instanceof ExecutionException) && cause.getCause() != null) {
            cause = cause.getCause();
        }
        return cause instanceof Exception ? (Exception) cause : new RuntimeException(cause);
    }
}
