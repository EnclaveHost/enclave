/*
 * split-harness -- the anchor split, exercised natively against a live worker.
 *
 * Same process, two roles: the anchor core plays the TA (pads, mask, unmask,
 * Freivalds), the worker client plays the normal-world CA (sockets, install,
 * ciphertext ferrying). This is the x86/aarch64-Linux rung of the spike
 * ladder; the OP-TEE rung splits exactly this flow across TEEC_InvokeCommand
 * instead of function calls, and must produce the same verdicts.
 *
 * Asserts, per shielded-probe.c's discipline:
 *   exact          unmasked y == the core's int64 local product, every iter
 *   verified       Freivalds accepts every honest exchange
 *   lie_rejected   a single corrupted reply byte is refused
 *   pads_distinct  the same x masked twice yields different planes
 * and reports median per-phase costs over --iters exchanges:
 *   pad (u=r.W refill), mask, wire (send..receive), finish (unmask+verify).
 */
#include "anchor-core.h"
#include "fixture.h"
#include "worker-client.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <time.h>

static int rng_os(void *buf, size_t n) {
    uint8_t *p = (uint8_t *)buf;
    while (n) {
        ssize_t r = getrandom(p, n, 0);
        if (r < 0) return -1;
        p += r; n -= (size_t)r;
    }
    return 0;
}

static double now_us(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e6 + ts.tv_nsec / 1e3;
}

static int cmp_d(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return x < y ? -1 : x > y;
}
static double median(double *v, int n) { qsort(v, (size_t)n, sizeof *v, cmp_d); return v[n / 2]; }

