package host.enclave.anchor.avf;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Drives the EXTRACTED production Main.QuietPadsControl through its real API only:
 *  new QuietPadsControl(Session, OutputStream), offer(String), close(). The private handle() is
 *  never called: that would bypass the serial worker which owns the state.
 *
 *  The controller is track()ed on the session exactly as Main does, and the boolean is asserted.
 *
 *  Two objects are test-owned: an OutputStream modelled on FileOutputStream semantics (a write
 *  after close throws), and the say() stub in the generated wrapper. Waits are deadline-bounded
 *  with fast predicates; a fixed 200 ms sleep is used only to bound a NEGATIVE assertion.
 *
 *  javac --release 17 -d <dir> host/Main.java <app>/VmSendGate.java <app>/PadDelivery.java \
 *        <app>/PadAckQueue.java QuietPadsControlTest.java
 *  java -cp <dir> host.enclave.anchor.avf.QuietPadsControlTest */
public final class QuietPadsControlTest {

    private static final long WAIT_MS = 2000, NEG_MS = 200;
    private static int failures = 0;
    private static void check(boolean ok, String what) {
        if (ok) System.out.println("ok   " + what); else { failures++; System.out.println("FAIL " + what); }
    }
    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
    private static boolean waitFor(java.util.function.BooleanSupplier c, long ms) {
        long end = System.nanoTime() + ms * 1_000_000L;
        while (System.nanoTime() < end) { if (c.getAsBoolean()) return true; Thread.onSpinWait(); }
        return c.getAsBoolean();
    }

