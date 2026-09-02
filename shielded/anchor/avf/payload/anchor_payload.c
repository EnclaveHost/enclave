/*
 * anchor_payload -- the Shielded anchor's trusted half, running INSIDE a
 * protected VM on the Pixel.
 *
 * This is the property the whole search was for: the pad key, the pads,
 * u = r.W, the Freivalds secrets, the plaintext activation and every unmasked
 * product live in memory that pKVM has unmapped from the host -- the phone's
 * owner, with root, cannot read it. The S21+ could never give this; this
 * device gives it to a plain APK launched from an adb shell.
 *
 * Phase A (this file): the whole split runs in-guest -- the anchor core plays
 * its own role and a local routine plays the untrusted worker, exactly as
 * optee/host/local-worker-ca.c does on the OP-TEE rung. That proves the
 * arithmetic runs in a pVM, is bit-exact against the core's int64 reference,
 * refuses a corrupted reply, and reports what it costs on Tensor G3 with the
 * guest's vCPUs. Phase B moves the worker to the host over vsock.
 *
 * Output is one JSON line per shape on the VM console, plus a CPU line, so the
 * host side can compare directly with the S21+ and x86 rungs in REPORT.md.
 */
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <time.h>
#include <unistd.h>
#include <android/log.h>

#include "vm_payload.h"
#include "anchor-core.h"
#include "shielded-field.h"

#define TAG "anchor-pvm"
#define OUT(...) do { printf(__VA_ARGS__); printf("\n"); fflush(stdout); \
                      __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__); } while (0)

static int rng_os(void *buf, size_t n) {
    uint8_t *p = buf;
    while (n) { ssize_t r = getrandom(p, n, 0); if (r < 0) return -1; p += r; n -= (size_t)r; }
    return 0;
}
static double now_us(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e6 + t.tv_nsec / 1e3; }
static int cmp_d(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : x > y; }
static double median(double *v, int n) { qsort(v, (size_t)n, sizeof *v, cmp_d); return v[n / 2]; }

/* deterministic integer fixtures, same constants as the other rungs */
static void gen_w(int8_t *W, int64_t K, int64_t N, uint32_t seed) {
    uint32_t s = seed;
    for (int64_t i = 0; i < K * N; i++) { s = (uint32_t)(s * 1103515245u + 12345u) & 0x7fffffff; W[i] = (int8_t)((int)(s % 239) - 119); }
}
static void gen_x(int64_t *x, int64_t K, uint32_t seed, uint32_t idx, int xmax) {
    uint32_t s = seed ^ (idx * 2654435761u);
    for (int64_t i = 0; i < K; i++) { s = (uint32_t)(s * 1103515245u + 12345u) & 0x7fffffff; x[i] = (int64_t)(s % (2 * xmax + 1)) - xmax; }
}

/* THE UNTRUSTED HALF (in-guest for phase A): public weights + ciphertext planes -> masked products */
static void worker(const int8_t *planes, int64_t K, const int8_t *const *W, const int64_t *N, int n_nodes,
                   int64_t *xm, uint8_t *reply) {
    const int8_t *p0 = planes, *p1 = planes + K, *p2 = planes + 2 * K;
    for (int64_t k = 0; k < K; k++) xm[k] = sh_crt(p0[k], p1[k], p2[k]);
    size_t off = 0;
    for (int nd = 0; nd < n_nodes; nd++)
        for (int64_t j = 0; j < N[nd]; j++) {
            const int8_t *w = W[nd] + j * K; int64_t acc = 0;
            for (int64_t k = 0; k < K; k++) acc += xm[k] * w[k];
            int32_t b = (int32_t)sh_balanced(acc); memcpy(reply + off, &b, 4); off += 4;
        }
}