int main(int argc, char **argv) {
    const char *host = "127.0.0.1";
    int port = 9500, iters = 200, n_nodes = 1, force32 = 0;
    int64_t K = 896, N = 896;
    int xmax = 0;                 /* 0 = auto: hold the K=896 fixture's headroom */
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--host") && i + 1 < argc) host = argv[++i];
        else if (!strcmp(argv[i], "--port") && i + 1 < argc) port = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--k") && i + 1 < argc) K = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--n") && i + 1 < argc) N = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--nodes") && i + 1 < argc) n_nodes = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--iters") && i + 1 < argc) iters = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--xmax") && i + 1 < argc) xmax = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--force32")) force32 = 1;
    }
    if (n_nodes < 1 || n_nodes > AN_MAX_NODES || iters < 4) { fprintf(stderr, "bad args\n"); return 2; }

    /* The activation range stands in for offline calibration: a real site's
     * exponent is chosen so the product keeps headroom under M/2, and the
     * fixture must do the same or it wraps the field and the integer Freivalds
     * (correctly) refuses the exchange. Auto = the K=896 fixture's headroom,
     * scaled as 1/sqrt(K) because the accumulator grows that way. */
    if (xmax <= 0) { double s_ = 900.0 * sqrt(896.0 / (double)K); xmax = (int)(s_ < 1 ? 1 : s_); }

    fx_rng g = { FX_SEED };
    int8_t *w[AN_MAX_NODES] = { 0 };
    for (int i = 0; i < n_nodes; i++)
        if (!(w[i] = fx_weight(&g, K, N))) { fprintf(stderr, "oom\n"); return 2; }
    int64_t *x = (int64_t *)malloc((size_t)K * sizeof(int64_t));
    int8_t *planes  = (int8_t *)malloc((size_t)3 * K);
    int8_t *planes2 = (int8_t *)malloc((size_t)3 * K);
    if (!x || !planes || !planes2) { fprintf(stderr, "oom\n"); return 2; }

    int64_t Ks[AN_MAX_NODES], Ns[AN_MAX_NODES];
    for (int i = 0; i < n_nodes; i++) { Ks[i] = K; Ns[i] = N; }
    const size_t footprint = an_footprint(n_nodes, Ks, Ns);

    an_ctx *a = an_create(rng_os);
    if (!a) { fprintf(stderr, "an_create failed\n"); return 2; }
    for (int i = 0; i < n_nodes; i++)
        if (an_add_weight(a, w[i], K, N) < 0) { fprintf(stderr, "an_add_weight failed\n"); return 2; }
    double t0 = now_us();
    if (an_prepare(a) != AN_OK) { fprintf(stderr, "an_prepare failed\n"); return 2; }
    double prepare_us = now_us() - t0;

    wc_client wc; memset(&wc, 0, sizeof wc);
    for (int i = 0; i < n_nodes; i++)
        if (wc_add(&wc, K, N) < 0) { fprintf(stderr, "wc_add: %s\n", wc.err); return 2; }
    if (wc_connect_install(&wc, host, port, (const int8_t *const *)w, force32) != SH_OK) {
        fprintf(stderr, "install: %s\n", wc.err); return 2;
    }

    double *tp = malloc((size_t)iters * sizeof(double)), *tm = malloc((size_t)iters * sizeof(double)),
           *tw = malloc((size_t)iters * sizeof(double)), *tf = malloc((size_t)iters * sizeof(double));
    if (!tp || !tm || !tw || !tf) return 2;

    int exact = 1, verified = 1, lie_rejected = 0, pads_distinct = 0;
    int64_t peak = 0;             /* largest |y| seen: the field-headroom witness */
    uint64_t digest = 1469598103934665603ull;   /* FNV-1a over every node's y, every iter */
    const uint8_t *reply; size_t rlen;

    /* pads_distinct: mask the SAME x under two pads; the planes must differ.
     * (Complete the exchanges: consumed pads never come back.) */
    fx_activation(&g, K, x, xmax);
    for (int r = 0; r < 2; r++) {
        if (an_pad_gen(a) != AN_OK || an_mask(a, x, r ? planes2 : planes) != AN_OK) return 2;
        if (wc_exchange(&wc, r ? planes2 : planes, 1, &reply, &rlen) != SH_OK) { fprintf(stderr, "exchange: %s\n", wc.err); return 2; }
        if (an_finish(a, reply, rlen, wc.ywidth) != AN_OK) verified = 0;
    }
    pads_distinct = memcmp(planes, planes2, (size_t)3 * K) != 0;

    /* lie_rejected: corrupt one byte of an honest reply. */
    if (an_pad_gen(a) == AN_OK && an_mask(a, x, planes) == AN_OK &&
        wc_exchange(&wc, planes, 1, &reply, &rlen) == SH_OK) {
        uint8_t *evil = (uint8_t *)malloc(rlen);
        if (!evil) return 2;
        memcpy(evil, reply, rlen);
        evil[rlen / 2] ^= 1;
        lie_rejected = an_finish(a, evil, rlen, wc.ywidth) == AN_ERR_VERIFY;
        free(evil);
    }

    /* the measured loop */
    int done = 0;
    for (int it = 0; it < iters; it++) {
        fx_activation(&g, K, x, xmax);
        double a0 = now_us();
        if (an_pad_gen(a) != AN_OK) break;
        double a1 = now_us();
        if (an_mask(a, x, planes) != AN_OK) break;
        double a2 = now_us();
        if (wc_exchange(&wc, planes, 1, &reply, &rlen) != SH_OK) { fprintf(stderr, "exchange: %s\n", wc.err); break; }
        double a3 = now_us();
        int rc = an_finish(a, reply, rlen, wc.ywidth);
        double a4 = now_us();
        if (rc != AN_OK) { verified = 0; break; }
        if (an_check_local(a) != AN_OK) { exact = 0; break; }
        for (int nd = 0; nd < n_nodes; nd++) {
            const uint64_t d = an_y_digest(a, nd);
            digest ^= d; digest *= 1099511628211ull;
        }
        { int64_t pk = an_peak_abs_y(a); if (pk > peak) peak = pk; }
        tp[it] = a1 - a0; tm[it] = a2 - a1; tw[it] = a3 - a2; tf[it] = a4 - a3;
        done++;
    }

    uint64_t pads = 0, ex = 0, vf = 0;
    an_stats(a, &pads, &ex, &vf);
    wc_close(&wc);

    const int pass = exact && verified && lie_rejected && pads_distinct && done == iters;
    printf("{\"exact\":%s,\"verified\":%s,\"lie_rejected\":%s,\"pads_distinct\":%s,"
           "\"iters\":%d,\"done\":%d,\"ywidth\":%d,\"K\":%lld,\"N\":%lld,\"nodes\":%d,"
           "\"footprint_bytes\":%zu,\"prepare_us\":%.0f,\"xmax\":%d,"
           "\"peak_abs_y\":%lld,\"field_headroom\":%.2f,\"y_digest\":\"%016llx\","
           "\"median_us\":{\"pad\":%.1f,\"mask\":%.1f,\"wire\":%.1f,\"finish\":%.1f},"
           "\"pads_issued\":%llu,\"exchanges\":%llu,\"verify_fail\":%llu}\n",
           exact ? "true" : "false", verified ? "true" : "false",
           lie_rejected ? "true" : "false", pads_distinct ? "true" : "false",
           iters, done, wc.ywidth, (long long)K, (long long)N, n_nodes,
           footprint, prepare_us, xmax,
           (long long)peak, (double)SH_HALF_M / (double)(peak ? peak : 1),
           (unsigned long long)digest,
           done ? median(tp, done) : 0.0, done ? median(tm, done) : 0.0,
           done ? median(tw, done) : 0.0, done ? median(tf, done) : 0.0,
           (unsigned long long)pads, (unsigned long long)ex, (unsigned long long)vf);
    an_destroy(a);
    for (int i = 0; i < n_nodes; i++) free(w[i]);
    free(x); free(planes); free(planes2); free(tp); free(tm); free(tw); free(tf);
    return pass ? 0 : 1;
}
