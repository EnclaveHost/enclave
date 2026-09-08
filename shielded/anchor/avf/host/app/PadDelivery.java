package host.enclave.anchor.avf;

import java.io.Closeable;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Set;

/** Per-control-run pad delivery state. A reservation is not a delivery acknowledgment. */
final class PadDelivery {
    private static Session current;
    static Session begin() {
        Session next = new Session(); Closeable[] pending;
        synchronized (PadDelivery.class) {
            pending = current == null ? new Closeable[0] : current.stop();
            current = next;
        }
        Session.closeAll(pending);
        return next;
    }

    static final class Session implements Closeable {
        private boolean active = true;
        private String base = "", seed = "";
        private PadAckQueue acknowledgments;
        private final Set<String> accepted = new HashSet<>();
        private final Set<Closeable> resources = java.util.Collections.newSetFromMap(new IdentityHashMap<>());

        synchronized boolean active() { return active; }
        synchronized boolean ready() { return active && !seed.isEmpty(); }
        synchronized String base() { return base; }
        synchronized String seed() { return seed; }
        synchronized PadAckQueue acknowledgments(PadAckQueue.Sender sender) {
            if (!active || seed.isEmpty()) return null;
            if (acknowledgments == null) {
                acknowledgments = new PadAckQueue(sender);
                resources.add(acknowledgments);
            }
            return acknowledgments;
        }
        synchronized void bind(String httpBase, String seedId) throws IOException {
            if (!active || !seed.isEmpty() || !seedId.matches("[0-9a-f]{32}")) throw new IOException("invalid pad session binding");
            base = httpBase; seed = seedId;
        }
        synchronized boolean belongs(String name) { return !seed.isEmpty() && name.startsWith(seed + "-") && endOf(name) >= 0; }
        synchronized boolean accepted(String name) { return accepted.contains(name); }
        synchronized void accept(String name) { if (active && belongs(name)) accepted.add(name); }
        synchronized boolean shouldFetch(String name) { return active && belongs(name) && !accepted.contains(name); }
        synchronized boolean prune(File file, long ackFloor) {
            // ackFloor is the durably-ACKNOWLEDGED delivery floor. A shipment whose whole range is at or
            // below it is safe to drop from this prefetch cache: it was accepted by this run (the H/K
            // predicate below, already required before this change) AND its delivery is durably
            // acknowledged, so a later re-offer is a no-op. This aligns the drop with delivery progress;
            // it is not a consumption proof, and reservation ahead of the floor never authorizes a drop.
            if (!active || !belongs(file.getName()) || !accepted.contains(file.getName()) || endOf(file.getName()) > ackFloor) return false;
            return file.delete();
        }
        synchronized boolean pruneForeign(File file) {
            return active && ready() && endOf(file.getName()) >= 0 && !belongs(file.getName()) && file.delete();
        }
        synchronized boolean publish(File tmp, File file) {
            return active && belongs(file.getName()) && tmp.renameTo(file);
        }
        synchronized boolean track(Closeable resource) throws IOException {
            if (!active) { resource.close(); return false; }
            resources.add(resource); return true;
        }
        synchronized void untrack(Closeable resource) { resources.remove(resource); }
        private synchronized Closeable[] stop() {
            active = false;
            Closeable[] pending = resources.toArray(new Closeable[0]); resources.clear();
            return pending;
        }
        private static void closeAll(Closeable[] pending) {
            for (Closeable c : pending) try { c.close(); } catch (IOException ignored) { }
        }
        @Override public void close() { closeAll(stop()); }
        void copy(InputStream in, OutputStream out, long expected) throws IOException {
            if (expected <= 0) throw new IOException("invalid shipment length");
            byte[] buf = new byte[1 << 20]; long total = 0;
            while (active()) {
                long remaining = expected - total;
                int n = in.read(buf, 0, (int)Math.min(buf.length, remaining == 0 ? 1 : remaining));
                if (n < 0) { if (total != expected) throw new IOException("incomplete shipment"); return; }
                if (n == 0) continue;
                if (n > expected - total) throw new IOException("oversized shipment");
                out.write(buf, 0, n); total += n;
            }
            throw new IOException("pad session ended");
        }
    }

    static long indexOf(String name) {
        if (endOf(name) < 0) return Long.MAX_VALUE;
        return Long.parseLong(name.substring(33, name.indexOf('-', 33)));
    }
    static long endOf(String name) {
        if (!name.matches("[0-9a-f]{32}-[0-9]+-[0-9]+\\.pads")) return -1;
        try {
            int sep = name.indexOf('-', 33);
            long lo = Long.parseLong(name.substring(33, sep));
            long count = Long.parseLong(name.substring(sep + 1, name.length() - 5));
            return count > 0 && lo < (1L << 24) && count <= (1L << 24) - lo ? lo + count : -1;
        } catch (NumberFormatException e) { return -1; }
    }
}
