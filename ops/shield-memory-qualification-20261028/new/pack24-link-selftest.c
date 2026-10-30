/* pack24-link-selftest -- the packed pad ring (SHIELDED_POOL_PACK24=1) end to
 * end, through a real worker, against the int32 ring on the same weights.
 *
 *   1. SHIELDED_POOL_PACK24 unset, then "0", then "2": the int32 ring (the hook
 *      says so), every product exact and verified;
 *   2. "1": the packed ring; decode-shaped (m=1), batched (m=4) and wider than
 *      the ring (m=16 over a ring of 8: taken rows plus rows minted on the
 *      request path in one exchange), many rounds so every slot wraps;
 *   3. a READY slot corrupted to a pattern outside the field: the next exchange
 *      fails with SH_ERR_VERIFY, the link is retired (stats count it), and the
 *      one after that is refused too -- never an answer from a corrupt pad.
 *
 * Build with -DSHIELDED_PACK24_TESTHOOKS on shielded-tee.c (the hook below).
 *   SHIELDED_WORKER=127.0.0.1:9600 ./pack24-link-selftest
 * against shielded/worker.py (--device cpu is enough). */
#define _GNU_SOURCE
#include "shielded-field.h"
#include "shielded-tee.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

int sh_link_p24_corrupt_ready(sh_link *l, int group);   /* SHIELDED_PACK24_TESTHOOKS */

static uint32_t state = 0x9e3779b9u;
static uint32_t next(void) { state = state * 1664525U + 1013904223U; return state; }
static int failures;
#define CHECK(c, ...) do { if (!(c)) { failures++; fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } } while (0)

enum { MAXM = 16 };
typedef struct { int64_t K, N; int8_t *w; int node; } weight;

static void make_weight(weight *w, int64_t K, int64_t N) {
    w->K = K; w->N = N; w->w = malloc((size_t)K * N);
    for (int64_t i = 0; i < K * N; i++) w->w[i] = (int8_t)((int)(next() % 239) - 119);
}

/* One exchange; returns the gemm rc, and *bad if it returned OK with any
 * product that is not the exact balanced x.W. */
static int exchange(sh_link *l, weight **ws, int n, int m, int *bad) {
    const int64_t K = ws[0]->K;
    int64_t *x = malloc((size_t)m * K * sizeof *x);
    for (int64_t i = 0; i < m * K; i++) x[i] = (int64_t)(next() % 401) - 200;
    int64_t *y[4]; int nodes[4];
    for (int i = 0; i < n; i++) { y[i] = calloc((size_t)m * ws[i]->N, sizeof(int64_t)); nodes[i] = ws[i]->node; }
    const int rc = sh_link_gemm(l, nodes, (size_t)n, x, m, y);
    for (int i = 0; i < n && rc == SH_OK; i++)
        for (int r = 0; r < m; r++)
            for (int64_t j = 0; j < ws[i]->N; j++) {
                int64_t acc = 0;
                for (int64_t k = 0; k < K; k++) acc += x[(size_t)r * K + k] * ws[i]->w[(size_t)j * K + k];
                if (y[i][(size_t)r * ws[i]->N + j] != sh_balanced(acc)) *bad = 1;
            }
    for (int i = 0; i < n; i++) free(y[i]);
    free(x);
    return rc;
}

typedef struct { weight a1, a2, b; } model;

static sh_link *open_link(const char *host, int port, model *md) {
    int err = SH_OK;
    sh_link *l = sh_link_open(host, port, true, &err);
    if (!l) { fprintf(stderr, "open %s:%d failed (%d)\n", host, port, err); return NULL; }
    md->a1.node = sh_link_add_weight(l, "a1", md->a1.w, md->a1.K, md->a1.N, MAXM, -1);
    md->a2.node = sh_link_add_weight(l, "a2", md->a2.w, md->a2.K, md->a2.N, MAXM, md->a1.node);
    md->b.node  = sh_link_add_weight(l, "b",  md->b.w,  md->b.K,  md->b.N,  MAXM, -1);
    if (md->a1.node < 0 || md->a2.node < 0 || md->b.node < 0 || sh_link_start(l) != SH_OK) {
        fprintf(stderr, "setup: %s\n", sh_link_last_error(l)); sh_link_close(l); return NULL;
    }
    return l;
}

