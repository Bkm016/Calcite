package calcite.probe.api;

/** An error with a code, reported to the caller as {@code [code] message}. */
public class CalciteException extends RuntimeException {

    private final String code;

    public CalciteException(String code, String message) {
        super(message);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
