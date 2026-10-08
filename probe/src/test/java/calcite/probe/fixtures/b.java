package calcite.probe.fixtures;

/** Test fixture standing in for an obfuscated class ("net.example.Thing"). */
public class b extends a {
    String c = "label!";

    public String d() {
        return "plain";
    }

    public String d(String s) {
        return "str:" + s;
    }

    public String d(a base) {
        return "base:" + base.b();
    }
}
