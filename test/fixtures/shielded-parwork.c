/* The link's elementwise helper pool: coverage, concurrent use from several
 * owner threads at once (the column split calls it from every card thread),
 * and teardown across repeated thread create/exit cycles.
 *
 * No GPU, model, socket or pad is involved: sh_par_for is a fork-join over a
 * range and nothing else. What matters here is that every element is visited
 * EXACTLY once at every width, that two owner threads do not serialise or
 * corrupt each other, and that helpers are reclaimed when their owner exits.
 * Off by default (width 1), so the width-1 path is a case, not a skip. */
#define _GNU_SOURCE   /* before any header, as shielded-parwork.c itself wants it */
/* The helper's bounded park goes through this counter, so a wait that times
 * out while a dispatch is already waiting for it (gen ahead of done: the
 * wakeup that should have ended the wait never came) is seen directly, not
 * only through the clock. Forwarding only; the wait itself is unchanged. */
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stddef.h>
#include <time.h>
static int counting_timedwait(pthread_cond_t *c, pthread_mutex_t *m, const struct timespec *dl);
#define pthread_cond_timedwait counting_timedwait
#include "../../wasm/ggml-shielded/shielded-parwork.c"
#undef pthread_cond_timedwait
static atomic_long g_missed;
static int counting_timedwait(pthread_cond_t *c, pthread_mutex_t *m, const struct timespec *dl) {
    const int rc = pthread_cond_timedwait(c, m, dl);
    if (rc == ETIMEDOUT) {
        sh_par_worker *w = (sh_par_worker *)((char *)c - offsetof(sh_par_worker, cv));
        if (atomic_load(&w->gen) != atomic_load(&w->done)) atomic_fetch_add(&g_missed, 1);
    }
    return rc;
}

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

enum { N = 100000 };

typedef struct { unsigned char *seen; int64_t sum; } cover;
static void cover_fn(void *ctx, int64_t lo, int64_t hi) {
    cover *c = (cover *)ctx;
    for (int64_t i = lo; i < hi; i++) c->seen[i]++;
}

/* Every index visited exactly once, whatever the width and min_chunk. */
static void coverage(void) {
    unsigned char *seen = calloc(N, 1); assert(seen);
    const int64_t chunks[] = { 1, 7, 1024, N / 3, N, N * 2 };
    for (size_t ci = 0; ci < sizeof chunks / sizeof chunks[0]; ci++) {
        for (int64_t n = 0; n <= N; n = n ? (n < 4096 ? n * 7 + 1 : N) : 1) {
            memset(seen, 0, N);
            cover c = { seen, 0 };
            sh_par_for(n, chunks[ci], cover_fn, &c);
            for (int64_t i = 0; i < n; i++) assert(seen[i] == 1);
            for (int64_t i = n; i < N; i++) assert(seen[i] == 0);
            if (n == N) break;
        }
    }
    /* Degenerate ranges must not dispatch or write anything. */
    memset(seen, 0, N);
    cover c = { seen, 0 };
    sh_par_for(0, 1, cover_fn, &c);
    sh_par_for(-5, 1, cover_fn, &c);
    for (int64_t i = 0; i < N; i++) assert(seen[i] == 0);
    free(seen);
}

/* Several owner threads using the pool at the same time. Each has its own
 * thread-local helpers, so they must neither serialise nor share slices. */
static void *owner_main(void *arg) {
    const int rounds = 200;
    unsigned char *seen = calloc(N, 1); assert(seen);
    for (int r = 0; r < rounds; r++) {
        memset(seen, 0, N);
        cover c = { seen, 0 };
        sh_par_for(N, 1024, cover_fn, &c);
        for (int64_t i = 0; i < N; i++) assert(seen[i] == 1);
    }
    free(seen);
    return arg;
}
static void concurrent_owners(int owners) {
    pthread_t th[8];
    assert(owners <= 8);
    for (int i = 0; i < owners; i++) assert(pthread_create(&th[i], NULL, owner_main, NULL) == 0);
    for (int i = 0; i < owners; i++) assert(pthread_join(th[i], NULL) == 0);
}

/* Helpers belong to the thread that made them and must go with it. Repeated
 * create/exit cycles would otherwise pile up threads: the count after many
 * cycles has to look like the count after one. */
