/* Fixture for the default-off parallel pad-check preparation.
 *
 * Bounded by design. The full Cartesian product of kernels x thread counts x
 * create-failure masks x CPU cases runs ONLY on one small matrix (K=1040,
 * N=17). Large row counts crossing the 32768 row-chunk boundary and the signed
 * extrema each use a small deliberate set of dispatches, because repeating the
 * Cartesian product there buys no new code path and costs billions of MACs.
 *
 * Executes nothing from the engine: no pads, no link, no model, no network, no
 * CSPRNG, no u = rW check, no calibration, no frozen input. Deterministic public
 * inputs only. Assertions are plain runtime checks, not assert(), so no
 * optimisation level or -DNDEBUG can disable them. Exit status 0 = all passed. */

#define SH_PAD_PARALLEL_TEST_HOOKS 1
#include "shielded-pad-parallel.h"
#include "shielded-tee.h"   /* SH_FV_S_RANGE: the range production draws s from */

#include <inttypes.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

unsigned sh_pad_par_test_fail_mask = 0u;
int      sh_pad_par_test_join_fails = 0;
long     sh_pad_par_test_ncpu = 0;
int      sh_pad_par_test_nt = 0;
int      sh_pad_par_test_create_calls = 0;
int      sh_pad_par_test_created = 0;
int      sh_pad_par_test_inline_jobs = 0;

static int failures = 0;
static void check(int ok, const char *what) {
    if (!ok) { failures++; printf("FAIL %s\n", what); }
}

static uint64_t rng_state = 0x9E3779B97F4A7C15ull;
static uint64_t rng(void) {
    uint64_t z = (rng_state += 0x9E3779B97F4A7C15ull);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
}

/* Independent reference, written fresh here so the candidate is never compared
 * against itself. */
static void reference(const int8_t *w, int64_t K, int64_t N, const int32_t *s, int32_t *st) {
    for (int64_t k = 0; k < K; k++) {
        __int128 acc = 0;
        for (int64_t j = 0; j < N; j++) acc += (__int128)w[j * K + k] * s[j];
        int64_t v = (int64_t)(acc % SH_M_MOD); if (v < 0) v += SH_M_MOD;
        st[k] = (int32_t)v;
    }
}

/* 0x5A5A5A5A exceeds SH_M_MOD (< 2^24 by the header's static assert), so an
 * element the dispatch fails to write is guaranteed to mismatch. */
enum { POISON = 0x5A5A5A5A, GUARD_N = 64, GUARD = 0x3C3C3C3C };

/* The clamp the implementation is required to apply, written out independently
 * so an always-serial implementation cannot pass. */
static int expected_nt(int request, long ncpu_case, int64_t K) {
    const long ncpu = ncpu_case ? ncpu_case : sysconf(_SC_NPROCESSORS_ONLN);
    int nt = request < 1 ? 1 : request;
    if (nt > SH_PAD_PAR_MAX_THREADS) nt = SH_PAD_PAR_MAX_THREADS;
    if (ncpu < 1) nt = 1;
    else if ((long)nt > ncpu) nt = (int)ncpu;
    const int64_t tiles = K / SH_PAD_PAR_TILE + (K % SH_PAD_PAR_TILE != 0);
    if ((int64_t)nt > tiles) nt = (int)tiles;
    return nt < 1 ? 1 : nt;
}

static int popcount_low(unsigned mask, int n) {
    int c = 0;
    for (int i = 0; i < n; i++) if ((mask >> i) & 1u) c++;
    return c;
}

/* One dispatch with poison + guards, output compared to ref, and the thread
 * bookkeeping asserted. */
