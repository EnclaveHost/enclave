package host.enclave.anchor.avf;

import java.util.concurrent.atomic.AtomicBoolean;

/** Cooperative drain/resume gate for app -> pVM PADS_PORT sends. DEFAULT OFF.
 *
 *  Touches no pad, key, authentication, one-time-pad rule, prefetch file, prune, importer,
 *  receiver or dealer. It decides only whether the app may START a new pads-port send; a send
 *  holding a lease always runs to completion including header reply, body, ACK and close.
 *
 *      VmSendGate.Lease lease = gate.acquire();      // BEFORE connect; WAITS while paused
 *      if (lease == null) { ... }                    // closed or interrupted: give up, no lease
 *      try { ...connect, header, body, ack... }
 *      finally { pfd.close(); lease.release(); }     // release AFTER the descriptor is closed
 *
 *  acquire() BLOCKS while paused rather than failing, so a pause is never observable as an I/O
 *  error and cannot mutate any fallback state. Null means close() or interruption only.
 *
 *  PAUSE REQUESTS ARE GENERATIONAL. resume() and close() bump the generation, cancelling a drain
 *  waiting under an older one; a cancelled drain returns false and never re-asserts a pause it no
 *  longer owns. On timeout or interruption the gate is restored to OPEN unless closed, so a failed
 *  drain never strands senders. Only a SUCCESSFUL drain leaves the pause in force.
 *
 *  Leases are tokens with idempotent release, so a double release cannot decrement another
 *  sender's count and let a drain declare quiet while a send is live.
 *
 *  Holds only its own monitor, and never across a connect, read, write or close. No thread and no
 *  timer of its own: every wait is bounded by the caller's deadline, and liveness beyond that is
 *  the caller's (the app helper's, and the GUI's whole-run budget). */
final class VmSendGate {

    static final long MAX_DRAIN_MS = 45000;

    static VmSendGate disabled() { return new VmSendGate(false); }
    static VmSendGate enabled()  { return new VmSendGate(true); }

    /** One granted send. release() is idempotent; only the first call counts. */
    final class Lease {
        private final AtomicBoolean done = new AtomicBoolean();
        private Lease() { }
        void release() {
            if (!done.compareAndSet(false, true)) return;
            synchronized (lock) {
                inFlight--;
                if (inFlight == 0) lock.notifyAll();
            }
        }
        boolean released() { return done.get(); }
    }

    private final boolean enabled;
    private final Object lock = new Object();
    private boolean paused, closed, draining;
    private long pauseGen;
    private int inFlight;
    private long granted, waits, pauses, drains, cancels, timeouts, lateExpiries;

    private VmSendGate(boolean enabled) { this.enabled = enabled; }

    boolean isEnabled() { return enabled; }

    /** Take a send lease, waiting while paused.
     *  @return a lease, or null if the gate closed or this thread was interrupted (flag restored). */
    Lease acquire() {
        synchronized (lock) {
            boolean waited = false;
            while (enabled && paused && !closed) {
                if (!waited) { waits++; waited = true; }
                try { lock.wait(); }
                catch (InterruptedException e) { Thread.currentThread().interrupt(); return null; }
            }
            if (closed) return null;
            inFlight++; granted++;
            return new Lease();
        }
    }

    /** Non-blocking variant. Returns null when paused or closed. */
    Lease tryAcquire() {
        synchronized (lock) {
            if (closed || (enabled && paused)) return null;
            inFlight++; granted++;
            return new Lease();
        }
    }

    /** Pause new sends and wait for in-flight sends to finish. Called by the ASYNC app helper,
     *  never by the control reader.
     *
     *  The deadline is fixed at entry, BEFORE the monitor is contended, and expiry is tested at the
     *  top of every iteration BEFORE the zero-in-flight test. So a late release, or a drainer
     *  descheduled past its deadline, can never yield a success after the deadline has passed.
     *
     *  @return true only if no lease is active AND the pause this call owns is still in force.
     *          false for: disabled, closed, an already-interrupted caller, already paused, a
     *          concurrent drain, cancellation by resume()/close(), timeout, or interruption. */
    boolean requestPauseAndDrain(long timeoutMs) {
        if (timeoutMs <= 0 || timeoutMs > MAX_DRAIN_MS) throw new IllegalArgumentException("drain timeout out of range");
        // Fixed before any lock is contended: waiting for the monitor cannot buy extra time.
        final long deadline = System.nanoTime() + timeoutMs * 1_000_000L;
        // An already-interrupted caller must not be granted a pause it cannot wait on: its first
        // wait would throw immediately and it could otherwise report a quiet it never observed.
        if (Thread.currentThread().isInterrupted()) return false;
        boolean interrupted = false;
        try {
            synchronized (lock) {
                if (!enabled || closed) return false;
                if (draining) return false;
                if (paused)   return false;
                draining = true;
                final long mine = ++pauseGen;
                paused = true; pauses++;
                lock.notifyAll();
                try {
                    while (true) {
                        if (closed) return false;
                        if (pauseGen != mine) { cancels++; return false; }
                        final long left = deadline - System.nanoTime();
                        if (left <= 0) {                       // expiry FIRST, before the count
                            if (inFlight == 0) lateExpiries++; // would have been a late success
                            timeouts++; reopen(mine); return false;
                        }
                        if (inFlight == 0) { drains++; return true; }
                        try { lock.wait(left / 1_000_000L, (int) (left % 1_000_000L)); }
                        catch (InterruptedException e) { interrupted = true; reopen(mine); return false; }
                    }
                } finally {
                    draining = false;
                    lock.notifyAll();
                }
            }
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    /** Restore the open state after a FAILED drain, only if this call still owns the pause.
     *  Caller holds the lock. */
    private void reopen(long mine) {
        if (closed || pauseGen != mine) return;
        paused = false;
        pauseGen++;
        lock.notifyAll();
    }

    /** Allow new sends again, cancelling any drain still waiting. Idempotent. */
    void resume() {
        synchronized (lock) { paused = false; pauseGen++; lock.notifyAll(); }
    }

    /** Terminal. Wakes every waiter, refuses future leases, cancels a waiting drain. Does NOT
     *  close, interrupt or disturb an in-flight send: that stays Session.stop()'s job. */
    void close() {
        synchronized (lock) { closed = true; pauseGen++; lock.notifyAll(); }
    }

    boolean isPaused()   { synchronized (lock) { return paused; } }
    boolean isClosed()   { synchronized (lock) { return closed; } }
    boolean isDraining() { synchronized (lock) { return draining; } }
    int inFlight()       { synchronized (lock) { return inFlight; } }

    /** Counters only: no name, byte count, pad or secret. */
    String stats() {
        synchronized (lock) {
            return "enabled=" + enabled + " paused=" + paused + " closed=" + closed
                 + " in_flight=" + inFlight + " granted=" + granted + " waited=" + waits
                 + " pauses=" + pauses + " drains=" + drains + " cancelled=" + cancels
                 + " timeouts=" + timeouts + " late_expiries=" + lateExpiries;
        }
    }
}