static int thread_count(void) {
    FILE *f = fopen("/proc/self/status", "r");
    if (!f) return -1;
    char line[256]; int n = -1;
    while (fgets(line, sizeof line, f)) if (sscanf(line, "Threads: %d", &n) == 1) break;
    fclose(f);
    return n;
}
static void *short_lived(void *arg) {
    unsigned char seen[512];
    memset(seen, 0, sizeof seen);
    cover c = { seen, 0 };
    sh_par_for((int64_t)sizeof seen, 1, cover_fn, &c);
    for (size_t i = 0; i < sizeof seen; i++) assert(seen[i] == 1);
    return arg;
}
static void teardown(void) {
    pthread_t t;
    for (int i = 0; i < 4; i++) {           /* warm: create the key, settle */
        assert(pthread_create(&t, NULL, short_lived, NULL) == 0);
        assert(pthread_join(t, NULL) == 0);
    }
    const int before = thread_count();
    for (int i = 0; i < 200; i++) {
        assert(pthread_create(&t, NULL, short_lived, NULL) == 0);
        assert(pthread_join(t, NULL) == 0);
    }
    const int after = thread_count();
    if (before > 0 && after > 0) {
        /* A leak here is one helper set per cycle, i.e. hundreds. */
        if (after > before + 2) {
            fprintf(stderr, "parwork: %d threads before, %d after 200 owner cycles\n", before, after);
            assert(!"helper threads outlived their owner");
        }
    }
}

/* THE PARK/DISPATCH BOUNDARY.
 *
 * A hot loop never reaches it: helpers stay spinning, so the dispatcher always
 * finds parked == 0 and correctly skips the signal. The interesting window is
 * the handful of instructions where a helper has decided to park -- it has
 * stored `parked` and is about to re-read `gen` -- while the dispatcher stores
 * `gen` and reads `parked`. Release/acquire on two different atomics does not
 * order those against each other, so both sides could read stale values, and
 * nobody signals.
 *
 * SHIELDED_FIELD_SPINS=0 makes every helper park on its first miss, so every
 * dispatch here lands on that boundary instead of once in a billion. The
 * failure is a LOST WAKEUP, not a wrong answer: sh_par_for would never return.
 * So the check is a watchdog -- a thread that aborts if any dispatch takes
 * absurdly longer than the work in it. Correctness of the slices is still
 * asserted, because a torn dispatch would show up there too. */
