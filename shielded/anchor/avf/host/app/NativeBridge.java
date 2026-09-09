package host.enclave.anchor.avf;

/* Opt-in native worker bridge (--ez nativebridge true): one native thread pumps the guest's vsock and
 * the worker's TCP socket both ways with bounded buffers (host/native-bridge.c). Java keeps ownership
 * of every descriptor: it closes them after run() returns. cancelFd is one end of a socketpair; a
 * byte written to the other end ends the run with -ECANCELED. stats[0..5] = bytes a->b, bytes b->a,
 * reads, writes, polls, largest read. Returns 0 (both sides EOF), -ECANCELED, -ETIMEDOUT or -errno. */
final class NativeBridge {
    static { System.loadLibrary("anchor-bridge"); }
    static native int run(int aFd, int bFd, int cancelFd, int idleMs, boolean profile, int guestWriteMax, long[] stats);
}
