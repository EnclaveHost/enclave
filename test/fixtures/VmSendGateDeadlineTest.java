package host.enclave.anchor.avf;

import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/** Focused fixture for the drain deadline. HOST-ONLY: it reaches the gate's private monitor by
 *  reflection to hold it deterministically, so the "deadline expires before the lock is acquired"
 *  path is exercised with latches instead of a hopeful delay.
 *
 *  What is asserted: NO LATE SUCCESS. A drain whose deadline has passed must return false and leave
 *  the gate open. What is NOT asserted: that the drainer returns within any particular time — the
 *  JVM scheduler makes no such promise, and this fixture never requires one.
 *
 *  javac -d /tmp/g VmSendGate.java VmSendGateDeadlineTest.java
 *  java -cp /tmp/g host.enclave.anchor.avf.VmSendGateDeadlineTest */
public final class VmSendGateDeadlineTest {

    private static int failures = 0;
    private static void check(boolean ok, String what) {
        if (ok) System.out.println("ok   " + what); else { failures++; System.out.println("FAIL " + what); }
    }
    private static void await(CountDownLatch l) {
        try { if (!l.await(20, TimeUnit.SECONDS)) throw new IllegalStateException("latch timeout"); }
        catch (InterruptedException e) { throw new IllegalStateException(e); }
    }
    private static Object monitorOf(VmSendGate g) throws Exception {
        Field f = VmSendGate.class.getDeclaredField("lock"); f.setAccessible(true); return f.get(g);
    }

    public static void main(String[] args) throws Exception {

        // 1. Deadline expires while the drainer is still waiting for the monitor. A holder thread
        //    keeps the gate's lock until well past the requested deadline; the drainer therefore
        //    enters the critical section already expired.
        {
            VmSendGate g = VmSendGate.enabled();
            check(g.inFlight() == 0, "zero leases: old late-deadline code would falsely succeed");
            Object mon = monitorOf(g);
            CountDownLatch holding = new CountDownLatch(1), mayRelease = new CountDownLatch(1);
            Thread holder = new Thread(() -> {
                synchronized (mon) { holding.countDown(); await(mayRelease); }
            });
            holder.setDaemon(true); holder.start(); await(holding);

            AtomicBoolean result = new AtomicBoolean(true);
            AtomicLong elapsed = new AtomicLong();
            CountDownLatch entered = new CountDownLatch(1), done = new CountDownLatch(1);
            Thread drainer = new Thread(() -> {
                entered.countDown();
                long t0 = System.nanoTime();
                result.set(g.requestPauseAndDrain(60));        // deadline fixed here, before the lock
                elapsed.set((System.nanoTime() - t0) / 1_000_000L);
                done.countDown();
            });
            drainer.setDaemon(true); drainer.start(); await(entered);
            long blockedBy = System.nanoTime() + 2_000_000_000L;
            while (drainer.getState() != Thread.State.BLOCKED) {
                if (System.nanoTime() > blockedBy) throw new AssertionError("drainer never blocked acquiring monitor");
                Thread.onSpinWait();
            }

            // Hold the monitor until the drainer's 60 ms deadline is certainly gone. The wait is on
            // a latch from the drainer's own side, not a race: we only release after the clock has
            // advanced past the deadline, which we can observe directly.
            long until = System.nanoTime() + 250_000_000L;
            while (System.nanoTime() < until) Thread.onSpinWait();
            mayRelease.countDown(); holder.join();

            await(done); drainer.join();
            check(!result.get(), "an expired deadline yields FALSE, never a late success");
            check(elapsed.get() >= 60, "the drainer observed at least its own deadline (" + elapsed.get() + " ms)");
            check(!g.isPaused(), "the gate is left OPEN after the expired drain");
            VmSendGate.Lease after = g.tryAcquire();
            check(after != null, "a new send is admitted after the expired drain");
            if (after != null) after.release();
            check(g.stats().contains("timeouts=1"), "the expiry is counted as a timeout");
        }

        // 2. Late release: the lease is released only after the deadline has passed, so the
        //    zero-in-flight condition becomes true too late. Must still be false.
        {
            VmSendGate g = VmSendGate.enabled();
            VmSendGate.Lease l = g.acquire();
            AtomicBoolean result = new AtomicBoolean(true);
            CountDownLatch done = new CountDownLatch(1);
            Thread d = new Thread(() -> { result.set(g.requestPauseAndDrain(300)); done.countDown(); });
            d.setDaemon(true); d.start();
            long startedBy = System.nanoTime() + 2_000_000_000L;
            while (!g.isPaused()) {
                if (System.nanoTime() > startedBy) throw new AssertionError("drain never paused");
                Thread.onSpinWait();
            }
            synchronized (monitorOf(g)) {
                long until = System.nanoTime() + 350_000_000L;
                while (System.nanoTime() < until) Thread.onSpinWait();
                l.release(); // reentrant monitor: make count zero only after the deadline, before drainer reacquires
            }
            await(done); d.join();
            check(!result.get(), "a release after the deadline does not rescue the drain");
            check(!g.isPaused(), "and the gate is open again");
        }

        // 3. An already-interrupted caller is refused outright: it could not wait, so it must not
        //    be granted a pause it might report as quiet. State and flag are untouched.
        {
            VmSendGate g = VmSendGate.enabled();
            AtomicBoolean result = new AtomicBoolean(true), flag = new AtomicBoolean();
            AtomicBoolean paused = new AtomicBoolean(true);
            CountDownLatch done = new CountDownLatch(1);
            Thread t = new Thread(() -> {
                Thread.currentThread().interrupt();
                result.set(g.requestPauseAndDrain(5000));
                paused.set(g.isPaused());
                flag.set(Thread.currentThread().isInterrupted());
                done.countDown();
            });
            t.setDaemon(true); t.start(); await(done); t.join();
            check(!result.get(), "an already-interrupted caller is refused");
            check(!paused.get(), "and no pause was asserted");
            check(flag.get(), "and its interrupt flag is preserved");
            VmSendGate.Lease l = g.tryAcquire();
            check(l != null, "sends are unaffected by the refused request");
            if (l != null) l.release();
        }

        if (failures > 0) { System.out.println("\n" + failures + " FAILURE(S)"); System.exit(1); }
        System.out.println("\ndrain deadline verified");
    }
}