static volatile int wd_done = 0;
static volatile int wd_round = -1;
static void *watchdog(void *arg) {
    const int rounds = *(const int *)arg;
    int last = -1, stuck = 0;
    while (!wd_done) {
        struct timespec ts = { 0, 50 * 1000 * 1000L };
        nanosleep(&ts, NULL);
        const int now = wd_round;
        if (now == last && now >= 0) {
            if (++stuck > 200) {          /* >10 s on one dispatch of ~microseconds */
                fprintf(stderr, "parwork: dispatch %d of %d made no progress for 10 s: "
                                "a wakeup was lost at the park boundary\n", now, rounds);
                abort();
            }
        } else { stuck = 0; last = now; }
    }
    return NULL;
}
static void park_boundary(void) {
    if (sh_par_width() < 2) return;            /* no helpers, no boundary */
    enum { ROUNDS = 3000, LEN = 4096 };
    unsigned char *seen = calloc(LEN, 1); assert(seen);
    int rounds = ROUNDS;
    pthread_t wd; assert(pthread_create(&wd, NULL, watchdog, &rounds) == 0);
    atomic_store(&g_missed, 0);
    struct timespec t0; clock_gettime(CLOCK_MONOTONIC, &t0);
    for (int r = 0; r < ROUNDS; r++) {
        wd_round = r;
        memset(seen, 0, LEN);
        cover c = { seen, 0 };
        sh_par_for(LEN, 1, cover_fn, &c);
        for (int64_t i = 0; i < LEN; i++) assert(seen[i] == 1);
        /* Straddle the park: sometimes dispatch immediately (helper still
         * spinning or mid-transition), sometimes after it is certainly
         * parked. With SHIELDED_FIELD_SPINS=0 the first case IS the race. */
        if (r % 3 == 1) { struct timespec ts = { 0, 200 * 1000L }; nanosleep(&ts, NULL); }
        else if (r % 3 == 2) { struct timespec ts = { 0, 2 * 1000 * 1000L }; nanosleep(&ts, NULL); }
    }
    wd_done = 1;
    assert(pthread_join(wd, NULL) == 0);
    struct timespec t1; clock_gettime(CLOCK_MONOTONIC, &t1);
    const double ms = (t1.tv_sec - t0.tv_sec) * 1000.0 + (t1.tv_nsec - t0.tv_nsec) / 1e6;
    /* The helper parks with a BOUNDED wait as defence in depth, so a lost
     * wakeup would be recovered rather than hang -- and would therefore slip
     * past the watchdog above. It cannot slip past the clock: the deliberate
     * sleeps here total ~2.2 s, while one lost wakeup per dispatch would add
     * up to a thousand timeout periods on top. Anything near that means the
     * park/dispatch handshake stopped working even though the answers are
     * still right. */
    const long missed = atomic_load(&g_missed);
    fprintf(stderr, "parwork: park boundary %d dispatches in %.0f ms, %ld park timeouts with a dispatch pending\n",
            ROUNDS, ms, missed);
    /* A timeout can race a dispatch that is about to signal, so allow a few;
     * a lost wakeup misses on (nearly) every parked dispatch. */
    if (missed > ROUNDS / 100) {
        fprintf(stderr, "parwork: %ld of %d dispatches found their helper waiting out the timeout\n", missed, ROUNDS);
        assert(!"park/dispatch handshake is losing wakeups");
    }
    /* The clock is evidence only when the owner and every helper can run at
     * once. With fewer CPUs than width + 1 they time-share, and a slow
     * boundary says nothing about the handshake: width 8 pinned to 4 CPUs
     * took ~15 s whether the park timeout was 20 ms or 2 s, and not one wait
     * timed out with a dispatch pending (measured 2026-09-24; that is how the
     * 4-vCPU CI runner failed here). Coverage and the watchdog above still
     * ran; the fence itself is the litmus test's job at any CPU count. */
    cpu_set_t cpus;
    const int ncpu = sched_getaffinity(0, sizeof cpus, &cpus) == 0 ? CPU_COUNT(&cpus) : 0;
    if (ncpu < sh_par_width() + 1) {
        fprintf(stderr, "parwork: %d CPUs for width %d + owner: boundary timing not judged (the timeout count above still is)\n", ncpu, sh_par_width());
        free(seen);
        return;
    }
    if (ms > 8000.0) {
        fprintf(stderr, "parwork: park boundary took %.0f ms, expected ~2500: wakeups are being lost "
                        "and recovered by the timeout\n", ms);
        assert(!"park/dispatch handshake is losing wakeups");
    }
    free(seen);
}

int main(void) {
    const char *w = getenv("SHIELDED_FIELD_THREADS");
    /* The width is ASSERTED, not merely printed. It was printed only, and a
     * mutant that made sh_par_width() return 1 unconditionally passed this
     * whole file -- every other check is width-agnostic by construction, so
     * nothing downstream noticed. Printing a value is not testing it.
     *
     * Same clamp as sh_par_width_init: absent or unparseable is 1, below 1 is
     * 1, above SH_PAR_MAX is SH_PAR_MAX. */
    const int want = !(w && *w) ? 1
                   : atoi(w) < 1 ? 1
                   : atoi(w) > SH_PAR_MAX ? SH_PAR_MAX
                   : atoi(w);
    const int got = sh_par_width();
    fprintf(stderr, "parwork width=%d (SHIELDED_FIELD_THREADS=%s, expected %d)\n",
            got, w ? w : "unset", want);
    if (got != want) {
        fprintf(stderr, "parwork: width is %d but SHIELDED_FIELD_THREADS=%s asks for %d\n",
                got, w ? w : "unset", want);
        assert(!"sh_par_width did not honour SHIELDED_FIELD_THREADS");
    }
    /* Once means once: a second call must agree with the first. */
    if (sh_par_width() != got) assert(!"sh_par_width is not stable across calls");
    coverage();
    park_boundary();
    concurrent_owners(2);
    concurrent_owners(4);
    teardown();
    coverage();                              /* still correct after teardown */
    fprintf(stderr, "parwork: ok\n");
    return 0;
}
