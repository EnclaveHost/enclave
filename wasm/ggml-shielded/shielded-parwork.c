/* See shielded-parwork.h. Spin-then-park helpers, thread-local per caller. */
/* clock_gettime, CLOCK_MONOTONIC and pthread_condattr_setclock are POSIX, and
 * a strict -std=c11 build (the test fixtures use one) hides them without this.
 * shielded-tee.c does the same, for the same reason. */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "shielded-parwork.h"

#include <pthread.h>
#include <time.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#if defined(__x86_64__) || defined(__i386__)
#include <immintrin.h>
#define SH_PAR_RELAX() _mm_pause()
#else
#define SH_PAR_RELAX() ((void)0)
#endif

#define SH_PAR_MAX 8
/* A decode pass dispatches every ~150 us, but only the exchanges whose range
 * clears min_chunk dispatch at all, so the real gap can be a millisecond. The
 * first attempt at 20000 parked the helpers between dispatches and then paid a
 * futex wake on each one, which was far more than the work being handed over
 * (the run was still going after 16 minutes at 226% CPU). Stay hot instead:
 * the box has idle cores during the exchange, it is the SERIAL half that is
 * short. An idle LINK still parks, after this budget with no traffic. */
#define SH_PAR_SPINS 150000

typedef struct {
    pthread_t        th;
    atomic_ullong    gen, done;
    atomic_int       stop, parked;
    sh_par_fn        fn;
    void            *ctx;
    int64_t          lo, hi;
    pthread_mutex_t  mu;
    pthread_cond_t   cv;
    int              started;
} sh_par_worker;

typedef struct {
    int            n;                      /* helpers, i.e. width - 1 */
    sh_par_worker *w[SH_PAR_MAX - 1];
} sh_par_pool;

static _Thread_local sh_par_pool g_pool;

/* Read once per process. The column split calls this from BOTH card threads,
 * so the lazy initialisation has to be a real one-time init rather than a
 * plain `static int w = -1` tested and assigned without synchronisation --
 * that is a data race even though every racing writer stores the same value. */
static pthread_once_t g_width_once = PTHREAD_ONCE_INIT;
static int g_width = 1;
static unsigned long g_spins = SH_PAR_SPINS;
static void sh_par_width_init(void) {
    const char *e = getenv("SHIELDED_FIELD_THREADS");
    int v = (e && *e) ? atoi(e) : 1;
    if (v < 1) v = 1;
    if (v > SH_PAR_MAX) v = SH_PAR_MAX;
    g_width = v;
    /* Only the park/dispatch regression sets this. 0 parks on the first miss,
     * which is what makes that boundary reachable on purpose instead of once
     * in a billion dispatches. */
    const char *sp = getenv("SHIELDED_FIELD_SPINS");
    if (sp && *sp) { const long n = atol(sp); if (n >= 0) g_spins = (unsigned long)n; }
}
int sh_par_width(void) {
    pthread_once(&g_width_once, sh_par_width_init);
    return g_width;
}

static void *sh_par_main(void *arg) {
    sh_par_worker *w = (sh_par_worker *)arg;
    uint64_t seen = 0;
    for (;;) {
        unsigned long spins = 0;
        for (;;) {
            if (atomic_load_explicit(&w->stop, memory_order_acquire)) return NULL;
            const uint64_t g = atomic_load_explicit(&w->gen, memory_order_acquire);
            if (g != seen) { seen = g; break; }
            if (++spins < g_spins) { SH_PAR_RELAX(); continue; }
            /* Park. The publisher takes the same mutex before it signals, so a
             * generation cannot be missed between the test and the wait. The
             * parked flag is published UNDER the mutex so a dispatch either
             * sees it and signals, or does not and the spin above catches the
             * generation -- a decode pass dispatches ~241 times, and taking a
             * mutex each time to wake a thread that is already spinning costs
             * more than the work being handed to it. */
            pthread_mutex_lock(&w->mu);
            /* Store parked, then fence: see SH_PAR_PUBLISH. The mutex does
             * not close this window, because the dispatcher only takes it
             * AFTER it has decided parked was true. */
            SH_PAR_PUBLISH(&w->parked, 1);
            while (!atomic_load_explicit(&w->stop, memory_order_acquire) &&
                   atomic_load_explicit(&w->gen, memory_order_acquire) == seen) {
                /* Bounded purely as defence in depth: the fences above are
                 * what make this correct. Should a wakeup ever be lost anyway,
                 * this makes it a stall the regression can measure rather than
                 * a hang that takes the whole decode with it. */
                struct timespec dl;
                clock_gettime(CLOCK_MONOTONIC, &dl);
                dl.tv_nsec += 20 * 1000 * 1000L;
                if (dl.tv_nsec >= 1000000000L) { dl.tv_sec++; dl.tv_nsec -= 1000000000L; }
                pthread_cond_timedwait(&w->cv, &w->mu, &dl);
            }
            atomic_store_explicit(&w->parked, 0, memory_order_release);
            pthread_mutex_unlock(&w->mu);
            spins = 0;
        }
        if (atomic_load_explicit(&w->stop, memory_order_acquire)) return NULL;
        w->fn(w->ctx, w->lo, w->hi);
        atomic_store_explicit(&w->done, seen, memory_order_release);
    }
}

