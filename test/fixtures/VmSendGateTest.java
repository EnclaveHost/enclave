package host.enclave.anchor.avf;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Exercises the PRODUCTION VmSendGate. Orderings are forced with latches and barriers; no sleep
 *  is used to create a race. Pure Java: no phone, no vsock, no network, no file.
 *
 *  javac -d /tmp/g VmSendGate.java VmSendGateTest.java
 *  java -cp /tmp/g host.enclave.anchor.avf.VmSendGateTest */
public final class VmSendGateTest {

    private static int failures = 0;
    private static void check(boolean ok, String what) {
        if (ok) System.out.println("ok   " + what); else { failures++; System.out.println("FAIL " + what); }
    }
    private static void await(CountDownLatch l) {
        try { if (!l.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("latch timeout"); }
        catch (InterruptedException e) { throw new IllegalStateException(e); }
    }
    private static void spinUntil(java.util.function.BooleanSupplier c) {
        long end = System.nanoTime() + 10_000_000_000L;
        while (!c.getAsBoolean()) { if (System.nanoTime() > end) throw new IllegalStateException("condition timeout"); Thread.onSpinWait(); }
    }

    /** A sender modelled on the generated call site: lease, signal, finish when told, release. */
    private static final class Sender extends Thread {
        final VmSendGate gate; final CountDownLatch held = new CountDownLatch(1), mayFinish;
        final AtomicReference<VmSendGate.Lease> lease = new AtomicReference<>();
        final AtomicBoolean gaveUp = new AtomicBoolean(), released = new AtomicBoolean();
        Sender(VmSendGate g, CountDownLatch f) { gate = g; mayFinish = f; setDaemon(true); }
        @Override public void run() {
            VmSendGate.Lease l = gate.acquire();
            lease.set(l);
            if (l == null) { gaveUp.set(true); held.countDown(); return; }
            try { held.countDown(); await(mayFinish); } finally { l.release(); released.set(true); }
        }
    }

    public static void main(String[] args) throws Exception {

        // 1. Default off: unchanged behaviour, drain refused, no waiting.
        {
            VmSendGate g = VmSendGate.disabled();
            for (int i = 0; i < 3; i++) { VmSendGate.Lease l = g.acquire(); check(l != null, "disabled grants " + i); l.release(); }
            check(!g.requestPauseAndDrain(1000), "disabled refuses a drain");
            VmSendGate.Lease l = g.acquire(); check(l != null, "disabled still grants after refused drain"); l.release();
            check(g.inFlight() == 0, "disabled settles at zero");
        }

        // 2. Mid-flight pause: drain waits for the exact release; a new sender WAITS, not fails.
        {
            VmSendGate g = VmSendGate.enabled();
            CountDownLatch fin = new CountDownLatch(1);
            Sender s = new Sender(g, fin); s.start(); await(s.held);
            AtomicBoolean ok = new AtomicBoolean(); CountDownLatch done = new CountDownLatch(1);
            Thread d = new Thread(() -> { ok.set(g.requestPauseAndDrain(10000)); done.countDown(); }); d.setDaemon(true); d.start();
            spinUntil(g::isPaused);
            CountDownLatch fin2 = new CountDownLatch(1);
            Sender waiter = new Sender(g, fin2); waiter.start();
            spinUntil(() -> g.stats().contains("waited=1"));
            check(waiter.lease.get() == null && waiter.isAlive(), "a new sender WAITS while paused, it does not fail");
            check(done.getCount() == 1, "drain has not returned while a send is in flight");
            fin.countDown(); s.join(); await(done); d.join();
            check(ok.get(), "drain true only after the in-flight send released");
            check(g.isPaused() && g.inFlight() == 0, "successful drain leaves the pause in force at zero in flight");
            g.resume();
            await(waiter.held); check(waiter.lease.get() != null, "resume releases the parked sender");
            fin2.countDown(); waiter.join();
        }

        // 3. THE REJECTED DEFECT: resume during an active drain must cancel it, returning false.
        {
            VmSendGate g = VmSendGate.enabled();
            CountDownLatch fin = new CountDownLatch(1);
            Sender s = new Sender(g, fin); s.start(); await(s.held);
            AtomicBoolean ok = new AtomicBoolean(true); CountDownLatch done = new CountDownLatch(1);
            Thread d = new Thread(() -> { ok.set(g.requestPauseAndDrain(10000)); done.countDown(); }); d.setDaemon(true); d.start();
            spinUntil(g::isPaused);
            g.resume();                                   // cancels the generation this drain owns
            await(done); d.join();
            check(!ok.get(), "resume during a drain makes it return FALSE, not true");
            check(!g.isPaused(), "and the gate is open, as the resumer intended");
            VmSendGate.Lease l = g.acquire();
            check(l != null, "a lease is granted after the cancelling resume"); l.release();
            fin.countDown(); s.join();
        }

        // 4. Timeout restores OPEN, never strands senders paused.
        {
            VmSendGate g = VmSendGate.enabled();
            CountDownLatch fin = new CountDownLatch(1);
            Sender s = new Sender(g, fin); s.start(); await(s.held);
            long t0 = System.nanoTime();
            boolean ok = g.requestPauseAndDrain(150);
            long ms = (System.nanoTime() - t0) / 1_000_000L;
            check(!ok, "timeout reports failure");
            check(ms >= 150, "timeout waited the monotonic deadline (" + ms + " ms)");
            check(!g.isPaused(), "timeout REOPENS the gate");
            VmSendGate.Lease l = g.acquire(); check(l != null, "sends resume after a timed-out drain"); l.release();
            fin.countDown(); s.join(); check(s.released.get(), "the in-flight send still completed");
        }

        // 5. Interruption: false, gate reopened, interrupt bit preserved.
        {
            VmSendGate g = VmSendGate.enabled();
            CountDownLatch fin = new CountDownLatch(1);
            Sender s = new Sender(g, fin); s.start(); await(s.held);
            AtomicBoolean ok = new AtomicBoolean(true), flag = new AtomicBoolean();
            CountDownLatch done = new CountDownLatch(1);
            Thread d = new Thread(() -> { ok.set(g.requestPauseAndDrain(10000)); flag.set(Thread.currentThread().isInterrupted()); done.countDown(); });
            d.setDaemon(true); d.start();
            spinUntil(g::isPaused); d.interrupt(); await(done); d.join();
            check(!ok.get(), "interruption reports failure");
            check(flag.get(), "the interrupt bit is preserved");
            check(!g.isPaused(), "interruption REOPENS the gate");
            fin.countDown(); s.join();
        }

        // 6. Duplicate and already-paused requests are refused explicitly.
        {
            VmSendGate g = VmSendGate.enabled();
            CountDownLatch fin = new CountDownLatch(1);
            Sender s = new Sender(g, fin); s.start(); await(s.held);
            AtomicBoolean first = new AtomicBoolean(), second = new AtomicBoolean(true);
            CountDownLatch bothDone = new CountDownLatch(2);
            Thread a = new Thread(() -> { first.set(g.requestPauseAndDrain(10000)); bothDone.countDown(); }); a.setDaemon(true); a.start();
            spinUntil(g::isDraining);
            Thread b = new Thread(() -> { second.set(g.requestPauseAndDrain(10000)); bothDone.countDown(); }); b.setDaemon(true); b.start(); b.join();
            check(!second.get(), "a concurrent second drain is refused, not nested");
            fin.countDown(); s.join(); await(bothDone); a.join();
            check(first.get(), "the first drain succeeds");
            check(!g.requestPauseAndDrain(1000), "a drain while already paused is refused");
            g.resume();
        }

        // 7. close() wakes a parked sender and a waiting drainer; the in-flight send is untouched.
        {
            VmSendGate g = VmSendGate.enabled();
            CountDownLatch fin = new CountDownLatch(1);
            Sender s = new Sender(g, fin); s.start(); await(s.held);
            AtomicBoolean ok = new AtomicBoolean(true); CountDownLatch done = new CountDownLatch(1);
            Thread d = new Thread(() -> { ok.set(g.requestPauseAndDrain(10000)); done.countDown(); }); d.setDaemon(true); d.start();
            spinUntil(g::isPaused);
            Sender parked = new Sender(g, new CountDownLatch(1)); parked.start();
            spinUntil(() -> g.stats().contains("waited=1"));
            g.close();
            await(done); d.join(); await(parked.held); parked.join();
            check(!ok.get(), "close cancels a waiting drain");
            check(parked.gaveUp.get(), "close wakes a parked sender, which gives up with no lease");
            check(g.acquire() == null, "closed gate grants nothing");
            check(s.isAlive(), "close did not disturb the in-flight send");
            fin.countDown(); s.join(); check(s.released.get(), "the in-flight send completed after close");
            check(!g.requestPauseAndDrain(1000), "closed gate refuses drains");
        }

        // 8. Token release is idempotent: a double close cannot let a drain declare quiet.
        {
            VmSendGate g = VmSendGate.enabled();
            VmSendGate.Lease a = g.acquire(), b = g.acquire();
            check(g.inFlight() == 2, "two leases counted");
            a.release(); a.release(); a.release();
            check(g.inFlight() == 1, "double release of one token does not decrement the other");
            check(!g.requestPauseAndDrain(150), "drain cannot succeed while the second lease is live");
            check(!g.isPaused(), "and the failed drain reopened the gate");
            b.release(); check(g.inFlight() == 0, "second token released");
            check(g.requestPauseAndDrain(2000), "drain succeeds once both tokens are released");
            g.resume();
        }

        // 9. Pause racing connect: many senders, one pause. Every grant completes; none after.
        {
            VmSendGate g = VmSendGate.enabled();
            final int N = 12;
            CyclicBarrier start = new CyclicBarrier(N + 1);
            AtomicInteger grants = new AtomicInteger(), done = new AtomicInteger();
            AtomicBoolean afterDrain = new AtomicBoolean();
            AtomicBoolean drained = new AtomicBoolean();
            Thread[] ts = new Thread[N];
            for (int i = 0; i < N; i++) {
                ts[i] = new Thread(() -> {
                    try { start.await(10, TimeUnit.SECONDS); } catch (Exception e) { throw new IllegalStateException(e); }
                    for (int k = 0; k < 40; k++) {
                        VmSendGate.Lease l = g.tryAcquire();      // non-blocking so the loop can end
                        if (l == null) return;
                        grants.incrementAndGet();
                        if (drained.get()) afterDrain.set(true);   // a grant observed after drain returned
                        try { Thread.onSpinWait(); } finally { l.release(); done.incrementAndGet(); }
                    }
                });
                ts[i].setDaemon(true); ts[i].start();
            }
            start.await(10, TimeUnit.SECONDS);
            boolean ok = g.requestPauseAndDrain(10000);
            drained.set(true);
            for (Thread t : ts) t.join();
            check(ok, "drain succeeds under contention");
            check(grants.get() == done.get(), "every granted lease completed (" + grants.get() + ")");
            check(g.inFlight() == 0, "no lease outlived the drain");
            check(!afterDrain.get(), "no lease granted after the drain returned");
            g.resume();
        }

        // 10. Argument validation.
        {
            VmSendGate g = VmSendGate.enabled();
            for (long t : new long[] { 0, -1, VmSendGate.MAX_DRAIN_MS + 1 }) {
                try { g.requestPauseAndDrain(t); check(false, "timeout " + t + " rejected"); }
                catch (IllegalArgumentException e) { check(true, "timeout " + t + " rejected"); }
            }
        }

        if (failures > 0) { System.out.println("\n" + failures + " FAILURE(S)"); System.exit(1); }
        System.out.println("\nvm send gate verified");
    }
}
