package calcite.probe;

/** Sends an event to the controller as {@code {"type":"event","name":...,"data":...,"time":...}}. */
public interface EventSink {
    void event(String name, Object data);
}