static void one_run(const int8_t *w, int64_t K, int64_t N, const int32_t *s,
                    const int32_t *ref, int32_t *buf,
                    int tiled, int threads, unsigned mask, long ncpu, const char *label) {
    int32_t *st = buf + GUARD_N;
    for (int64_t i = 0; i < K + 2 * GUARD_N; i++) buf[i] = POISON;
    for (int g = 0; g < GUARD_N; g++) { buf[g] = GUARD; buf[GUARD_N + K + g] = GUARD; }

    sh_pad_par_test_fail_mask = mask;
    sh_pad_par_test_ncpu = ncpu;
    sh_pad_par_test_nt = -1;
    sh_pad_par_test_create_calls = sh_pad_par_test_created = sh_pad_par_test_inline_jobs = 0;

    sh_pad_par_stats ps;
    memset(&ps, 0xA5, sizeof ps);   /* poisoned: every reported field must be written */
    sh_pad_check_prepare_dispatch(w, K, N, s, st, tiled, threads, &ps);

    sh_pad_par_test_fail_mask = 0u;
    sh_pad_par_test_ncpu = 0;

    char what[224];
    snprintf(what, sizeof what, "%s tiled=%d req=%d failmask=0x%X ncpu=%ld",
             label, tiled, threads, mask, ncpu);
    check(memcmp(st, ref, (size_t)K * sizeof *ref) == 0, what);

    int guards_ok = 1;
    for (int g = 0; g < GUARD_N; g++)
        if (buf[g] != GUARD || buf[GUARD_N + K + g] != GUARD) guards_ok = 0;
    check(guards_ok, "guard elements intact (no write outside [0,K))");

    /* Dispatch bookkeeping: this is what an always-serial implementation fails. */
    const int want = expected_nt(threads, ncpu, K);
    const int want_fail = want > 1 ? popcount_low(mask, want) : 0;
    char dw[512];   /* holds `what` plus the counter text */
    snprintf(dw, sizeof dw, "%s: effective nt %d == expected %d", what, sh_pad_par_test_nt, want);
    check(sh_pad_par_test_nt == want, dw);
    if (want > 1) {
        snprintf(dw, sizeof dw, "%s: %d create attempts == nt %d", what, sh_pad_par_test_create_calls, want);
        check(sh_pad_par_test_create_calls == want, dw);
        snprintf(dw, sizeof dw, "%s: created %d + inline %d == nt %d",
                 what, sh_pad_par_test_created, sh_pad_par_test_inline_jobs, want);
        check(sh_pad_par_test_created + sh_pad_par_test_inline_jobs == want, dw);
        snprintf(dw, sizeof dw, "%s: inline %d == failed creates %d", what, sh_pad_par_test_inline_jobs, want_fail);
        check(sh_pad_par_test_inline_jobs == want_fail, dw);
    } else {
        snprintf(dw, sizeof dw, "%s: serial path creates no thread", what);
        check(sh_pad_par_test_create_calls == 0, dw);
    }

    /* The REPORTED diagnostic must agree with the injected hooks, field by
     * field. This is what proves the profile line describes what really ran and
     * is not an echo of the requested limit. */
    const long want_ncpu = ncpu ? ncpu : sysconf(_SC_NPROCESSORS_ONLN);
    snprintf(dw, sizeof dw, "%s: stats.requested %d == %d", what, ps.requested, threads);
    check(ps.requested == threads, dw);
    snprintf(dw, sizeof dw, "%s: stats.raw_ncpu %ld == injected %ld", what, ps.raw_ncpu, want_ncpu);
    check(ps.raw_ncpu == want_ncpu, dw);
    snprintf(dw, sizeof dw, "%s: stats.ncpu_unknown %d (raw %ld)", what, ps.ncpu_unknown, ps.raw_ncpu);
    check(ps.ncpu_unknown == (ps.raw_ncpu < 1), dw);
    snprintf(dw, sizeof dw, "%s: stats.effective_jobs %d == %d", what, ps.effective_jobs, want);
    check(ps.effective_jobs == want, dw);
    snprintf(dw, sizeof dw, "%s: stats.create_attempts %d == %d", what, ps.create_attempts, want > 1 ? want : 0);
    check(ps.create_attempts == (want > 1 ? want : 0), dw);
    snprintf(dw, sizeof dw, "%s: stats.created %d == %d", what, ps.created, want > 1 ? want - want_fail : 0);
    check(ps.created == (want > 1 ? want - want_fail : 0), dw);
    snprintf(dw, sizeof dw, "%s: stats.inline_jobs %d == %d", what, ps.inline_jobs, want > 1 ? want_fail : 1);
    check(ps.inline_jobs == (want > 1 ? want_fail : 1), dw);
    snprintf(dw, sizeof dw, "%s: stats.created+inline %d == jobs %d", what, ps.created + ps.inline_jobs, want);
    check(ps.created + ps.inline_jobs == want, dw);
    snprintf(dw, sizeof dw, "%s: stats dimensions K/N/tiles", what);
    check(ps.K == K && ps.N == N && ps.tiles == K / SH_PAD_PAR_TILE + (K % SH_PAD_PAR_TILE != 0), dw);
    /* The reported counts must agree with the independent hook counters too. */
    snprintf(dw, sizeof dw, "%s: stats agrees with hook counters", what);
    check(ps.effective_jobs == sh_pad_par_test_nt &&
          ps.create_attempts == sh_pad_par_test_create_calls &&
          ps.created == sh_pad_par_test_created &&
          ps.inline_jobs == (want > 1 ? sh_pad_par_test_inline_jobs : 1), dw);
}

