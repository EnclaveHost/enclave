/*
 * rtt-probe -- the transport measurement the anchor's routing rule needs.
 *
 * Decode is a serial chain of ~49 (0.5B) to ~128 (7B) unpipelineable exchanges
 * per token, so token rate tracks the round-trip DISTRIBUTION, not its mean:
 * one 40 ms tail event costs as much as thirty median exchanges. The handoff's
 * routing rule is therefore "measured RTT distribution, not transport name",
 * and this is the instrument for it.
 *
 * It speaks the worker's own protocol rather than a synthetic echo, so the
 * number is the real thing: a FIELD_GEMM over a registered node, at the payload
 * size a real exchange carries. The activation planes are random bytes -- this
 * measures transport, and the worker cannot tell the difference (a masked plane
 * IS uniform bytes; that is the whole construction).
 *
 * Reports median/p90/p99/max and the tail ratio p99/median, which is the number
 * that decides interactive eligibility.
 */
#include "fixture.h"
#include "worker-client.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now_us(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e6 + ts.tv_nsec / 1e3;
}
static int cmp_d(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return x < y ? -1 : x > y;
}
static double pct(double *v, int n, double p) {
    int i = (int)(p * (n - 1) + 0.5);
    return v[i < 0 ? 0 : i >= n ? n - 1 : i];
}

int main(int argc, char **argv) {
    const char *host = "127.0.0.1", *label = "unspecified";
    int port = 9500, iters = 1000, n_nodes = 1, warmup = 50;
    int64_t K = 896, N = 896;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--host") && i + 1 < argc) host = argv[++i];
        else if (!strcmp(argv[i], "--port") && i + 1 < argc) port = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--k") && i + 1 < argc) K = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--n") && i + 1 < argc) N = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--nodes") && i + 1 < argc) n_nodes = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--iters") && i + 1 < argc) iters = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--label") && i + 1 < argc) label = argv[++i];
    }
    if (n_nodes < 1 || n_nodes > 8 || iters < 10) { fprintf(stderr, "bad args\n"); return 2; }

    fx_rng g = { FX_SEED };
    int8_t *w[8] = { 0 };
    for (int i = 0; i < n_nodes; i++)
        if (!(w[i] = fx_weight(&g, K, N))) { fprintf(stderr, "oom\n"); return 2; }
    /* Random planes: a masked activation is uniform over the field by
     * construction, so for TRANSPORT purposes these are the real thing. */
    int8_t *planes = (int8_t *)malloc((size_t)3 * K);
    if (!planes) { fprintf(stderr, "oom\n"); return 2; }
    for (int64_t i = 0; i < 3 * K; i++) planes[i] = (int8_t)(fx_rnd(&g) * 255 - 128);

    wc_client wc; memset(&wc, 0, sizeof wc);
    for (int i = 0; i < n_nodes; i++)
        if (wc_add(&wc, K, N) < 0) { fprintf(stderr, "wc_add: %s\n", wc.err); return 2; }
    if (wc_connect_install(&wc, host, port, (const int8_t *const *)w, 0) != SH_OK) {
        fprintf(stderr, "install: %s\n", wc.err); return 2;
    }

    const uint8_t *reply; size_t rlen;
    for (int i = 0; i < warmup; i++)
        if (wc_exchange(&wc, planes, 1, &reply, &rlen) != SH_OK) { fprintf(stderr, "warmup: %s\n", wc.err); return 2; }

    double *t = (double *)malloc((size_t)iters * sizeof(double));
    if (!t) return 2;
    int done = 0;
    const double t_start = now_us();
    for (int i = 0; i < iters; i++) {
        double a = now_us();
        if (wc_exchange(&wc, planes, 1, &reply, &rlen) != SH_OK) { fprintf(stderr, "exchange: %s\n", wc.err); break; }
        t[i] = now_us() - a;
        done++;
    }
    const double wall_s = (now_us() - t_start) / 1e6;
    const size_t req_bytes = 8 + 4 * (size_t)n_nodes + (size_t)3 * K;
    const size_t rep_bytes = wc_reply_len(&wc, 1);
    wc_close(&wc);
    if (!done) return 2;

    double mean = 0;
    for (int i = 0; i < done; i++) mean += t[i];
    mean /= done;
    qsort(t, (size_t)done, sizeof *t, cmp_d);
    const double med = pct(t, done, 0.50);

    /* What this transport implies for decode, on the handoff's exchange counts:
     * the chain is serial, so token time ~= exchanges * RTT (plus TEE work). */
    printf("{\"label\":\"%s\",\"iters\":%d,\"K\":%lld,\"N\":%lld,\"nodes\":%d,"
           "\"req_bytes\":%zu,\"rep_bytes\":%zu,\"ywidth\":%d,"
           "\"us\":{\"min\":%.1f,\"p50\":%.1f,\"mean\":%.1f,\"p90\":%.1f,\"p99\":%.1f,\"max\":%.1f},"
           "\"tail_ratio_p99_p50\":%.2f,\"throughput_exch_per_s\":%.0f,"
           "\"implied_tok_s\":{\"0.5B_49exch\":%.1f,\"7B_128exch\":%.1f}}\n",
           label, done, (long long)K, (long long)N, n_nodes,
           req_bytes, rep_bytes, wc.ywidth,
           t[0], med, mean, pct(t, done, 0.90), pct(t, done, 0.99), t[done - 1],
           med > 0 ? pct(t, done, 0.99) / med : 0.0,
           done / wall_s,
           med > 0 ? 1e6 / (49.0 * med) : 0.0,
           med > 0 ? 1e6 / (128.0 * med) : 0.0);

    for (int i = 0; i < n_nodes; i++) free(w[i]);
    free(planes); free(t);
    return 0;
}
