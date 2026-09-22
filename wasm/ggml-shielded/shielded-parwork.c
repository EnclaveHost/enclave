/* See shielded-parwork.h. Spin-then-park helpers, thread-local per caller. */
#include "shielded-parwork.h"

#include <pthread.h>
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

int sh_par_width(void) {
    static int w = -1;
    if (w < 0) {
        const char *e = getenv("SHIELDED_FIELD_THREADS");
        int v = (e && *e) ? atoi(e) : 1;
        if (v < 1) v = 1;
        if (v > SH_PAR_MAX) v = SH_PAR_MAX;
        w = v;
    }
    return w;
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
            if (++spins < SH_PAR_SPINS) { SH_PAR_RELAX(); continue; }
            /* Park. The publisher takes the same mutex before it signals, so a
             * generation cannot be missed between the test and the wait. The
             * parked flag is published UNDER the mutex so a dispatch either
             * sees it and signals, or does not and the spin above catches the
             * generation -- a decode pass dispatches ~241 times, and taking a
             * mutex each time to wake a thread that is already spinning costs
             * more than the work being handed to it. */
            pthread_mutex_lock(&w->mu);
            atomic_store_explicit(&w->parked, 1, memory_order_release);
            while (!atomic_load_explicit(&w->stop, memory_order_acquire) &&
                   atomic_load_explicit(&w->gen, memory_order_acquire) == seen)
                pthread_cond_wait(&w->cv, &w->mu);
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
        pthread_cond_init(&w->cv, NULL);
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
        atomic_store_explicit(&w->gen, want[i], memory_order_release);
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