/* The serial limit-1 case must report jobs=1, created=0, inline=1 - the shape a
 * reader needs in order to tell "ran serially" apart from "did not report". */
static void test_serial_stats_shape(void) {
    const int64_t K = 512, N = 5;
    int8_t *w = (int8_t *)calloc((size_t)(K * N), 1);
    int32_t *s = (int32_t *)calloc((size_t)N, sizeof *s);
    int32_t *st = (int32_t *)calloc((size_t)K, sizeof *st);
    if (!w || !s || !st) { failures++; printf("FAIL serial stats: out of memory\n"); goto done; }
    for (int64_t j = 0; j < N; j++) s[j] = 1;
    for (int u = 0; u < 2; u++) {                 /* real sysconf, then UNKNOWN */
        sh_pad_par_stats ps;
        memset(&ps, 0xA5, sizeof ps);
        sh_pad_par_test_ncpu = u ? -1 : 0;
        sh_pad_check_prepare_dispatch(w, K, N, s, st, 1, 1, &ps);
        sh_pad_par_test_ncpu = 0;
        check(ps.effective_jobs == 1 && ps.create_attempts == 0 && ps.created == 0 && ps.inline_jobs == 1,
              "serial limit 1 reports jobs=1 created=0 inline=1");
        check(ps.ncpu_unknown == (u ? 1 : 0), "serial limit 1 reports UNKNOWN cpu as unknown, not zero");
    }
    /* sh_pad_par_stats_serial is the path pad_check_prepare uses when it never
     * reaches the dispatch at all; it must report the same shape. */
    sh_pad_par_stats sp;
    memset(&sp, 0xA5, sizeof sp);
    sh_pad_par_test_ncpu = -1;
    sh_pad_par_stats_serial(&sp, 1, K, N);
    sh_pad_par_test_ncpu = 0;
    check(sp.requested == 1 && sp.effective_jobs == 1 && sp.create_attempts == 0 &&
          sp.created == 0 && sp.inline_jobs == 1 && sp.ncpu_unknown == 1 && sp.raw_ncpu == -1,
          "stats_serial reports jobs=1 created=0 inline=1 with UNKNOWN cpu");
    printf("ok   serial limit-1 diagnostic shape\n");
done:
    free(w); free(s); free(st);
}

/* The diagnostic knob is strict: absent is off, only "0"/"1" are accepted, and
 * anything else must be rejected (pad_check_prepare turns that into SH_ERR_PROTO)
 * rather than being read as "profiling was off". */
static void test_profile_flag_parsing(void) {
    int on = 9;
    check(sh_pad_par_parse_flag(NULL, &on) == SH_PAD_PAR_OK && on == 0, "profile flag absent => off");
    check(sh_pad_par_parse_flag("0", &on) == SH_PAD_PAR_OK && on == 0, "profile flag 0 => off");
    check(sh_pad_par_parse_flag("1", &on) == SH_PAD_PAR_OK && on == 1, "profile flag 1 => on");
    static const char *bad[] = { "", "2", "01", "10", "1 ", " 1", "on", "true", "yes", "-1", "1\n" };
    for (size_t i = 0; i < sizeof bad / sizeof *bad; i++) {
        char what[64]; snprintf(what, sizeof what, "profile flag rejected: \"%s\"", bad[i]);
        on = 9;
        check(sh_pad_par_parse_flag(bad[i], &on) == SH_PAD_PAR_BAD_KNOB && on == 0, what);
    }
    printf("ok   profile flag parsing (strict 0/1)\n");
}

