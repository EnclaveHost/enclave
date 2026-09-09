#ifndef SHIELDED_PAD_PARALLEL_H
#define SHIELDED_PAD_PARALLEL_H

/* Default-off parallel dispatch of the mod-M pad-check preparation over
 * disjoint column ranges of st.
 *
 * Knob: SHIELDED_PAD_PREPARE_THREADS
 *   absent        -> 1. Not one line of the threading below runs; pad_check_prepare
 *                    executes exactly the serial implementation it selects today.
 *   "1".."16"     -> canonical decimal only. No sign, no spaces, no leading zeros
 *                    ("08" and "004" are rejected). The kernel selected by
 *                    SHIELDED_PAD_PREPARE_TILED is dispatched over that many
 *                    disjoint [k_begin, k_end) column ranges.
 *   "" or anything else -> SH_PAD_PAR_BAD_KNOB. The caller fails registration.
 *                    A malformed knob never silently disables the check and never
 *                    silently substitutes a different policy.
 *
 * Relationship to the existing knobs, exactly:
 *   SHIELDED_PAD_CHECK           - unchanged. Gates whether preparation happens.
 *   SHIELDED_PAD_PREPARE_TILED   - unchanged. Selects WHICH arithmetic kernel
 *                                  prepares st (tiled int64 vs __int128 reference).
 *   SHIELDED_PAD_PREPARE_THREADS - new, orthogonal. Selects HOW MANY disjoint
 *                                  column ranges that kernel runs on.
 *   SHIELDED_PAD_CHECK_TILED     - untouched. Different knob at a different site
 *                                  (dealt_import's per-cell online check).
 *
 * Disjointness: each kernel writes only st[k] for k in its own range and reads W
 * (row stride K, read-only) and s (read-only). There is no shared accumulator, so
 * unlike fv_prepare_parallel - which partitions the SUM over rows and needs an
 * nt*K*reps partial buffer plus a mod-P2 reduction - this partitions the OUTPUT.
 * No partial buffers, no reduction pass, no cross-thread writes.
 *
 * Lifetime: every thread this file creates is private (no other joiner) and is
 * joined before the function returns, so the stack job array cannot outlive a
 * worker and no pointer is copied past return. There is no path that returns
 * while a worker may still touch w, s or st - see sh_pad_par_fail_closed. */

#include "shielded-pad-check.h"
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

enum { SH_PAD_PAR_MAX_THREADS = 16, SH_PAD_PAR_TILE = 128 };

enum { SH_PAD_PAR_OK = 0, SH_PAD_PAR_BAD_KNOB = -1 };

/* Canonical decimal 1..16, locale-free, errno-free, no secret-dependent branch.
 * NULL (absent) yields 1 and SH_PAD_PAR_OK; "" is rejected. */
static inline int sh_pad_par_parse_threads(const char *env, int *out) {
    *out = 1;
    if (!env) return SH_PAD_PAR_OK;                     /* absent => unchanged */
    const size_t n = strlen(env);
    if (n == 1) {
        if (env[0] < '1' || env[0] > '9') return SH_PAD_PAR_BAD_KNOB;
        *out = env[0] - '0';
        return SH_PAD_PAR_OK;
    }
    if (n == 2 && env[0] == '1' && env[1] >= '0' && env[1] <= '6') {
        *out = 10 + (env[1] - '0');                     /* 10..16 */
        return SH_PAD_PAR_OK;
    }
    return SH_PAD_PAR_BAD_KNOB;                         /* "", "0", "08", "17", " 2", "2x", ... */
}

/* Whole 128-column tiles, computed without a K+127 intermediate. */
static inline int64_t sh_pad_par_tiles(int64_t K) {
    return K / SH_PAD_PAR_TILE + (K % SH_PAD_PAR_TILE != 0);
}

/* Split point t of nt over [0,K), snapped down to a whole tile so each worker's
 * tiling is the serial tiling. Monotone non-decreasing, b(0)==0, b(nt)==K, so
 * the ranges are disjoint and cover [0,K) exactly. */
static inline int64_t sh_pad_par_bound(int64_t K, int t, int nt) {
    if (t <= 0) return 0;
    if (t >= nt) return K;
    const int64_t b = (sh_pad_par_tiles(K) * (int64_t)t / nt) * SH_PAD_PAR_TILE;
    return b > K ? K : b;
}

typedef struct {
    const int8_t *w; int64_t K, N, k0, k1; const int32_t *s; int32_t *st; int tiled;
} sh_pad_par_job;

static inline void sh_pad_par_run(const sh_pad_par_job *j) {
    if (j->k0 >= j->k1) return;
    if (j->tiled) sh_pad_check_tiled_range(j->w, j->K, j->N, j->k0, j->k1, j->s, j->st);
    else          sh_pad_check_ref_range  (j->w, j->K, j->N, j->k0, j->k1, j->s, j->st);
}
static inline void *sh_pad_par_main(void *arg) { sh_pad_par_run((const sh_pad_par_job *)arg); return NULL; }

/* A thread we created ourselves, joinable, never detached, with exactly one
 * joiner cannot legitimately fail to join: EINVAL/ESRCH/EDEADLK all require an
 * invariant we hold. If pthread_join still fails we have no proof the worker
 * stopped, and we must not return: sh_link_add_weight's error path
 * (shielded-tee.c:764) calls node_free_checks(nd) immediately, freeing sM and
 * stM, and the caller may release W after that. A surviving worker would then
 * read and write freed memory. There is no safe recovery, no completion proof
 * and no busy-wait justification, so the process fails closed here. */
