package host.enclave.anchor.avf;

import java.io.Closeable;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Integration fixture over the ACTUAL GENERATED PadDelivery.Session plus VmSendGate.
 *
 *  It calls only real production methods: PadDelivery.begin(int,boolean,boolean), session.track,
 *  session.sendGate(), session.close(). Nothing about the session is stubbed or re-implemented;
 *  the only test-owned object is a Closeable that counts its own closes, which is exactly the
 *  contract track() takes.
 *
 *  LIMIT, stated rather than implied: this exercises the Session/gate contract. It does NOT prove
 *  the PadsClient finally-branch placement (streamBank / directStream), because those methods need
 *  a live vsock, a ParcelFileDescriptor and Main.connect. Their branch coverage is a review
 *  obligation and, on device, root's run — not something this fixture establishes.
 *
 *  Compile inputs (from PadDelivery.java's own imports and references): PadDelivery.java,
 *  VmSendGate.java, PadAckQueue.java. Root may additionally run the repository's existing
 *  test/fixtures/PadDeliveryTest.java against the generated copy; the disabled-gate path is
 *  unchanged, so its copy/prune expectations should hold as they are.
 *
 *  javac -d /tmp/g <gated>/PadDelivery.java <gated>/VmSendGate.java <app>/PadAckQueue.java \
 *        SessionGateIntegrationTest.java
 *  java -cp /tmp/g host.enclave.anchor.avf.SessionGateIntegrationTest */
public final class SessionGateIntegrationTest {

    private static int failures = 0;
    private static void check(boolean ok, String what) {
        if (ok) System.out.println("ok   " + what); else { failures++; System.out.println("FAIL " + what); }
    }
    private static void await(CountDownLatch l) {
        try { if (!l.await(15, TimeUnit.SECONDS)) throw new IllegalStateException("latch timeout"); }
        catch (InterruptedException e) { throw new IllegalStateException(e); }
    }
    private static void spinUntil(java.util.function.BooleanSupplier c) {
        long end = System.nanoTime() + 15_000_000_000L;
        while (!c.getAsBoolean()) { if (System.nanoTime() > end) throw new IllegalStateException("condition timeout"); Thread.onSpinWait(); }
    }

    /** The only test-owned object: a tracked resource that counts closes. */
    private static final class CountingCloseable implements Closeable {
        final AtomicInteger closes = new AtomicInteger();
        @Override public void close() throws IOException { closes.incrementAndGet(); }
    }

    public static void main(String[] args) throws Exception {

        // 1. An enabled session: a held lease keeps a drain waiting, a second sender parks, and
        //    session.close() wakes both while closing the tracked resource exactly once.
        {
            PadDelivery.Session s = PadDelivery.begin(0, false, true);
            check(s.sendGate().isEnabled(), "begin(...,true) arms the gate");
            CountingCloseable tracked = new CountingCloseable();
            check(s.track(tracked), "a resource is tracked on the live session");

            VmSendGate.Lease held = s.sendGate().acquire();
            check(held != null && s.sendGate().inFlight() == 1, "a send holds a lease");

            AtomicBoolean drained = new AtomicBoolean(true);
            CountDownLatch drainDone = new CountDownLatch(1);
            Thread drainer = new Thread(() -> { drained.set(s.sendGate().requestPauseAndDrain(20000)); drainDone.countDown(); });
            drainer.setDaemon(true); drainer.start();
            spinUntil(() -> s.sendGate().isPaused());

            AtomicReference<VmSendGate.Lease> parked = new AtomicReference<>();
            AtomicBoolean parkedReturned = new AtomicBoolean();
            CountDownLatch senderDone = new CountDownLatch(1);
            Thread sender = new Thread(() -> { parked.set(s.sendGate().acquire()); parkedReturned.set(true); senderDone.countDown(); });
            sender.setDaemon(true); sender.start();
            spinUntil(() -> s.sendGate().stats().contains("waited=1"));
            check(!parkedReturned.get(), "the second sender is parked, not failed");
            check(drainDone.getCount() == 1, "the drain waits while the lease is held");

            s.close();                                   // production Session.close() -> stop() -> gate.close()
            await(drainDone); drainer.join();
            await(senderDone); sender.join();
            check(!drained.get(), "session close cancels the waiting drain (false, not a false quiet)");
            check(parked.get() == null, "the parked sender is woken and gets no lease");
            check(s.sendGate().isClosed(), "stop() closed the gate");
            check(tracked.closes.get() == 1, "the tracked resource was closed exactly once");
            held.release();
            check(s.sendGate().inFlight() == 0, "the held lease still released cleanly after close");
            s.close();
            check(tracked.closes.get() == 1, "a second close does not re-close the resource");
        }

        // 2. begin() replacement: the previous session's gate is closed, the new one is open, and
        //    a sender parked on the old session is released to give up.
        {
            PadDelivery.Session first = PadDelivery.begin(0, false, true);
            VmSendGate.Lease l = first.sendGate().acquire();
            check(l != null, "old session grants a lease");
            AtomicBoolean ok = new AtomicBoolean(true);
            CountDownLatch done = new CountDownLatch(1);
            Thread d = new Thread(() -> { ok.set(first.sendGate().requestPauseAndDrain(20000)); done.countDown(); });
            d.setDaemon(true); d.start();
            spinUntil(() -> first.sendGate().isPaused());

            PadDelivery.Session second = PadDelivery.begin(0, false, false);   // default: gate disabled
            await(done); d.join();
            check(!ok.get(), "the replaced session's drain is cancelled by its close");
            check(first.sendGate().isClosed(), "the old gate is closed by the replacement");
            check(!second.sendGate().isEnabled(), "the new default session's gate is disabled");
            VmSendGate.Lease n = second.sendGate().acquire();
            check(n != null, "the new session sends immediately, unaffected by the old pause");
            if (n != null) n.release();
            l.release();
            second.close();
        }

        // 3. Default-off session: the gate never parks and never refuses, so the existing
        //    behaviour is unchanged. (The repository PadDeliveryTest covers copy/prune on this
        //    same disabled path; it is not duplicated here.)
        {
            PadDelivery.Session s = PadDelivery.begin(0, false);
            check(!s.sendGate().isEnabled(), "the two-argument begin leaves the gate disabled");
            for (int i = 0; i < 4; i++) {
                VmSendGate.Lease l = s.sendGate().acquire();
                check(l != null, "disabled session grants lease " + i);
                if (l != null) l.release();
            }
            check(!s.sendGate().requestPauseAndDrain(1000), "a disabled gate refuses a drain request");
            VmSendGate.Lease after = s.sendGate().acquire();
            check(after != null, "and still sends afterwards");
            if (after != null) after.release();
            s.close();
            check(s.sendGate().isClosed(), "close still closes the disabled gate");
            check(s.sendGate().acquire() == null, "a closed gate grants nothing, enabled or not");
        }

        if (failures > 0) { System.out.println("\n" + failures + " FAILURE(S)"); System.exit(1); }
        System.out.println("\nsession/gate integration verified");
    }
}