/* ---------------------------------------------------------------- shapes */

typedef struct { int8_t *w; int32_t *s, *ref, *buf; int64_t K, N; } matrix;

static int matrix_make(matrix *m, int64_t K, int64_t N) {
    m->K = K; m->N = N;
    m->w   = (int8_t *)malloc((size_t)(K * N));
    m->s   = (int32_t *)malloc((size_t)N * sizeof *m->s);
    m->ref = (int32_t *)malloc((size_t)K * sizeof *m->ref);
    m->buf = (int32_t *)malloc(((size_t)K + 2 * GUARD_N) * sizeof *m->buf);
    return m->w && m->s && m->ref && m->buf;
}
static void matrix_free(matrix *m) { free(m->w); free(m->s); free(m->ref); free(m->buf); }

enum s_mode { S_RANDOM, S_FIELD_LO, S_FIELD_HI, S_INT32_MIN, S_INT32_MAX, S_INT32_ALT };
enum w_mode { W_RANDOM, W_MIN, W_MAX, W_ALT };

static void matrix_fill(matrix *m, enum w_mode wm, enum s_mode sm) {
    for (int64_t i = 0; i < m->K * m->N; i++) {
        switch (wm) {
        case W_RANDOM: m->w[i] = (int8_t)(rng() & 0xFF); break;   /* covers INT8_MIN..INT8_MAX */
        case W_MIN:    m->w[i] = INT8_MIN; break;
        case W_MAX:    m->w[i] = INT8_MAX; break;
        default:       m->w[i] = (i & 1) ? INT8_MAX : INT8_MIN; break;
        }
    }
    for (int64_t j = 0; j < m->N; j++) {
        switch (sm) {
        case S_RANDOM:     m->s[j] = 1 + (int32_t)(rng() % (uint64_t)(SH_FV_S_RANGE - 1)); break;
        case S_FIELD_LO:   m->s[j] = 1; break;
        case S_FIELD_HI:   m->s[j] = (int32_t)(SH_FV_S_RANGE - 1); break;
        case S_INT32_MIN:  m->s[j] = INT32_MIN; break;
        case S_INT32_MAX:  m->s[j] = INT32_MAX; break;
        default:           m->s[j] = (j & 1) ? INT32_MAX : INT32_MIN; break;
        }
    }
    reference(m->w, m->K, m->N, m->s, m->ref);
}

/* The one exhaustive matrix: small enough that 2 x 6 x 6 x 4 dispatches are free.
 * K=1040 is a ragged K (8 tiles + 16 columns), N=17. */
static void test_cartesian_small(void) {
    matrix m;
    if (!matrix_make(&m, 1040, 17)) { failures++; printf("FAIL cartesian: out of memory\n"); return; }
    matrix_fill(&m, W_RANDOM, S_RANDOM);

    static const int threads[] = { 1, 2, 3, 5, 8, 16 };
    /* 0 none, 0x1 first, 0x2 second, 0xA scattered, 0xFFFE all but first, 0xFFFF all. */
    static const unsigned masks[] = { 0u, 0x1u, 0x2u, 0xAu, 0xFFFEu, 0xFFFFu };
    /* 0 real sysconf, 1 single CPU, 4 clamp below request, -1 sysconf failure. */
    static const long ncpus[] = { 0, 1, 4, -1 };

    for (int tiled = 0; tiled <= 1; tiled++)
        for (size_t ti = 0; ti < sizeof threads / sizeof *threads; ti++)
            for (size_t mi = 0; mi < sizeof masks / sizeof *masks; mi++)
                for (size_t ci = 0; ci < sizeof ncpus / sizeof *ncpus; ci++)
                    one_run(m.w, m.K, m.N, m.s, m.ref, m.buf,
                            tiled, threads[ti], masks[mi], ncpus[ci], "cartesian K=1040 N=17");
    printf("ok   full cartesian on K=1040 N=17 (%d dispatches)\n", 2 * 6 * 6 * 4);
    matrix_free(&m);
}

