#ifndef SHIELDED_PARWORK_H
#define SHIELDED_PARWORK_H
/* A fork-join helper for the link's ELEMENTWISE field passes.
 *
 * A decode round is serialized on one thread per card: the caller masks the
 * activation, publishes the request, spins for the reply, unmasks it. While
 * that thread works, the engine's decode threadpool is idle -- it has nothing
 * to do until the product comes back. On the 27B the elementwise halves of
 * that serial stretch (encode the activation to field integers, split it into
 * the three byte planes) are several milliseconds of the token, and they are
 * pure map operations over a range with no reduction and no cross-element
 * dependency.
 *
 * The pool is THREAD-LOCAL on purpose: the column split runs card 0 on the
 * caller and the other cards on their own spin workers, and each of those
 * threads needs its own helpers or they would serialize against each other,
 * which is exactly what the split exists to avoid.
 *
 * Off by default. SHIELDED_FIELD_THREADS=<n> (1..8) sets the width, counting
 * the calling thread, so 1 is the old single-threaded path. Cores are not
 * free here -- the decode threadpool and the pad refill threads want them too
 * -- so this is a knob to measure, not a default to assume.
 */
#include <stdatomic.h>
#include <stdint.h>

/* THE PARK/DISPATCH HANDSHAKE PRIMITIVE.
 *
 * The dispatcher stores `gen` then loads `parked`; the parking worker stores
 * `parked` then loads `gen`. If both loads may return the value from before
 * the other's store, the dispatcher decides the worker is awake and does not
 * signal while the worker decides there is no work and sleeps -- a lost
 * wakeup. Release/acquire on two DIFFERENT atomics does not forbid that: it
 * orders each store against loads of the SAME atomic and says nothing about
 * the other. The seq_cst fence puts the four operations in one total order, so
 * at least one side must see the other's store.
 *
 * BOTH halves of the handshake go through this macro, and so does the litmus
 * in test/fixtures/shielded-parwork-litmus.c -- which is the only way that
 * test regresses this code rather than a copy of it. Delete the fence here and
 * the litmus fails. */
#define SH_PAR_PUBLISH(flag, value) do { \
    atomic_store_explicit((flag), (value), memory_order_release); \
    atomic_thread_fence(memory_order_seq_cst); \
} while (0)

typedef void (*sh_par_fn)(void *ctx, int64_t lo, int64_t hi);

/* Width including the caller; 1 means "run it here". Read once per process. */
int  sh_par_width(void);
/* Run fn over [0,n) split into at most sh_par_width() contiguous pieces, none
 * smaller than min_chunk. Returns after every piece has completed. Runs fn
 * directly on this thread when the pool is off, the range is small, or a
 * helper cannot be started -- so a caller never needs a fallback path. */
void sh_par_for(int64_t n, int64_t min_chunk, sh_par_fn fn, void *ctx);

#endif
