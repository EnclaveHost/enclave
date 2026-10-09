/*
 * EgressPool -- the app's way out, the phone's part (PVM-CPU.md "Egress"; the VM's half is the payload's egress_* and
 * runtime/pvm-rt/src/egress.rs, the owner's host agent's is runner/egress.mjs).
 *
 * The VM has no network, and nothing in it can open a connection to this app; so this app keeps IDLE streams open to the
 * VM's egress port (vsock 7788). When the app inside needs out, the VM writes one line on an idle stream -- "CONNECT <host>
 * <port>" or "RESOLVE <name>" -- and this app carries it to the owner's host agent (127.0.0.1:<port>, adb reverse) as
 * "EGRESS <token> <line>", hands the agent's answer line back to the VM, and after an "OK" copies bytes both ways until
 * either side closes. The agent decides everything (the app's own TUNA route, the destination policy, the caps); this app
 * opens nothing but the agent's loopback port, and never parses what flows (an https request's TLS is made in the VM).
 * Each stream taken is replaced by a fresh idle one. Closed with the VM's session. Sizes and verdicts are not logged here
 * (the agent logs refusals); nothing of the traffic is kept.
 */
package host.enclave.anchor.avf;

import android.os.ParcelFileDescriptor;

import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

public final class EgressPool {
    /** idle streams kept open to the VM; at most MAX streams in all (the agent's per-app cap is 96 open connections) */
    static final int IDLE = 4, MAX = 100;
    final Object vm; final int vmPort, agentPort; final String token;
    private volatile boolean closed;
    private final AtomicInteger open = new AtomicInteger();

    EgressPool(Object vm, int vmPort, int agentPort, String token) {
        this.vm = vm; this.vmPort = vmPort; this.agentPort = agentPort; this.token = token;
    }

    void start() {
        for (int i = 0; i < IDLE; i++) spawn();
        Main.say("EGRESS: " + IDLE + " idle streams to the VM's vsock " + vmPort + "; requests go to the host agent on 127.0.0.1:" + agentPort);
    }

    void close() { closed = true; }

    private void spawn() {
        if (closed) return;
        if (open.incrementAndGet() > MAX) { open.decrementAndGet(); return; }
        new Thread(this::one, "egress").start();
    }

    /** One line (no newline), at most `max` bytes, read byte by byte so nothing after it is consumed; null at EOF or too long. */
    static String readLine(InputStream in, int max) throws java.io.IOException {
        final StringBuilder l = new StringBuilder(); int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') return l.toString();
            if (l.length() >= max) return null;
            l.append((char) c);
        }
        return null;
    }

    private void one() {
        ParcelFileDescriptor pfd = null; Socket s = null; boolean replaced = false;
        try {
            pfd = Main.connect(vm, vmPort, 25);
            if (pfd == null) return;
            final ParcelFileDescriptor p = pfd;
            final InputStream fromVm = new FileInputStream(p.getFileDescriptor()); final OutputStream toVm = new FileOutputStream(p.getFileDescriptor());
            final String line = readLine(fromVm, 300);   // as long as it takes: this stream is idle until the app needs out
            if (line == null) return;
            spawn(); replaced = true;
            if (!line.matches("(CONNECT [A-Za-z0-9._:\\[\\]-]{1,255} [0-9]{1,5}|RESOLVE [A-Za-z0-9._:\\[\\]-]{1,255})")) {
                toVm.write("ERR malformed\n".getBytes(StandardCharsets.US_ASCII)); return;
            }
            s = new Socket();
            try { s.connect(new InetSocketAddress("127.0.0.1", agentPort), 10000); }
            catch (Exception e) { toVm.write("ERR the host agent is not reachable\n".getBytes(StandardCharsets.US_ASCII)); return; }
            s.setTcpNoDelay(true); s.setSoTimeout(60000);
            final InputStream fromAgent = s.getInputStream(); final OutputStream toAgent = s.getOutputStream();
            toAgent.write(("EGRESS " + token + " " + line + "\n").getBytes(StandardCharsets.US_ASCII)); toAgent.flush();
            String reply = readLine(fromAgent, 4096);
            if (reply == null) reply = "ERR the host agent did not answer";
            toVm.write((reply + "\n").getBytes(StandardCharsets.US_ASCII)); toVm.flush();
            if (!reply.equals("OK")) return;   // a RESOLVE's answer ("OK <ips>") and every refusal end the stream
            s.setSoTimeout(0);
            final Socket sock = s;
            final Thread up = new Thread(() -> { final byte[] b = new byte[1 << 16]; int n;
                try { while ((n = fromVm.read(b)) > 0) { toAgent.write(b, 0, n); toAgent.flush(); } } catch (Exception ignored) { }
                try { sock.shutdownOutput(); } catch (Exception ignored) { } }, "egress-up");
            up.start();
            final byte[] b = new byte[1 << 16]; int n;
            try { while ((n = fromAgent.read(b)) > 0) { toVm.write(b, 0, n); toVm.flush(); } } catch (Exception ignored) { }
            try { android.system.Os.shutdown(p.getFileDescriptor(), android.system.OsConstants.SHUT_WR); } catch (Exception ignored) { }
            up.join(30000);
        } catch (Exception ignored) {
        } finally {
            if (s != null) try { s.close(); } catch (Exception ignored) { }
            if (pfd != null) try { pfd.close(); } catch (Exception ignored) { }
            open.decrementAndGet();
            // a stream that ended before it carried a request (the VM not ready yet, or its session ending) is replaced after
            // a pause, so a VM that is gone costs one attempt per idle slot every two seconds until the session closes us
            if (!replaced && !closed) { try { Thread.sleep(2000); } catch (InterruptedException ignored) { } spawn(); }
        }
    }
}