/* A deliberate handful per large/extreme shape: serial reference, serial tiled,
 * 2-thread tiled, 4-thread reference. No CPU or failure-mask repeats here. */
static void selected_set(matrix *m, const char *label) {
    one_run(m->w, m->K, m->N, m->s, m->ref, m->buf, 0, 1, 0u, 0, label);
    one_run(m->w, m->K, m->N, m->s, m->ref, m->buf, 1, 1, 0u, 0, label);
    one_run(m->w, m->K, m->N, m->s, m->ref, m->buf, 1, 2, 0u, 8, label);
    one_run(m->w, m->K, m->N, m->s, m->ref, m->buf, 0, 4, 0u, 8, label);
}

static void test_shape(int64_t K, int64_t N, enum w_mode wm, enum s_mode sm, const char *label) {
    matrix m;
    if (!matrix_make(&m, K, N)) { failures++; printf("FAIL %s: out of memory\n", label); return; }
    matrix_fill(&m, wm, sm);
    selected_set(&m, label);
    printf("ok   %s (K=%" PRId64 " N=%" PRId64 ", 4 dispatches)\n", label, K, N);
    matrix_free(&m);
}

static void test_knob_parsing(void) {
    int v = 0;
    static const char *good[] = { "1", "2", "9", "10", "16" };
    static const int   good_v[] = { 1, 2, 9, 10, 16 };
    for (size_t i = 0; i < sizeof good / sizeof *good; i++) {
        char what[64]; snprintf(what, sizeof what, "knob accepted: \"%s\"", good[i]);
        check(sh_pad_par_parse_threads(good[i], &v) == SH_PAD_PAR_OK && v == good_v[i], what);
    }
    check(sh_pad_par_parse_threads(NULL, &v) == SH_PAD_PAR_OK && v == 1, "absent knob => 1");
    static const char *bad[] = { "", "0", "00", "08", "004", "016", "17", "20", "99", "-1",
                                 "+2", " 2", "2 ", "2x", "x", "1.5", "true", "1\n" };
    for (size_t i = 0; i < sizeof bad / sizeof *bad; i++) {
        char what[64]; snprintf(what, sizeof what, "knob rejected: \"%s\"", bad[i]);
        v = 99;
        check(sh_pad_par_parse_threads(bad[i], &v) == SH_PAD_PAR_BAD_KNOB && v == 1, what);
    }
}

/* Partition arithmetic only - no matrix is allocated, so K may be enormous. */
static void test_partition(void) {
    static const int64_t Ks[] = { 16, 128, 129, 144, 256, 400, 1040, 2048, 7168,
                                  INT64_MAX / 128 * 128, INT64_MAX - 1, INT64_MAX };
    for (size_t i = 0; i < sizeof Ks / sizeof *Ks; i++) {
        const int64_t K = Ks[i];
        check(sh_pad_par_tiles(K) == K / 128 + (K % 128 != 0), "tile count matches ceiling division");
        check(sh_pad_par_tiles(K) > 0, "tile count positive");
        for (int nt = 1; nt <= SH_PAD_PAR_MAX_THREADS; nt++) {
            int64_t prev = sh_pad_par_bound(K, 0, nt);
            check(prev == 0, "partition starts at 0");
            for (int t = 1; t <= nt; t++) {
                const int64_t b = sh_pad_par_bound(K, t, nt);
                check(b >= prev && b <= K, "partition monotone and within [0,K]");
                if (t < nt && b != K && b != prev)
                    check(b % SH_PAD_PAR_TILE == 0, "interior split is tile aligned");
                prev = b;
            }
            check(prev == K, "partition ends at K");
        }
    }
    printf("ok   partition arithmetic incl. K=INT64_MAX (no allocation)\n");
}

/* An injected join failure must abort rather than return while a worker may
 * still touch w, s or st. */