    /** Socket stand-in with FileOutputStream-like closed semantics: any write after close throws,
     *  including one that was parked inside a blocked write when close() happened. */
    static final class Out extends OutputStream {
        private final StringBuilder sink = new StringBuilder();
        private final CountDownLatch release = new CountDownLatch(1);
        final CountDownLatch entered = new CountDownLatch(1);
        volatile boolean block = false, broken = false;
        final AtomicBoolean closed = new AtomicBoolean();
        @Override public void write(int b) throws IOException { write(new byte[]{(byte) b}, 0, 1); }
        @Override public void write(byte[] b, int off, int len) throws IOException {
            if (closed.get()) throw new IOException("closed");
            if (broken) throw new IOException("socket broken");
            if (block) {
                entered.countDown();
                try { if (!release.await(10, TimeUnit.SECONDS)) throw new IOException("stalled"); }
                catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("interrupted"); }
                if (closed.get()) throw new IOException("closed");   // released BY close(): do not append
            }
            synchronized (sink) { sink.append(new String(b, off, len, java.nio.charset.StandardCharsets.UTF_8)); }
        }
        @Override public void close() { closed.set(true); release.countDown(); }
        void unblock() { release.countDown(); }
        String text() { synchronized (sink) { return sink.toString(); } }
        boolean has(String s) { return text().contains(s); }
    }

    private static PadDelivery.Session armed() { return PadDelivery.begin(0, false, true); }

    /** Construct and track exactly as Main does, asserting the track result. */
    private static Main.QuietPadsControl control(PadDelivery.Session s, Out out) {
        Main.QuietPadsControl c = new Main.QuietPadsControl(s, out);
        boolean tracked;
        try { tracked = s.track(c); } catch (Exception e) { throw new IllegalStateException("track threw", e); }
        check(tracked, "controller tracked on the live session");
        return c;
    }

    /** Fixture-only: the controller's own worker thread, for the interrupt case. Reads one field;
     *  no thread group scanning and nothing else is touched. */
    private static Thread workerOf(Main.QuietPadsControl c) throws Exception {
        Field f = Main.QuietPadsControl.class.getDeclaredField("worker");
        f.setAccessible(true);
        return (Thread) f.get(c);
    }

    public static void main(String[] args) throws Exception {

        // 1. Normal pause then resume, answers in order.
        {
            PadDelivery.Session s = armed(); Out out = new Out();
            Main.QuietPadsControl c = control(s, out);
            c.offer("QUIETPADS v1 pause 1 3000");
            check(waitFor(() -> out.has("paused"), WAIT_MS), "paused answered");
            check(s.sendGate().isPaused(), "gate paused after the ack");
            c.offer("QUIETPADS v1 resume 1");
            check(waitFor(() -> out.has("resumed"), WAIT_MS), "resume answered");
            check(waitFor(() -> !s.sendGate().isPaused(), WAIT_MS), "gate open after resume");
            check(out.text().indexOf("paused") < out.text().indexOf("resumed"), "answers are in order");
            c.close(); s.close();
        }

        // 2. Wrong trial and an extra field are refused and must NOT reopen the gate.
        {
            PadDelivery.Session s = armed(); Out out = new Out();
            Main.QuietPadsControl c = control(s, out);
            c.offer("QUIETPADS v1 pause 7 3000");
            check(waitFor(() -> out.has("paused"), WAIT_MS), "trial 7 paused");
            c.offer("QUIETPADS v1 resume 8");
            check(waitFor(() -> out.has("wrong_trial"), WAIT_MS), "resume for another trial refused");
            check(s.sendGate().isPaused(), "gate still paused after wrong_trial");
            c.offer("QUIETPADS v1 resume 7 extra");
            check(waitFor(() -> out.has("malformed"), WAIT_MS), "resume with an extra field refused");
            sleep(NEG_MS);
            check(s.sendGate().isPaused(), "gate STILL paused after the malformed resume");
            c.offer("QUIETPADS v1 resume 7");
            check(waitFor(() -> !s.sendGate().isPaused(), WAIT_MS), "the correct resume reopens it");
            c.close(); s.close();
        }

        // 2b. POLICY: a trailing space must not be accepted as a canonical resume.
        //     Java's String.split(" ") discards trailing empty fields, so "…resume 9 " yields
        //     length 4 and would pass an f.length != 4 test. If this case fails, the parser is
        //     accepting a non-canonical line and root reviews the policy; the fixture states the
        //     requirement rather than tolerating it.
        {
            PadDelivery.Session s = armed(); Out out = new Out();
            Main.QuietPadsControl c = control(s, out);
            c.offer("QUIETPADS v1 pause 9 3000");
            check(waitFor(() -> out.has("paused"), WAIT_MS), "trial 9 paused");
            c.offer("QUIETPADS v1 resume 9 ");
            sleep(NEG_MS);
            check(s.sendGate().isPaused(), "a trailing-space resume does not reopen the gate");
            c.offer("QUIETPADS v1 resume 9");
            check(waitFor(() -> !s.sendGate().isPaused(), WAIT_MS), "the canonical resume still works");
            c.close(); s.close();
        }

        // 3. Unarmed session: the worker never starts, so the experiment ends unanswered.
        {
            PadDelivery.Session s = PadDelivery.begin(0, false); Out out = new Out();
            Main.QuietPadsControl c = control(s, out);
            c.offer("QUIETPADS v1 pause 1 3000");
            check(waitFor(() -> out.closed.get(), WAIT_MS), "an unarmed session is ended, not answered");
            check(!out.has("paused"), "and nothing was ever answered paused");
            check(!s.sendGate().isPaused(), "and the gate was never paused");
            c.close(); s.close();
        }

        // 4. Session close while a lease is draining: no late paused.
        {
            PadDelivery.Session s = armed(); Out out = new Out();
            Main.QuietPadsControl c = control(s, out);
            VmSendGate.Lease held = s.sendGate().acquire();
            check(held != null, "a send holds a lease");
            c.offer("QUIETPADS v1 pause 3 5000");
            check(waitFor(() -> s.sendGate().isPaused(), WAIT_MS), "worker asserted the pause");
            s.close();
            held.release();
            sleep(NEG_MS);
            check(!out.has("paused"), "no late paused after session close");
            check(s.sendGate().isClosed(), "the session closed the gate");
            check(out.closed.get(), "and the output was closed");
            c.close();
        }

        // 5. Bounded queue overflow ends the experiment rather than answering out of order.
        {
            PadDelivery.Session s = armed(); Out out = new Out();
            Main.QuietPadsControl c = control(s, out);
            VmSendGate.Lease held = s.sendGate().acquire();
            c.offer("QUIETPADS v1 pause 50 5000");
            check(waitFor(() -> s.sendGate().isPaused(), WAIT_MS), "worker is busy draining");
            for (int i = 0; i < 40; i++) c.offer("QUIETPADS v1 resume " + (100 + i));
            check(waitFor(() -> out.closed.get(), WAIT_MS), "queue overflow closes the session");
            held.release();
            c.close(); s.close();
        }

        // 6. A blocked write: offer() still returns promptly, and close() closes the output,
        //    which is what releases the stuck writer - not a manual unblock by the fixture.
        {
            PadDelivery.Session s = armed(); Out out = new Out(); out.block = true;
            Main.QuietPadsControl c = control(s, out);
            c.offer("QUIETPADS v1 pause 20 3000");
            check(out.entered.await(WAIT_MS, TimeUnit.MILLISECONDS), "the worker is inside a blocked write");
            long t0 = System.nanoTime();
            c.offer("QUIETPADS v1 resume 20");
            long ms = (System.nanoTime() - t0) / 1_000_000L;
            check(ms < 500, "offer() returned promptly while the worker was blocked (" + ms + " ms)");
            AtomicBoolean returned = new AtomicBoolean();
            CountDownLatch done = new CountDownLatch(1);
            Thread t = new Thread(() -> { c.close(); returned.set(true); done.countDown(); });
            t.setDaemon(true); t.start();
            check(done.await(WAIT_MS, TimeUnit.MILLISECONDS) && returned.get(), "close() returns while a write is blocked");
            check(out.closed.get(), "close() closed the output, which is what releases the writer");
            t.join(WAIT_MS);
            check(waitFor(() -> !s.sendGate().isPaused() || s.sendGate().isClosed(), WAIT_MS),
                  "sending is not left gated after the blocked write");
            check(!out.has("paused"), "the answer parked in the closed write was not appended");
            s.close();
        }

        // 7. Sequential ordering across trials, and reuse after a successful resume.
        {
            PadDelivery.Session s = armed(); Out out = new Out();
            Main.QuietPadsControl c = control(s, out);
            c.offer("QUIETPADS v1 pause 60 3000");
            check(waitFor(() -> out.has("paused"), WAIT_MS), "trial 60 paused");
            c.offer("QUIETPADS v1 resume 60");
            check(waitFor(() -> out.has("resumed"), WAIT_MS), "trial 60 resumed");
            final String afterResume = out.text();
            c.offer("QUIETPADS v1 pause 61 3000");
            check(waitFor(() -> out.text().length() > afterResume.length(), WAIT_MS), "trial 61 answered");
            check(out.text().startsWith(afterResume), "no earlier answer was rewritten or reordered");
            check(out.text().substring(afterResume.length()).contains("61"), "the new answer is for trial 61");
            check(waitFor(() -> s.sendGate().isPaused(), WAIT_MS), "gate paused again for trial 61");
            c.offer("QUIETPADS v1 resume 61");
            check(waitFor(() -> !s.sendGate().isPaused(), WAIT_MS), "trial 61 resumed");
            c.close(); s.close();
        }

        // 8. A broken output on the answer path closes the session; handle-level error path.
        {
            PadDelivery.Session s = armed(); Out out = new Out(); out.broken = true;
            Main.QuietPadsControl c = control(s, out);
            c.offer("QUIETPADS v1 pause 40 3000");
            check(waitFor(() -> out.closed.get(), WAIT_MS), "an unusable channel closes the session");
            check(waitFor(() -> s.sendGate().isClosed() || !s.sendGate().isPaused(), WAIT_MS),
                  "sending is not left gated after a lost answer");
            check(Main.SAID.stream().anyMatch(x -> x.startsWith("QUIETPADS")), "the failure is recorded via say()");
            c.close(); s.close();
        }

        // 9. An UNEXPECTED interrupt of the controller's own worker, while it waits on the queue,
        //    must terminate the experiment through run()'s finally: gate closed, output closed and
        //    no further answer. Only that one thread is touched, via the controller's own field.
        {
            PadDelivery.Session s = armed(); Out out = new Out();
            Main.QuietPadsControl c = control(s, out);
            c.offer("QUIETPADS v1 pause 70 3000");
            check(waitFor(() -> out.has("paused"), WAIT_MS), "trial 70 paused");
            Thread w = workerOf(c);
            check(w != null, "the controller published its worker thread");
            check(waitFor(() -> { Thread.State st = w.getState();
                                  return st == Thread.State.TIMED_WAITING || st == Thread.State.WAITING; }, WAIT_MS),
                  "the worker is waiting on its queue");
            final String before = out.text();
            w.interrupt();
            check(waitFor(() -> s.sendGate().isClosed(), WAIT_MS), "an interrupted worker closes the gate");
            check(waitFor(() -> out.closed.get(), WAIT_MS), "an interrupted worker closes the output");
            sleep(NEG_MS);
            check(out.text().equals(before), "no further answer after the interrupt");
            c.close(); s.close();
        }

        // Thread.start() failure has no seam through the public API and is NOT tested here.

        if (failures > 0) { System.out.println("\n" + failures + " FAILURE(S)"); System.exit(1); }
        System.out.println("\nquiet pads control verified");
    }
}
