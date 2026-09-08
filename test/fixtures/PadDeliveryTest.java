package host.enclave.anchor.avf;

import java.io.*;
import java.nio.file.*;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public final class PadDeliveryTest {
    static final String A = "0123456789abcdef0123456789abcdef", B = "fedcba9876543210fedcba9876543210";
    static void check(boolean value, String why) { if (!value) throw new AssertionError(why); }
    static void fails(IORun r) throws Exception { try { r.run(); throw new AssertionError("expected IOException"); } catch (IOException expected) { } }
    interface IORun { void run() throws Exception; }
    public static void main(String[] args) throws Exception {
        Path dir = Files.createTempDirectory("pad-delivery-");
        try {
            String first = A + "-0-64.pads";
            PadDelivery.Session one = PadDelivery.begin(); one.bind("http://first", A);
            // Reproduce index-zero starvation: reserve 0..64 before the dealer has uploaded it.
            // Even an arbitrarily far-ahead mark cannot mean the VM received this file.
            File local = dir.resolve(first).toFile(); Files.write(local.toPath(), new byte[]{1});
            check(one.shouldFetch(first), "reserved but missing shipment must be fetched");
            check(!one.prune(local, 4096) && local.exists(), "reserved but unacknowledged local file must survive");
            one.accept(first);
            check(!one.prune(local, 63), "partial reservation cannot discard whole file");
            check(one.prune(local, 64) && !one.shouldFetch(first), "acknowledged spent file removed and never refetched");
            check(!one.shouldFetch(B + "-0-64.pads"), "foreign seed cannot enter this run");
            for (String bad : new String[]{"../" + first, A + "-0-0.pads", A + "-16777216-1.pads", A + "-0-9223372036854775807.pads", A + "-1-1.pads/other", A + "--1-1.pads"})
                check(PadDelivery.endOf(bad) < 0 && !one.shouldFetch(bad), "invalid shipment: " + bad);
            String[] order = {A + "-128-64.pads", A + "-64-64.pads", first};
            Arrays.sort(order, (a,b) -> Long.compare(PadDelivery.indexOf(a), PadDelivery.indexOf(b)));
            check(order[0].equals(first) && order[1].contains("-64-"), "numeric delivery order");
            ByteArrayOutputStream exact = new ByteArrayOutputStream();
            one.copy(new ByteArrayInputStream(new byte[]{1,2,3}), exact, 3);
            check(exact.size() == 3, "exact bytes copied");
            fails(() -> one.copy(new ByteArrayInputStream(new byte[]{1,2}), new ByteArrayOutputStream(), 3));
            ByteArrayOutputStream oversized = new ByteArrayOutputStream();
            fails(() -> one.copy(new ByteArrayInputStream(new byte[]{1,2,3,4}), oversized, 3));
            check(oversized.size() == 3, "oversized download bounded before disk write");

            CountDownLatch entered = new CountDownLatch(1), released = new CountDownLatch(1);
            InputStream blocking = new InputStream() {
                @Override public int read() throws IOException { return read(new byte[1],0,1); }
                @Override public int read(byte[] b, int off, int len) throws IOException {
                    entered.countDown();
                    try { if (!released.await(5, TimeUnit.SECONDS)) throw new AssertionError("cancel failed to close input"); }
                    catch (InterruptedException e) { throw new IOException(e); }
                    throw new IOException("closed");
                }
                @Override public void close() { released.countDown(); }
            };
            one.track(blocking);
            AtomicReference<Throwable> error = new AtomicReference<>();
            Thread oldFetch = new Thread(() -> { try { one.copy(blocking, new ByteArrayOutputStream(), 1); error.set(new AssertionError("canceled copy succeeded")); } catch (IOException expected) { } catch (Throwable t) { error.set(t); } });
            oldFetch.start(); check(entered.await(5,TimeUnit.SECONDS), "fetch started");
            PadDelivery.Session two = PadDelivery.begin(); two.bind("http://second", B);
            oldFetch.join(5000); check(!oldFetch.isAlive() && error.get() == null, "old fetch canceled and joined");
            check(!one.active() && one.base().equals("http://first") && one.seed().equals(A), "old session never borrows new relay/seed");
            File current = dir.resolve(B + "-0-64.pads").toFile(); Files.write(current.toPath(), new byte[]{9});
            check(!one.pruneForeign(current) && current.exists(), "canceled fetcher cannot delete new run files");
            File tmp = Files.createTempFile(dir,"late-",".part").toFile(); Files.write(tmp.toPath(), new byte[]{7});
            check(!one.publish(tmp, local), "late completion cannot publish after cancellation");
            check(two.publish(tmp,current) && Files.readAllBytes(current.toPath())[0] == 7, "current run can publish");
            AtomicBoolean closed = new AtomicBoolean(); two.track(() -> closed.set(true));
            one.close(); check(two.active() && !closed.get(), "old finally cannot cancel the new run");
            PadDelivery.Session three = PadDelivery.begin(); three.bind("http://third", A);
            check(closed.get() && three.shouldFetch(first), "new VM gets fresh acknowledgments even for repeated seed");
            fails(() -> three.bind("http://evil", B));
            three.close();
            AtomicBoolean lateClosed = new AtomicBoolean();
            check(!three.track(() -> lateClosed.set(true)) && lateClosed.get(), "late resource closed immediately");
            System.out.println("pad-delivery: ok");
        } finally {
            try (var files = Files.walk(dir)) { files.sorted(java.util.Comparator.reverseOrder()).forEach(p -> { try { Files.delete(p); } catch (IOException e) { throw new RuntimeException(e); } }); }
        }
    }
}
