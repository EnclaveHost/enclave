package host.enclave.anchor.avf;

import java.io.Closeable;
import java.util.Comparator;
import java.util.TreeMap;

/** Per-run signed delivery retries. The control reader only enqueues; HTTP
 * never blocks a window request. Lower ranges are retried first to close gaps. */
final class PadAckQueue implements Closeable {
    static final int CAPACITY = 1024;
    interface Sender { boolean send(Ack ack) throws Exception; }
    static final class Ack {
        final String seed, sha256, nonce, sig;
        final long index0, count;
        Ack(String seed, long index0, long count, String sha256, String nonce, String sig) {
            this.seed=seed; this.index0=index0; this.count=count; this.sha256=sha256; this.nonce=nonce; this.sig=sig;
        }
        static Ack parse(String line, String expectedSeed) {
            if (line == null || line.length() > 512) throw new IllegalArgumentException("invalid PADACK length");
            String[] f = line.trim().split(" +");
            if (f.length != 7 || !f[0].equals("PADACK") || !f[1].equals(expectedSeed) || !f[1].matches("[0-9a-f]{32}") ||
                !f[2].matches("0|[1-9][0-9]*") || !f[3].matches("[1-9][0-9]*") || !f[4].matches("[0-9a-f]{64}") ||
                !f[5].matches("[0-9a-f]{32}") || !f[6].matches("[0-9a-f]{128}")) throw new IllegalArgumentException("invalid PADACK fields");
            long lo = Long.parseLong(f[2]), count = Long.parseLong(f[3]);
            if (lo < 0 || lo >= (1L << 24) || count <= 0 || count > (1L << 24)-lo) throw new IllegalArgumentException("invalid PADACK range");
            return new Ack(f[1], lo, count, f[4], f[5], f[6]);
        }
    }
    private final TreeMap<Ack,Ack> pending = new TreeMap<>(Comparator.comparingLong((Ack a) -> a.index0)
        .thenComparingLong(a -> a.count).thenComparing(a -> a.sha256));
    private final Sender sender;
    private final long retryMillis;
    private final Thread worker;
    private boolean closed;
    PadAckQueue(Sender sender) { this(sender, 1000); }
    PadAckQueue(Sender sender, long retryMillis) {
        this.sender=sender; this.retryMillis=retryMillis;
        worker = new Thread(this::run, "pad-acks"); worker.setDaemon(true); worker.start();
    }
    synchronized boolean offer(Ack ack) {
        if (closed) return false;
        if (pending.containsKey(ack)) return true;
        if (pending.size() >= CAPACITY) return false;
        pending.put(ack,ack); notifyAll(); return true;
    }
    synchronized int size() { return pending.size(); }
    private void run() {
        for (;;) {
            Ack ack;
            synchronized (this) {
                while (!closed && pending.isEmpty()) try { wait(); } catch (InterruptedException e) { if (closed) return; }
                if (closed) return;
                ack = pending.firstEntry().getValue();
            }
            boolean done = false;
            try { done = sender.send(ack); } catch (Exception ignored) { /* retry the same signed request */ }
            synchronized (this) {
                if (closed) return;
                if (done) pending.remove(ack);
                else try { wait(retryMillis); } catch (InterruptedException e) { if (closed) return; }
            }
        }
    }
    @Override public synchronized void close() {
        closed=true; pending.clear(); notifyAll(); worker.interrupt();
    }
}