static inline void sh_pad_par_fail_closed(void) {
    fputs("shielded: pad-check worker could not be joined; failing closed\n", stderr);
    fflush(stderr);
    abort();
}

/* Test-only hooks. Production builds define no macro and call the libc functions
 * directly; the injected forms are compiled out entirely. */
#ifdef SH_PAD_PARALLEL_TEST_HOOKS
extern unsigned sh_pad_par_test_fail_mask;   /* bit t set => pthread_create for job t fails */
extern int      sh_pad_par_test_join_fails;  /* nonzero => first join reports failure */
extern long     sh_pad_par_test_ncpu;        /* 0 = real sysconf, >0 override, <0 = sysconf failure */
/* Observation counters. Every one of these is written only by the thread that
 * calls sh_pad_check_prepare_dispatch, inside the serial create loop or before
 * it - never by a worker - so they need no atomics and add no race. They let a
 * test assert that threads were actually attempted: an implementation that
 * always runs serially fails the dispatch assertions even when its output is
 * identical. */
extern int sh_pad_par_test_nt;            /* effective thread count chosen */
extern int sh_pad_par_test_create_calls;  /* pthread_create attempts */
extern int sh_pad_par_test_created;       /* attempts that succeeded */
extern int sh_pad_par_test_inline_jobs;   /* ranges run inline after a create failure */
#define SH_PAD_PAR_CREATE(th, fn, arg, idx) \
    (sh_pad_par_test_create_calls++, \
     ((sh_pad_par_test_fail_mask >> (idx)) & 1u) ? 11 /*EAGAIN*/ : pthread_create((th), NULL, (fn), (arg)))
#define SH_PAD_PAR_JOIN(th) (sh_pad_par_test_join_fails ? 22 /*EINVAL*/ : pthread_join((th), NULL))
#define SH_PAD_PAR_NCPU()   (sh_pad_par_test_ncpu ? sh_pad_par_test_ncpu : sysconf(_SC_NPROCESSORS_ONLN))
#define SH_PAD_PAR_COUNT(v) ((v)++)
#define SH_PAD_PAR_SET_NT(v) (sh_pad_par_test_nt = (v))
#else
#define SH_PAD_PAR_CREATE(th, fn, arg, idx) pthread_create((th), NULL, (fn), (arg))
#define SH_PAD_PAR_JOIN(th)                 pthread_join((th), NULL)
#define SH_PAD_PAR_NCPU()                   sysconf(_SC_NPROCESSORS_ONLN)
#define SH_PAD_PAR_COUNT(v)                 ((void)0)   /* no production overhead */
#define SH_PAD_PAR_SET_NT(v)                ((void)0)
#endif

/* want_threads must already have come from sh_pad_par_parse_threads. On return
 * st[0,K) is fully written and no worker created here is still running. */
static inline void sh_pad_check_prepare_dispatch(const int8_t *w, int64_t K, int64_t N,
                                                 const int32_t *s, int32_t *st,
                                                 int tiled, int want_threads) {
    int nt = want_threads < 1 ? 1 : want_threads;
    if (nt > SH_PAD_PAR_MAX_THREADS) nt = SH_PAD_PAR_MAX_THREADS;
    const long ncpu = SH_PAD_PAR_NCPU();                 /* public, not a secret */
    if (ncpu < 1) nt = 1;                                /* unknown CPU count => serial */
    else if ((long)nt > ncpu) nt = (int)ncpu;
    const int64_t tiles = sh_pad_par_tiles(K);
    if ((int64_t)nt > tiles) nt = (int)tiles;            /* never an empty range */
    if (nt < 1) nt = 1;
    SH_PAD_PAR_SET_NT(nt);

    if (nt == 1) {
        const sh_pad_par_job whole = { w, K, N, 0, K, s, st, tiled };
        sh_pad_par_run(&whole);
        return;
    }

    /* Fixed arrays: no allocation, therefore no allocation-failure path. Safe
     * because every created thread is joined below before this frame returns. */
    sh_pad_par_job jobs[SH_PAD_PAR_MAX_THREADS];
    pthread_t      th[SH_PAD_PAR_MAX_THREADS];
    int            made[SH_PAD_PAR_MAX_THREADS];
    memset(th, 0, sizeof th);
    memset(made, 0, sizeof made);

    for (int t = 0; t < nt; t++) {
        jobs[t] = (sh_pad_par_job){ w, K, N, sh_pad_par_bound(K, t, nt),
                                    sh_pad_par_bound(K, t + 1, nt), s, st, tiled };
        if (SH_PAD_PAR_CREATE(&th[t], sh_pad_par_main, &jobs[t], t) == 0) {
            made[t] = 1; SH_PAD_PAR_COUNT(sh_pad_par_test_created);
        }
        else SH_PAD_PAR_COUNT(sh_pad_par_test_inline_jobs),
             sh_pad_par_run(&jobs[t]);   /* only THIS range, inline, here. Its columns
                                          * belong to no other job, so it cannot race a
                                          * worker, and no second full serial pass is
                                          * ever written over live workers. */
    }

    for (int t = 0; t < nt; t++)
        if (made[t] && SH_PAD_PAR_JOIN(th[t]) != 0) sh_pad_par_fail_closed();
}
#endif
