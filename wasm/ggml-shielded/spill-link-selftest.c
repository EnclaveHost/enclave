/* spill-link-selftest -- the pad spill end to end, through a real worker.
 *
 * A link with a small ring (8 pads a group) and a spill file:
 *   1. idle: the refill threads fill the spill on their own;
 *   2. a burst far wider than the ring: every product exact and verified, and
 *      the pads came from the spill (refill imports and request-path imports);
 *   3. idle again: the spill refills what the burst took;
 *   4. the host wipes the disk: the next imports do not open, the spill turns
 *      itself off, and every product is STILL exact -- minted, as before.
 *
 *   SHIELDED_WORKER=127.0.0.1:9600 ./spill-link-selftest DIR
 * against shielded/worker.py (--device cpu is enough). DIR must take O_DIRECT. */
#define _GNU_SOURCE
#include "shielded-field.h"
#include "shielded-spill.h"
#include "shielded-tee.h"

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static uint32_t state = 0xc0ffee;
static uint32_t next(void) { state = state * 1664525U + 1013904223U; return state; }
static int failures;
#define CHECK(c, ...) do { if (!(c)) { failures++; fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } } while (0)
static double now_s(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }

enum { M = 16 };
typedef struct { int64_t K, N; int8_t *w; int node; } weight;

static void make_weight(weight *w, int64_t K, int64_t N) {
    w->K = K; w->N = N; w->w = malloc((size_t)K * N);
    for (int64_t i = 0; i < K * N; i++) w->w[i] = (int8_t)((int)(next() % 239) - 119);
}

/* One exchange over `n` weights sharing x, checked against int64 products.
 * SPILL_TEST_CONST_X=1 sends the same x every time (the same row in every row
 * slot, too), so the masked planes on the wire differ only by their pads: the
 * reuse proxy (test/shielded-spill-reuse-proxy.py) then sees any pad twice. */
static int exchange(sh_link *l, weight **ws, int n) {
    const int64_t K = ws[0]->K;
    const char *cx = getenv("SPILL_TEST_CONST_X");
    const bool const_x = cx && !strcmp(cx, "1");
    int64_t *x = malloc((size_t)M * K * sizeof *x);
    for (int64_t i = 0; i < M * K; i++) x[i] = const_x ? (int64_t)((i % K) * 7 % 401) - 200 : (int64_t)(next() % 401) - 200;
    int64_t *y[4]; int nodes[4];
    for (int i = 0; i < n; i++) { y[i] = calloc((size_t)M * ws[i]->N, sizeof(int64_t)); nodes[i] = ws[i]->node; }
    int rc = sh_link_gemm(l, nodes, (size_t)n, x, M, y);
    int bad = rc != SH_OK;
    if (rc != SH_OK) fprintf(stderr, "gemm rc %d: %s\n", rc, sh_link_last_error(l));
    for (int i = 0; i < n && !bad; i++)
        for (int r = 0; r < M && !bad; r++)
            for (int64_t j = 0; j < ws[i]->N && !bad; j++) {
                int64_t acc = 0;
                for (int64_t k = 0; k < K; k++) acc += x[(size_t)r * K + k] * ws[i]->w[(size_t)j * K + k];
                if (y[i][(size_t)r * ws[i]->N + j] != sh_balanced(acc)) bad = 1;
            }
    for (int i = 0; i < n; i++) free(y[i]);
    free(x);
    return bad;
}

static sh_link_spill stats(sh_link *l) { sh_link_spill s; sh_link_spill_stats((struct sh_link *)l, &s); return s; }