static void test_join_failure_aborts(void) {
    fflush(stdout);
    /* Before spawning: the child is required to SIGABRT, and a core dump from an
     * expected abort is noise (and can be slow on a loaded host). */
    const struct rlimit no_core = {0, 0};
    if (setrlimit(RLIMIT_CORE, &no_core) != 0) printf("     (note: could not set RLIMIT_CORE=0)\n");
    const pid_t pid = fork();
    if (pid == 0) {
        setrlimit(RLIMIT_CORE, &no_core);   /* inherited already; belt and braces */
        const int64_t K = 1024, N = 8;
        int8_t *w = (int8_t *)calloc((size_t)(K * N), 1);
        int32_t *s = (int32_t *)calloc((size_t)N, sizeof *s);
        int32_t *st = (int32_t *)calloc((size_t)K, sizeof *st);
        if (!w || !s || !st) _exit(70);
        for (int64_t j = 0; j < N; j++) s[j] = 1;
        sh_pad_par_test_join_fails = 1;
        sh_pad_par_test_ncpu = 8;
        sh_pad_check_prepare_dispatch(w, K, N, s, st, 1, 4, NULL);   /* NULL stats is legal */
        _exit(71);                      /* returned instead of aborting => failure */
    }
    if (pid < 0) { failures++; printf("FAIL join-failure test: fork failed\n"); return; }
    int status = 0;
    if (waitpid(pid, &status, 0) != pid) { failures++; printf("FAIL join-failure test: waitpid\n"); return; }
    check(WIFSIGNALED(status) && WTERMSIG(status) == SIGABRT,
          "injected join failure aborts the process (SIGABRT)");
    if (WIFEXITED(status)) printf("     (child exited %d instead of aborting)\n", WEXITSTATUS(status));
    else printf("ok   injected join failure fails closed with SIGABRT\n");
}

int main(void) {
    test_knob_parsing();
    test_profile_flag_parsing();
    test_partition();
    test_serial_stats_shape();
    test_cartesian_small();

    /* Ragged K and tile-count boundaries, small N. */
    test_shape(16,   9,  W_RANDOM, S_RANDOM, "K=16 single tile (clamps to 1 thread)");
    test_shape(129,  9,  W_RANDOM, S_RANDOM, "K=129 ragged, 2 tiles");
    test_shape(400,  9,  W_RANDOM, S_RANDOM, "K=400 ragged");
    test_shape(2048, 9,  W_RANDOM, S_RANDOM, "K=2048 exactly 16 tiles");

    /* N crossing the 32768 row-chunk boundary. K=512 gives 4 tiles so the
     * 2- and 4-thread dispatches are real. */
    test_shape(512, 32767, W_RANDOM, S_RANDOM, "N=32767");
    test_shape(512, 32768, W_RANDOM, S_RANDOM, "N=32768");
    test_shape(512, 32769, W_RANDOM, S_RANDOM, "N=32769");
    test_shape(512, 65537, W_RANDOM, S_RANDOM, "N=65537 (two chunks + 1)");

    /* Signed extrema. The field endpoints are what production draws; INT32_MIN
     * and INT32_MAX exercise the full int32 domain the helper's bound claims
     * (32768 rows x 128 columns x 2^31 = 2^53 per row chunk). */
    test_shape(512, 33, W_ALT, S_FIELD_LO,  "extrema w, s=1");
    test_shape(512, 33, W_ALT, S_FIELD_HI,  "extrema w, s=SH_FV_S_RANGE-1");
    test_shape(512, 33, W_MIN, S_INT32_MIN, "w=INT8_MIN, s=INT32_MIN");
    test_shape(512, 33, W_MAX, S_INT32_MIN, "w=INT8_MAX, s=INT32_MIN");
    test_shape(512, 33, W_MIN, S_INT32_MAX, "w=INT8_MIN, s=INT32_MAX");
    test_shape(512, 33, W_ALT, S_INT32_ALT, "w and s alternating int32 extrema");
    /* Worst-case magnitude at a full row chunk plus one, still only 16.8M MACs. */
    test_shape(512, 32769, W_MIN, S_INT32_MIN, "full row chunk at INT32_MIN (2^53 bound)");

    test_join_failure_aborts();

    if (failures) { printf("\n%d FAILURE(S)\n", failures); return 1; }
    printf("\nall pad-parallel checks passed\n");
    return 0;
}
