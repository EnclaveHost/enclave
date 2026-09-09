package host.enclave.anchor.avf;

import java.io.*;
import java.util.concurrent.atomic.AtomicInteger;

/* PadDirectStream against a fake PADS receiver on pipes: what reaches the VM, what the app marks accepted, and that no
 * outcome but ACCEPTED/ALREADY ever accepts. Prints {"status","executed_checks"}. */
public final class PadDirectStreamTest {
    static int checks = 0, failed = 0;
    static void check(boolean c, String what) { checks++; if (!c) { failed++; System.err.println("FAIL " + what); } }
    static final String NAME = "0123456789abcdef0123456789abcdef-0-64.pads";
    static PadDelivery.Session session() throws IOException { PadDelivery.Session s = PadDelivery.begin(); s.bind("http://127.0.0.1:1", "0123456789abcdef0123456789abcdef"); return s; }
    /** A counting body: `have` bytes available, then EOF. */
    static final class Body extends ByteArrayInputStream { final AtomicInteger read = new AtomicInteger(); Body(byte[] b) { super(b); }
        @Override public int read(byte[] d, int o, int n) { int r = super.read(d, o, n); if (r > 0) read.addAndGet(r); return r; } @Override public int read() { int r = super.read(); if (r >= 0) read.incrementAndGet(); return r; } }
    /** The fake receiver on a loopback socket pair (a tracked close from another thread wakes a blocked read, exactly like the
     *  app's vsock descriptor): answers `go` to the header ('\0' = never answer), consumes up to `take` body bytes, then writes
     *  `ack` ("" = close silently, "\0" = stay silent without closing). */
    static final class Vm implements Runnable {
        final java.net.ServerSocket ss; final java.net.Socket app; final OutputStream appOut; final InputStream appIn;
        final char go; final long take; final String ack; final ByteArrayOutputStream got = new ByteArrayOutputStream(); volatile String header = ""; volatile boolean done;
        Vm(char go, long take, String ack) throws IOException {
            this.go = go; this.take = take; this.ack = ack;
            ss = new java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress());
            app = new java.net.Socket(java.net.InetAddress.getLoopbackAddress(), ss.getLocalPort());
            appOut = app.getOutputStream(); appIn = app.getInputStream();
        }
        public void run() {
            try (java.net.Socket vm = ss.accept()) {
                ss.close();
                InputStream fromApp = vm.getInputStream(); OutputStream toApp = vm.getOutputStream();
                StringBuilder h = new StringBuilder(); int c; while ((c = fromApp.read()) >= 0 && c != '\n') h.append((char) c); header = h.toString();
                if (go == '\0') { while (fromApp.read() >= 0) { } return; }   /* silent receiver: never answers; leaves when the app's side is closed */
                toApp.write(go); toApp.flush();
                if (go == 'G') { byte[] b = new byte[65536]; long n = 0; while (n < take) { int r = fromApp.read(b, 0, (int) Math.min(b.length, take - n)); if (r < 0) break; got.write(b, 0, r); n += r; }
                                 if (ack.equals("\0")) { while (fromApp.read() >= 0) { } return; }   /* took every byte, never acknowledges, keeps the connection */
                                 if (!ack.isEmpty()) { toApp.write(ack.charAt(0)); toApp.flush(); } }
            } catch (IOException ignored) { }
            finally { done = true; }
        }
    }
    static PadDirectStream.Outcome run(Vm vm, PadDelivery.Session s, String name, long bytes, long clen, InputStream body) throws Exception {
        Thread t = new Thread(vm, "fake-vm"); t.setDaemon(true); t.start();
        PadDirectStream.Outcome o = PadDirectStream.stream(s, name, bytes, clen, body, vm.appOut, vm.appIn);
        try { vm.app.close(); } catch (IOException ignored) { }
        joined(t); return o;
    }
    /** A bounded join that FAILS the run if the thread is still alive: a silent hang is never reported as a pass. */
    static void joined(Thread t) throws InterruptedException { t.join(5000); if (t.isAlive()) throw new AssertionError("test thread still alive after 5 s: " + t.getName()); }
    static PadDirectStream.Outcome runSilent(Vm vm, PadDelivery.Session s, String name, long bytes, long clen, InputStream body) throws Exception { return run(vm, s, name, bytes, clen, body); }
    static byte[] bytes(int n) { byte[] b = new byte[n]; for (int i = 0; i < n; i++) b[i] = (byte) (i * 7 + 3); return b; }
    public static void main(String[] a) throws Exception {
        final int N = 3 * 1024 * 1024 + 12345;
        { PadDelivery.Session s = session(); byte[] data = bytes(N); Body body = new Body(data); Vm vm = new Vm('G', N, "K");
          PadDirectStream.Outcome o = run(vm, s, NAME, N, N, body);
          check(o == PadDirectStream.Outcome.ACCEPTED, "G+K: accepted outcome " + o); check(s.accepted(NAME), "G+K: session accepted");
          check(vm.header.equals("PADS " + NAME + " " + N), "G+K: header " + vm.header); check(java.util.Arrays.equals(vm.got.toByteArray(), data), "G+K: VM received the exact bytes"); check(body.read.get() == N, "G+K: body read exactly once"); s.close(); }
        { PadDelivery.Session s = session(); Body body = new Body(bytes(N)); Vm vm = new Vm('H', 0, "");
          PadDirectStream.Outcome o = run(vm, s, NAME, N, N, body);
          check(o == PadDirectStream.Outcome.ALREADY && s.accepted(NAME), "H: already + accepted " + o); check(body.read.get() == 0, "H: body never read"); check(vm.got.size() == 0, "H: nothing sent"); s.close(); }
        { PadDelivery.Session s = session(); Body body = new Body(bytes(N)); Vm vm = new Vm('E', 0, "");
          PadDirectStream.Outcome o = run(vm, s, NAME, N, N, body);
          check(o == PadDirectStream.Outcome.REFUSED_HEADER && !s.accepted(NAME), "E: refused, not accepted " + o); check(body.read.get() == 0 && vm.got.size() == 0, "E: zero body bytes read or sent"); s.close(); }
        { PadDelivery.Session s = session(); Body body = new Body(bytes(N - 1000)); Vm vm = new Vm('G', N, "K");
          PadDirectStream.Outcome o = run(vm, s, NAME, N, -1, body);
          check(o == PadDirectStream.Outcome.SHORT_BODY && !s.accepted(NAME), "short body: not accepted " + o); check(vm.got.size() == N - 1000, "short body: VM saw the partial stream (refused there)"); s.close(); }
        { PadDelivery.Session s = session(); Body body = new Body(bytes(N + 1)); Vm vm = new Vm('G', N, "K");
          PadDirectStream.Outcome o = run(vm, s, NAME, N, -1, body);
          check(o == PadDirectStream.Outcome.OVERSIZED_BODY && !s.accepted(NAME), "oversize body: not accepted " + o); check(vm.got.size() == N, "oversize: VM received exactly N"); s.close(); }
        { PadDelivery.Session s = session(); Body body = new Body(bytes(N)); Vm vm = new Vm('G', N, "K");
          PadDirectStream.Outcome o = run(vm, s, NAME, N, N + 7, body);
          check(o == PadDirectStream.Outcome.LENGTH_MISMATCH && !s.accepted(NAME), "content-length mismatch: refused before the header " + o); check(vm.header.isEmpty() && body.read.get() == 0, "mismatch: nothing sent, nothing read"); s.close(); }
        { PadDelivery.Session s = session(); Body body = new Body(bytes(N)); Vm vm = new Vm('G', N, "");
          PadDirectStream.Outcome o = run(vm, s, NAME, N, N, body);
          check(o == PadDirectStream.Outcome.NO_ACK && !s.accepted(NAME), "silent VM: no ack, not accepted " + o); check(vm.got.size() == N, "silent VM: it did receive the bytes"); s.close(); }
        { PadDelivery.Session s = session(); Body body = new Body(bytes(N)); Vm vm = new Vm('G', N, "E");
          PadDirectStream.Outcome o = run(vm, s, NAME, N, N, body);
          check(o == PadDirectStream.Outcome.NO_ACK && !s.accepted(NAME), "VM refused after the bytes: not accepted " + o); s.close(); }
        { PadDelivery.Session s = session(); final byte[] data = bytes(N);
          InputStream slow = new InputStream() { int at = 0; @Override public int read() throws IOException { return read(new byte[1], 0, 1) < 0 ? -1 : 0; }
              @Override public int read(byte[] d, int o, int n) throws IOException { if (at >= N / 2) { s.close(); } if (at >= data.length) return -1; int k = Math.min(n, Math.min(65536, data.length - at)); System.arraycopy(data, at, d, o, k); at += k; return k; } };
          Vm vm = new Vm('G', N, "K");
          PadDirectStream.Outcome o = run(vm, s, NAME, N, N, slow);
          check(o == PadDirectStream.Outcome.SESSION_ENDED && !s.accepted(NAME), "session closed mid-copy: ended, not accepted " + o); check(vm.got.size() < N, "session closed mid-copy: partial stream"); }
        { PadDelivery.Session s = session(); Body body = new Body(bytes(N)); Vm vm = new Vm('G', N, "K");
          check(PadDirectStream.stream(s, "not-a-shipment.pads", N, N, body, vm.appOut, vm.appIn) == PadDirectStream.Outcome.SESSION_ENDED, "foreign name refused before any I/O"); check(body.read.get() == 0, "foreign name: nothing read"); s.close(); }
        { check(PadDirectStream.stream(null, NAME, 1, 1, new Body(new byte[1]), new ByteArrayOutputStream(), new ByteArrayInputStream(new byte[0])) == PadDirectStream.Outcome.IO_ERROR, "null session"); 
          PadDelivery.Session s = session(); check(PadDirectStream.stream(s, NAME, 0, 0, new Body(new byte[0]), new ByteArrayOutputStream(), new ByteArrayInputStream(new byte[0])) == PadDirectStream.Outcome.IO_ERROR && !s.accepted(NAME), "zero bytes"); s.close(); }
        /* cancellation while WAITING for G: the receiver never answers; the session's tracked descriptor is closed by another thread
         * (what the app's cancel path does), the blocked read returns, outcome SESSION_ENDED, nothing accepted; bounded by a 5 s join */
        { PadDelivery.Session s = session(); Body body = new Body(bytes(N)); Vm vm = new Vm('\0', 0, "");   /* '\0' = never answer */
          s.track(vm.app);
          Thread closer = new Thread(() -> { try { Thread.sleep(300); } catch (InterruptedException ignored) { } s.close(); }, "canceller"); closer.start();
          PadDirectStream.Outcome o = runSilent(vm, s, NAME, N, N, body); joined(closer);
          check(o == PadDirectStream.Outcome.SESSION_ENDED && !s.accepted(NAME), "cancel while waiting for G: ended, not accepted " + o); check(body.read.get() == 0, "cancel at G: no body sent"); }
        /* cancellation while WAITING for K: the receiver took every byte and stays silent; the tracked close ends the wait */
        { PadDelivery.Session s = session(); Body body = new Body(bytes(N)); Vm vm = new Vm('G', N, "\0");   /* "\0" = consume, then never ack */
          s.track(vm.app);
          Thread closer = new Thread(() -> { try { Thread.sleep(400); } catch (InterruptedException ignored) { } s.close(); }, "canceller"); closer.start();
          PadDirectStream.Outcome o = runSilent(vm, s, NAME, N, N, body); joined(closer);
          check(o == PadDirectStream.Outcome.SESSION_ENDED && !s.accepted(NAME), "cancel while waiting for K: ended, not accepted " + o); check(vm.got.size() == N, "cancel at K: the VM had received every byte (it will refuse or judge on its own)"); }
        System.out.println("{\"status\":\"" + (failed == 0 ? "PASS" : "FAIL") + "\",\"executed_checks\":" + checks + "}");
        System.exit(failed == 0 ? 0 : 1);
    }
}
