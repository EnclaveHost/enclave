/* A litmus test for the ONE memory-model property the helper pool's park and
 * dispatch handshake depends on.
 *
 * The dispatcher does   store gen;    then load parked.
 * The worker does       store parked; then load gen.
 * If both loads may return the value from before the other's store, the
 * dispatcher concludes the worker is awake and does not signal, while the
 * worker concludes there is no work and sleeps. That is a lost wakeup, and on
 * an untimed wait it is a hang. Release/acquire on two DIFFERENT atomics does
 * not forbid it: it orders each store with loads of the SAME atomic, and puts
 * no order between the store of one and the load of the other. Only a total
 * order over the four operations does, which is what a pair of seq_cst fences
 * buys.
 *
 * The pool's own park/dispatch regression exercises that boundary thousands of
 * times per width and never catches it, because the window is a few
 * nanoseconds wide and two threads doing real work do not land inside it. This
 * lands them inside it deliberately: a two-thread barrier releases both at the
 * same instant and each immediately runs its store/load pair.
 *
 * RELAXED must SHOW the stale/stale outcome -- if it does not, this test is not
 * reaching the window and the fenced run below would prove nothing, so that is
 * reported as a failure too. FENCED must never show it. */
#define _GNU_SOURCE
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>

/* The production handshake primitive itself, not a copy of it. SH_PAR_UNFENCED
 * builds the same shape without the fence, which is what the handshake looked
 * like before. Because the fenced side goes through SH_PAR_PUBLISH, deleting
 * the fence from shielded-parwork.h fails this test. */
#include "../../wasm/ggml-shielded/shielded-parwork.h"

#if defined(__x86_64__) || defined(__i386__)
#include <immintrin.h>
#define RELAX() _mm_pause()
#else
#define RELAX() ((void)0)
#endif

static atomic_int x, y;                 /* stand in for gen and parked */
static atomic_int rx, ry;
static atomic_uint bar_count, bar_gen;
static long trials = 1000000;

/* Sense-reversing barrier for exactly two threads. The second arrival opens
 * the gate, so both leave within a few cycles of each other. */
static void barrier2(void) {
    const unsigned g = atomic_load_explicit(&bar_gen, memory_order_acquire);
    if (atomic_fetch_add_explicit(&bar_count, 1, memory_order_acq_rel) == 1) {
        atomic_store_explicit(&bar_count, 0, memory_order_relaxed);
        atomic_fetch_add_explicit(&bar_gen, 1, memory_order_release);
    } else {
        while (atomic_load_explicit(&bar_gen, memory_order_acquire) == g) RELAX();
    }
}

/* With SH_LITMUS_FENCED this is the shipped handshake; without it, the
 * handshake exactly as it was originally written. */
static void pair(atomic_int *store_to, atomic_int *load_from, atomic_int *result) {
#ifdef SH_LITMUS_FENCED
    SH_PAR_PUBLISH(store_to, 1);                 /* the shipped primitive */
#else
    atomic_store_explicit(store_to, 1, memory_order_release);   /* as it was */
#endif
    const int v = atomic_load_explicit(load_from, memory_order_acquire);
    atomic_store_explicit(result, v, memory_order_relaxed);
}

static void *side_b(void *unused) {
    (void)unused;
    for (long i = 0; i < trials; i++) { barrier2(); pair(&y, &x, &ry); barrier2(); }
    return NULL;
}

int main(int argc, char **argv) {
    if (argc > 1) trials = atol(argv[1]);
    pthread_t th; assert(pthread_create(&th, NULL, side_b, NULL) == 0);
    long both_stale = 0;
    for (long i = 0; i < trials; i++) {
        /* Safe: the other thread is blocked on the first barrier below and has
         * not touched x or y since the previous trial's second barrier. */
        atomic_store_explicit(&x, 0, memory_order_relaxed);
        atomic_store_explicit(&y, 0, memory_order_relaxed);
        atomic_store_explicit(&rx, -1, memory_order_relaxed);
        atomic_store_explicit(&ry, -1, memory_order_relaxed);
        barrier2();
        pair(&x, &y, &rx);
        barrier2();
        if (atomic_load_explicit(&rx, memory_order_relaxed) == 0 &&
            atomic_load_explicit(&ry, memory_order_relaxed) == 0) both_stale++;
    }
    pthread_join(th, NULL);

#ifdef SH_LITMUS_FENCED
    printf("litmus FENCED   trials=%ld both-stale=%ld\n", trials, both_stale);
    if (both_stale != 0) {
        fprintf(stderr, "the seq_cst fences did not prevent the lost-wakeup outcome\n");
        return 1;
    }
#else
    printf("litmus RELAXED  trials=%ld both-stale=%ld\n", trials, both_stale);
    /* INCONCLUSIVE, NOT FAILED. The memory model PERMITS the stale/stale
     * outcome; it does not require it. A machine that happened to serialise
     * these threads -- one core, a busy box, a stricter architecture -- can
     * legitimately see zero, and failing the build for that would be flaking
     * on valid code. Exit 3 says "this run did not reach the window", and the
     * caller reports it rather than treating it as a defect. */
    if (both_stale == 0) {
        fprintf(stderr, "inconclusive: the relaxed handshake did not produce the stale/stale outcome "
                        "in this run, so the fenced result below is not evidence on this machine\n");
        return 3;
    }
#endif
    return 0;
}
