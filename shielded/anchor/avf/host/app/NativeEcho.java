package host.enclave.anchor.avf;

/** Opt-in transport diagnostic. Never selected for the inference bridge. */
final class NativeEcho {
    static { System.loadLibrary("anchor-echo"); }
    static native long run(int fd);
    static native String describe(int fd);
    private NativeEcho() {}
}