static void run_shape(int64_t K, int64_t N, int n_nodes, int iters) {
    int xmax = (int)(900.0 * 1.0 / (K > 896 ? 2.33 : 1.0));   /* ~1/sqrt(K) scaling, as the harness does */
    int8_t *W[AN_MAX_NODES] = {0}; int64_t Ns[AN_MAX_NODES], Ks[AN_MAX_NODES];
    for (int i = 0; i < n_nodes; i++) { W[i] = malloc((size_t)K * N); gen_w(W[i], K, N, 0x2f6e2b1u + (uint32_t)i); Ns[i] = N; Ks[i] = K; }
    size_t rlen = (size_t)n_nodes * N * 4;
    int64_t *x = malloc((size_t)K * 8), *xm = malloc((size_t)K * 8);
    int8_t *planes = malloc((size_t)3 * K), *planes2 = malloc((size_t)3 * K);
    uint8_t *reply = malloc(rlen);
    an_ctx *a = an_create(rng_os);
    if (!a || !x || !xm || !planes || !planes2 || !reply) { OUT("{\"K\":%" PRId64 ",\"error\":\"oom\"}", K); return; }
    for (int i = 0; i < n_nodes; i++) an_add_weight(a, W[i], K, N);
    double t0 = now_us(); int prc = an_prepare(a); double prep = now_us() - t0;
    if (prc != AN_OK) { OUT("{\"K\":%" PRId64 ",\"error\":\"prepare %d\"}", K, prc); return; }

    int exact = 1, verified = 1, lie_rejected = 0, pads_distinct = 0, done = 0;
    /* pads_distinct: same x under two pads must give different planes */
    gen_x(x, K, 0x2f6e2b1u, 0, xmax);
    an_pad_gen(a); an_mask(a, x, planes);  worker(planes, K, (const int8_t *const *)W, Ns, n_nodes, xm, reply); if (an_finish(a, reply, rlen, 4) != AN_OK) verified = 0;
    an_pad_gen(a); an_mask(a, x, planes2); worker(planes2, K, (const int8_t *const *)W, Ns, n_nodes, xm, reply); if (an_finish(a, reply, rlen, 4) != AN_OK) verified = 0;
    pads_distinct = memcmp(planes, planes2, (size_t)3 * K) != 0;
    /* lie_rejected: one flipped bit in the reply must be refused */
    gen_x(x, K, 0x2f6e2b1u, 1, xmax);
    an_pad_gen(a); an_mask(a, x, planes); worker(planes, K, (const int8_t *const *)W, Ns, n_nodes, xm, reply);
    reply[rlen / 2] ^= 1; lie_rejected = an_finish(a, reply, rlen, 4) == AN_ERR_VERIFY;

    double *tp = malloc(iters * 8), *tm = malloc(iters * 8), *tw = malloc(iters * 8), *tf = malloc(iters * 8);
    uint64_t digest = 1469598103934665603ull;
    for (int it = 0; it < iters; it++) {
        gen_x(x, K, 0x2f6e2b1u, 100 + (uint32_t)it, xmax);
        double a0 = now_us(); if (an_pad_gen(a) != AN_OK) break;
        double a1 = now_us(); if (an_mask(a, x, planes) != AN_OK) break;
        double a2 = now_us(); worker(planes, K, (const int8_t *const *)W, Ns, n_nodes, xm, reply);
        double a3 = now_us(); int rc = an_finish(a, reply, rlen, 4);
        double a4 = now_us();
        if (rc != AN_OK) { verified = 0; break; }
        if (an_check_local(a) != AN_OK) { exact = 0; break; }
        for (int nd = 0; nd < n_nodes; nd++) { digest ^= an_y_digest(a, nd); digest *= 1099511628211ull; }
        tp[it] = a1 - a0; tm[it] = a2 - a1; tw[it] = a3 - a2; tf[it] = a4 - a3; done++;
    }
    uint64_t pads = 0, ex = 0, vf = 0; an_stats(a, &pads, &ex, &vf);
    OUT("{\"rung\":\"avf-pvm\",\"K\":%" PRId64 ",\"N\":%" PRId64 ",\"nodes\":%d,\"iters\":%d,\"done\":%d,"
        "\"exact\":%s,\"verified\":%s,\"lie_rejected\":%s,\"pads_distinct\":%s,"
        "\"footprint_kb\":%zu,\"prepare_us\":%.0f,\"y_digest\":\"%016" PRIx64 "\","
        "\"median_us\":{\"pad\":%.1f,\"mask\":%.1f,\"worker\":%.1f,\"finish\":%.1f},"
        "\"pads_issued\":%" PRIu64 ",\"verify_fail\":%" PRIu64 ",\"PASS\":%s}",
        K, N, n_nodes, iters, done, exact?"true":"false", verified?"true":"false",
        lie_rejected?"true":"false", pads_distinct?"true":"false",
        an_footprint(n_nodes, Ks, Ns) / 1024, prep, digest,
        done?median(tp,done):0, done?median(tm,done):0, done?median(tw,done):0, done?median(tf,done):0,
        pads, vf, (exact&&verified&&lie_rejected&&pads_distinct&&done==iters)?"true":"false");
    an_destroy(a);
    for (int i = 0; i < n_nodes; i++) free(W[i]);
    free(x); free(xm); free(planes); free(planes2); free(reply); free(tp); free(tm); free(tw); free(tf);
}

int AVmPayload_main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    OUT("ANCHOR start in pVM apk=%s", AVmPayload_getApkContentsPath());
    AVmPayload_notifyPayloadReady();
    /* what silicon does the guest actually see? */
    {
        FILE *f = fopen("/proc/cpuinfo", "r"); char line[1024]; char feats[1024] = "?";
        if (f) { while (fgets(line, sizeof line, f)) if (!strncmp(line, "Features", 8)) { strncpy(feats, line + 10, sizeof feats - 1); break; } fclose(f); }
        feats[strcspn(feats, "\n")] = 0;
        OUT("ANCHOR cpu nproc=%ld features=%s", sysconf(_SC_NPROCESSORS_ONLN), feats);
    }
    run_shape(256, 256, 1, 30);
    run_shape(896, 896, 1, 30);
    run_shape(896, 4864, 2, 12);
    OUT("ANCHOR end");
    sleep(2);
    return 0;
}