static void sh_par_stop(void *arg) {
    sh_par_worker *w = (sh_par_worker *)arg;
    atomic_store_explicit(&w->stop, 1, memory_order_release);
    pthread_mutex_lock(&w->mu); pthread_cond_broadcast(&w->cv); pthread_mutex_unlock(&w->mu);
    pthread_join(w->th, NULL);
    pthread_cond_destroy(&w->cv); pthread_mutex_destroy(&w->mu);
    free(w);
}

/* Helpers die with the thread that made them. */
static _Thread_local int g_pool_registered;
static pthread_key_t g_pool_key;
static pthread_once_t g_pool_once = PTHREAD_ONCE_INIT;
static void sh_par_pool_free(void *unused) {
    (void)unused;
    for (int i = 0; i < g_pool.n; i++) if (g_pool.w[i]) sh_par_stop(g_pool.w[i]);
    g_pool.n = 0;
}
static void sh_par_key_make(void) { pthread_key_create(&g_pool_key, sh_par_pool_free); }

static int sh_par_ensure(int helpers) {
    if (helpers > SH_PAR_MAX - 1) helpers = SH_PAR_MAX - 1;
    while (g_pool.n < helpers) {
        sh_par_worker *w = (sh_par_worker *)calloc(1, sizeof *w);
        if (!w) break;
        pthread_mutex_init(&w->mu, NULL);
        pthread_condattr_t ca;
        pthread_condattr_init(&ca);
        pthread_condattr_setclock(&ca, CLOCK_MONOTONIC);
        pthread_cond_init(&w->cv, &ca);
        pthread_condattr_destroy(&ca);
        atomic_store(&w->gen, 0); atomic_store(&w->done, 0); atomic_store(&w->stop, 0);
        atomic_store(&w->parked, 0);
        if (pthread_create(&w->th, NULL, sh_par_main, w) != 0) {
            pthread_cond_destroy(&w->cv); pthread_mutex_destroy(&w->mu); free(w);
            break;                       /* fewer helpers than asked: still correct */
        }
        g_pool.w[g_pool.n++] = w;
    }
    if (!g_pool_registered && g_pool.n) {
        pthread_once(&g_pool_once, sh_par_key_make);
        pthread_setspecific(g_pool_key, (void *)1);
        g_pool_registered = 1;
    }
    return g_pool.n;
}

void sh_par_for(int64_t n, int64_t min_chunk, sh_par_fn fn, void *ctx) {
    if (n <= 0) return;
    if (min_chunk < 1) min_chunk = 1;
    int parts = sh_par_width();
    if (parts > 1) {
        const int64_t fit = n / min_chunk;
        if (fit < parts) parts = (int)(fit < 1 ? 1 : fit);
    }
    if (parts <= 1) { fn(ctx, 0, n); return; }

    const int helpers = sh_par_ensure(parts - 1);
    parts = helpers + 1;
    if (parts <= 1) { fn(ctx, 0, n); return; }

    const int64_t per = (n + parts - 1) / parts;
    uint64_t want[SH_PAR_MAX - 1];
    int live = 0;
    for (int i = 0; i < helpers; i++) {
        const int64_t lo = per * (i + 1), hi = lo + per < n ? lo + per : n;
        if (lo >= n) break;
        sh_par_worker *w = g_pool.w[i];
        w->fn = fn; w->ctx = ctx; w->lo = lo; w->hi = hi;
        want[i] = atomic_load_explicit(&w->gen, memory_order_relaxed) + 1;
        /* The other half of the handshake: see SH_PAR_PUBLISH. One mfence
         * per helper per dispatch, against work measured in microseconds. */
        SH_PAR_PUBLISH(&w->gen, want[i]);
        if (atomic_load_explicit(&w->parked, memory_order_acquire)) {
            pthread_mutex_lock(&w->mu); pthread_cond_signal(&w->cv); pthread_mutex_unlock(&w->mu);
        }
        live++;
    }
    fn(ctx, 0, per < n ? per : n);
    for (int i = 0; i < live; i++) {
        sh_par_worker *w = g_pool.w[i];
        while (atomic_load_explicit(&w->done, memory_order_acquire) < want[i]) SH_PAR_RELAX();
    }
}