/* Every shape, `rounds` times: rc and exactness both. */
static void run_shapes(sh_link *l, model *md, int rounds, const char *what) {
    weight *ga[2] = { &md->a1, &md->a2 }, *gb[1] = { &md->b };
    static const int ms[] = { 1, 4, 1, 16, 2, 1, 7 };
    int bad = 0, rcbad = 0;
    for (int i = 0; i < rounds; i++)
        for (size_t s = 0; s < sizeof ms / sizeof ms[0]; s++) {
            rcbad |= exchange(l, ga, 2, ms[s], &bad) != SH_OK;
            rcbad |= exchange(l, gb, 1, ms[s], &bad) != SH_OK;
        }
    CHECK(!rcbad, "%s: every exchange returned OK (%s)", what, sh_link_last_error(l));
    CHECK(!bad, "%s: every product exact and verified", what);
    uint64_t e = 0, macs = 0, v = 0;
    sh_link_stats(l, &e, &macs, &v);
    CHECK(v == 0, "%s: no verification or integrity failure (%llu)", what, (unsigned long long)v);
}

int main(void) {
    const char *wk = getenv("SHIELDED_WORKER");
    char host[128] = "127.0.0.1"; int port = 9600;
    if (wk && *wk) { const char *c = strrchr(wk, ':'); if (c) { snprintf(host, sizeof host, "%.*s", (int)(c - wk), wk); port = atoi(c + 1); } }
    setenv("SHIELDED_POOL_DEPTH", "8", 1);
    setenv("SHIELDED_REFILL_BATCH", "4", 1);
    setenv("SHIELDED_REFILL_UNIT", "4", 1);
    setenv("SHIELDED_REFILL_THREADS", "2", 1);
    unsetenv("SHIELDED_PAD_SPILL");

    model md;
    make_weight(&md.a1, 192, 96); make_weight(&md.a2, 192, 41); make_weight(&md.b, 96, 300);   /* K respects field geometry; odd N tests tails */

    /* 1. the int32 ring, whatever is not exactly "1" */
    static const char *legacy[] = { NULL, "0", "2" };
    for (size_t i = 0; i < 3; i++) {
        if (legacy[i]) setenv("SHIELDED_POOL_PACK24", legacy[i], 1); else unsetenv("SHIELDED_POOL_PACK24");
        sh_link *l = open_link(host, port, &md);
        if (!l) return 2;
        CHECK(sh_link_p24_corrupt_ready(l, 0) == -1, "PACK24=%s: the int32 ring", legacy[i] ? legacy[i] : "(unset)");
        run_shapes(l, &md, 3, "int32 ring");
        sh_link_close(l);
    }

    /* 2. the packed ring */
    setenv("SHIELDED_POOL_PACK24", "1", 1);
    sh_link *l = open_link(host, port, &md);
    if (!l) return 2;
    run_shapes(l, &md, 12, "packed ring");
    uint64_t used = 0, missed = 0;
    sh_link_pool_stats(l, &used, &missed);
    CHECK(used > 0 && missed > 0, "the packed run both took from the ring and minted on the path (%llu used, %llu missed)",
          (unsigned long long)used, (unsigned long long)missed);

    /* 3. a corrupt ready slot */
    weight *gb[1] = { &md.b };
    int ready = 0;
    for (int tries = 0; tries < 200 && ready <= 0; tries++) {      /* refill threads top the ring up */
        int bad = 0;
        if (tries) { struct timespec ts = { 0, 10 * 1000000L }; nanosleep(&ts, NULL); }
        else (void)exchange(l, gb, 1, 1, &bad);
        ready = sh_link_p24_corrupt_ready(l, 1);                  /* groups: 0 = a1+a2, 1 = b */
    }
    CHECK(ready > 0, "a ready slot to corrupt (%d)", ready);
    int bad = 0;
    int rc = exchange(l, gb, 1, 1, &bad);
    CHECK(rc == SH_ERR_VERIFY, "a corrupt pad fails the exchange with SH_ERR_VERIFY (rc %d: %s)", rc, sh_link_last_error(l));
    uint64_t e = 0, macs = 0, v = 0;
    sh_link_stats(l, &e, &macs, &v);
    CHECK(v > 0, "the link counts the integrity failure");
    rc = exchange(l, gb, 1, 1, &bad);
    CHECK(rc == SH_ERR_VERIFY, "a retired link refuses the next exchange (rc %d)", rc);
    weight *ga[2] = { &md.a1, &md.a2 };
    rc = exchange(l, ga, 2, 1, &bad);
    CHECK(rc == SH_ERR_VERIFY, "and every other group's too (rc %d)", rc);
    sh_link_close(l);

    free(md.a1.w); free(md.a2.w); free(md.b.w);
    printf("{\"pack24_link_selftest\":%s,\"failures\":%d,\"pads_used\":%llu,\"ring_missed\":%llu}\n",
           failures ? "false" : "true", failures, (unsigned long long)used, (unsigned long long)missed);
    return failures ? 1 : 0;
}
