/*
 * LocalBridge -- the marketplace host's loopback doors into the VM (PVM-CPU.md "Serving buyers").
 *
 * While the VM serves an app with its CA-trustable key (APP ... serve=https-p256), the owner's host on the other end of the
 * USB cable (`adb forward`) reaches two VM ports through 127.0.0.1 on this phone:
 *   - the TLS app port (vsock 7786): the bytes a buyer's browser sends through TUNA. They are TLS end to end -- the key is
 *     in the VM -- so this app copies ciphertext and never parses or keeps it. Open to anything on loopback: the app is
 *     public anyway.
 *   - the evidence endpoint (vsock 7787): evidence, the lease proof key's checkpoints, the TLS key's request and chain. A
 *     checkpoint's `upto` only ever increases for a boot, so another app on this phone could spend that sequence; the
 *     first line on this door must therefore be "AUTH <token>", a random token written to this app's own external files
 *     directory, which other apps cannot read and the owner's host reads over adb. Everything after it is copied as is.
 * Both are bound to 127.0.0.1 only, at most 32 connections each, and closed when the VM's session ends. Sizes are logged,
 * never bytes.
 */
package host.enclave.anchor.avf;

import android.os.ParcelFileDescriptor;

import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.atomic.AtomicInteger;

public final class LocalBridge {
    static final int MAX_CONNS = 32;
    final Object vm; final int localPort, vmPort; final String token; final String label;
    private ServerSocket ss; private volatile boolean closed;
    private final AtomicInteger open = new AtomicInteger();

    LocalBridge(Object vm, int localPort, int vmPort, String token, String label) {
        this.vm = vm; this.localPort = localPort; this.vmPort = vmPort; this.token = token; this.label = label;
    }

    /** A fresh random token (32 bytes, hex), written to <external files>/bridge-token for the owner's host to read over adb. */
    static String writeToken(android.content.Context ctx) {
        final byte[] b = new byte[32]; new java.security.SecureRandom().nextBytes(b);
        final String t = RelayAttach.hex(b);
        try {
            final java.io.File dir = ctx.getExternalFilesDir(null);
            if (dir == null) return null;
            final String name = "bridge-token" + Main.slotSuffix();   /* each slot's own door */
            final java.io.File f = new java.io.File(dir, name), tmp = new java.io.File(dir, name + ".tmp");
            try (FileOutputStream o = new FileOutputStream(tmp)) { o.write((t + "\n").getBytes("US-ASCII")); o.getFD().sync(); }
            if (!tmp.renameTo(f)) return null;
            Main.say("BRIDGE token written to " + f + " (the owner's host reads it over adb; other apps cannot)");
            return t;
        } catch (Exception e) { Main.say("BRIDGE token not written: " + e); return null; }
    }

    boolean start() {
        try {
            ss = new ServerSocket(localPort, 16, InetAddress.getByName("127.0.0.1"));
            new Thread(this::accept, "bridge-" + label).start();
            Main.say("BRIDGE " + label + ": 127.0.0.1:" + localPort + " -> the VM's vsock " + vmPort + (token != null ? " (AUTH <token> first)" : ""));
            return true;
        } catch (Exception e) { Main.say("BRIDGE " + label + " NOT started on 127.0.0.1:" + localPort + ": " + e); return false; }
    }

    void close() { closed = true; try { if (ss != null) ss.close(); } catch (Exception ignored) { } }

    private void accept() {
        while (!closed) {
            final Socket s;
            try { s = ss.accept(); } catch (Exception e) { if (!closed) Main.say("BRIDGE " + label + " accept ended: " + e); return; }
            if (open.incrementAndGet() > MAX_CONNS) { open.decrementAndGet(); try { s.close(); } catch (Exception ignored) { } continue; }
            new Thread(() -> { try { pipe(s); } finally { open.decrementAndGet(); } }, "bridge-" + label + "-conn").start();
        }
    }

    /** One loopback connection to one VM connection, both directions, until either side closes. */
    private void pipe(Socket s) {
        ParcelFileDescriptor pfd = null;
        try {
            s.setTcpNoDelay(true);
            final InputStream fromLocal = s.getInputStream(); final OutputStream toLocal = s.getOutputStream();
            if (token != null) {   // the first line, read byte by byte so nothing after it is consumed: AUTH <token>
                s.setSoTimeout(5000);
                final StringBuilder l = new StringBuilder(); int c;
                while ((c = fromLocal.read()) >= 0 && c != '\n' && l.length() < 100) l.append((char) c);
                if (!MessageDigestEq.eq(l.toString(), "AUTH " + token)) { toLocal.write("{\"error\":\"bridge: AUTH <token> first\"}\n".getBytes("US-ASCII")); return; }
                s.setSoTimeout(0);
            }
            pfd = Main.connect(vm, vmPort, 25);
            if (pfd == null) { toLocal.write(token != null ? "{\"error\":\"bridge: the VM's port did not answer\"}\n".getBytes("US-ASCII") : new byte[0]); return; }
            final ParcelFileDescriptor p = pfd;
            final OutputStream toVm = new FileOutputStream(p.getFileDescriptor()); final InputStream fromVm = new FileInputStream(p.getFileDescriptor());
            final Thread up = new Thread(() -> { final byte[] b = new byte[1 << 16]; int n;
                try { while ((n = fromLocal.read(b)) > 0) { toVm.write(b, 0, n); toVm.flush(); } } catch (Exception ignored) { }
                try { android.system.Os.shutdown(p.getFileDescriptor(), android.system.OsConstants.SHUT_WR); } catch (Exception ignored) { } }, "bridge-" + label + "-up");
            up.start();
            final byte[] b = new byte[1 << 16]; int n;
            try { while ((n = fromVm.read(b)) > 0) toLocal.write(b, 0, n); } catch (Exception ignored) { }
            try { s.shutdownOutput(); } catch (Exception ignored) { }
            up.join(30000);
        } catch (Exception ignored) {
        } finally {
            try { s.close(); } catch (Exception ignored) { }
            if (pfd != null) try { pfd.close(); } catch (Exception ignored) { }
        }
    }

    /** Constant-time string equality for the token. */
    static final class MessageDigestEq {
        static boolean eq(String a, String b) {
            return java.security.MessageDigest.isEqual(a.getBytes(java.nio.charset.StandardCharsets.US_ASCII), b.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        }
    }
}