/* Wait for the idle refill to bank at least `rows` whole rows. */
static bool wait_rows(sh_link *l, uint64_t rows, double limit_s) {
    const double t0 = now_s();
    while (now_s() - t0 < limit_s) {
        if (stats(l).rows >= rows) return true;
        usleep(50000);
    }
    return false;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: SHIELDED_WORKER=host:port %s DIR\n", argv[0]); return 2; }
    const char *wk = getenv("SHIELDED_WORKER");
    char host[128] = "127.0.0.1"; int port = 9600;
    if (wk && *wk) { const char *c = strrchr(wk, ':'); if (c) { snprintf(host, sizeof host, "%.*s", (int)(c - wk), wk); port = atoi(c + 1); } }

    char path[4096];
    snprintf(path, sizeof path, "%s/spill-link-selftest.%d.img", argv[1], (int)getpid());
    int fd = open(path, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd < 0 || ftruncate(fd, (off_t)(UINT64_C(24) << 20)) != 0) { perror(path); return 2; }
    if (dup2(fd, 78) != 78) { perror("dup2"); return 2; }
    close(fd);
    setenv("SHIELDED_PAD_SPILL", "fd:78", 1);
    setenv("SHIELDED_PAD_SPILL_PARTS", "1", 1);
    setenv("SHIELDED_POOL_DEPTH", "8", 1);
    setenv("SHIELDED_REFILL_BATCH", "8", 1);
    setenv("SHIELDED_REFILL_UNIT", "8", 1);
    setenv("SHIELDED_REFILL_THREADS", "3", 1);
    setenv("SHIELDED_PAD_SPILL_IDLE_MS", "150", 1);

    weight a1, a2, b;
    make_weight(&a1, 192, 96); make_weight(&a2, 192, 40); make_weight(&b, 64, 300);
    int err = SH_OK;
    sh_link *l = sh_link_open(host, port, true, &err);
    if (!l) { fprintf(stderr, "open %s:%d failed (%d)\n", host, port, err); unlink(path); return 2; }
    a1.node = sh_link_add_weight(l, "a1", a1.w, a1.K, a1.N, M, -1);
    a2.node = sh_link_add_weight(l, "a2", a2.w, a2.K, a2.N, M, a1.node);
    b.node  = sh_link_add_weight(l, "b",  b.w,  b.K,  b.N,  M, -1);
    if (a1.node < 0 || a2.node < 0 || b.node < 0) { fprintf(stderr, "add_weight: %s\n", sh_link_last_error(l)); unlink(path); return 2; }
    if ((err = sh_link_start(l)) != SH_OK) { fprintf(stderr, "start: %s\n", sh_link_last_error(l)); unlink(path); return 2; }
    weight *ga[2] = { &a1, &a2 }, *gb[1] = { &b };

    sh_link_spill s0 = stats(l);
    CHECK(s0.attached && !s0.off && s0.slots >= 64, "spill attached (%llu slots)", (unsigned long long)s0.slots);
    const uint64_t full = s0.slots - (s0.slots % 8 ? s0.slots % 8 : 0) - 8;   /* minting stops short of one batch */

    /* 1. idle: the spill fills itself */
    const double t_fill = now_s();
    CHECK(wait_rows(l, full, 120), "the idle spill banked %llu rows, wanted %llu", (unsigned long long)stats(l).rows, (unsigned long long)full);
    const double fill_s = now_s() - t_fill;
    sh_link_spill s1 = stats(l);

    /* 2. a burst over 20x the ring */
    const int burst = 10;
    int bad = 0;
    for (int i = 0; i < burst; i++) { bad |= exchange(l, ga, 2); bad |= exchange(l, gb, 1); }
    CHECK(!bad, "every burst product exact and verified");
    sh_link_spill s2 = stats(l);
    const uint64_t from_spill = (s2.imported - s1.imported) + (s2.onpath - s1.onpath);
    CHECK(from_spill >= (uint64_t)(burst * M * 2) / 2, "the burst drew %llu pads from the spill", (unsigned long long)from_spill);
    CHECK(s2.onpath > s1.onpath, "the request path imported its shortfall (%llu)", (unsigned long long)(s2.onpath - s1.onpath));
    CHECK(!s2.off && s2.failed == 0, "no spill failure");
    uint64_t pads_used = 0, pads_missed = 0;
    sh_link_pool_stats(l, &pads_used, &pads_missed);

    /* 3. idle again: what the burst took is minted back */
    CHECK(wait_rows(l, full, 120), "the spill refilled after the burst");
    sh_link_spill s3 = stats(l);
    CHECK(s3.written > s2.written, "refill wrote %llu more pads", (unsigned long long)(s3.written - s2.written));

    /* 4. the host wipes the disk */
    {
        int wfd = open(path, O_WRONLY);
        void *zero = NULL;
        if (wfd < 0 || posix_memalign(&zero, 4096, 1 << 20)) { CHECK(0, "open for the wipe"); }
        else {
            memset(zero, 0, 1 << 20);
            for (off_t off = 0; off < (off_t)(UINT64_C(24) << 20); off += 1 << 20)
                if (pwrite(wfd, zero, 1 << 20, off) != 1 << 20) { CHECK(0, "wipe"); break; }
            fsync(wfd); close(wfd); free(zero);
        }
    }
    bad = 0;
    for (int i = 0; i < burst; i++) { bad |= exchange(l, ga, 2); bad |= exchange(l, gb, 1); }
    CHECK(!bad, "after the wipe every product is still exact and verified");
    sh_link_spill s4 = stats(l);
    CHECK(s4.off && s4.failed == 1, "a wiped spill turns itself off (off=%d failed=%llu)", s4.off, (unsigned long long)s4.failed);
    uint64_t ex = 0, macs = 0, vf = 0;
    sh_link_stats(l, &ex, &macs, &vf);
    CHECK(vf == 0, "no verification failure (%llu)", (unsigned long long)vf);

    sh_link_close(l);
    free(a1.w); free(a2.w); free(b.w);
    unlink(path);
    printf("{\"spill_link_selftest\":%s,\"failures\":%d,\"slots\":%llu,\"fill_s\":%.2f,\"written\":%llu,"
           "\"imported\":%llu,\"onpath\":%llu,\"pads_used\":%llu,\"ring_missed\":%llu,\"exchanges\":%llu}\n",
           failures ? "false" : "true", failures, (unsigned long long)s0.slots, fill_s,
           (unsigned long long)s4.written, (unsigned long long)s4.imported, (unsigned long long)s4.onpath,
           (unsigned long long)pads_used, (unsigned long long)pads_missed, (unsigned long long)ex);
    return failures ? 1 : 0;
}
