/*
 * TpuWorker -- the UNTRUSTED half of Shielded decode on a phone (TPU.md): the app hosts the phone's TPU for the protected VM.
 *
 * libanchortpu.so (LiteRT C++, built outside this repo: TPU.md) loads the per-block compiled graphs and answers the VM's
 * exchanges on the vsock descriptor the VM API returned. Every row it receives is masked with a one-time pad the VM keeps;
 * the weights it multiplies by are public. Owning this process, or replacing this library, reveals nothing about a prompt.
 */
package host.enclave.anchor.avf;

public final class TpuWorker {
    private TpuWorker() { }
    private static boolean loaded;
    static synchronized boolean available() {
        if (!loaded) try { System.loadLibrary("anchortpu"); loaded = true; } catch (Throwable t) { Main.say("TPU worker library not in this APK: " + t.getMessage()); }
        return loaded;
    }
    static native long nativeOpen(String dispatchDir, String graphsDir, int layers, int rows);
    static native String nativeServe(long handle, int fd);
    static native String nativeBench(long handle);
    static native void nativeClose(long handle);
    /** Microseconds THIS worker handle polls the link before sleeping on it (0 = block). Set on every open, zero included. */
    static native void nativeSetSpin(long handle, int us);
}
