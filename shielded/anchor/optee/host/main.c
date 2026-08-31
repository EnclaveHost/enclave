/*
 * The normal-world CA of the anchor spike: owns the socket to the worker,
 * ferries ciphertext, never sees a secret. The TA (anchor_ta.c) holds the
 * pads, the Freivalds secrets, the plaintext and the unmasked products.
 *
 * Flow per exchange: PAD (TA stages r, u=r.W) -> MASK (TA emits the three
 * residue planes) -> FIELD_GEMM over TCP to the worker -> FINISH (TA unmasks,
 * verifies over the integers, checks bit-equality against its own int64
 * product). The CA times each phase and the NOP invoke (world-switch floor).
 *
 * Same verdict set as harness/split-harness.c, one rung up the ladder.
 */
#include <err.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <tee_client_api.h>

#include "anchor_ta.h"
#include "fixture.h"
#include "worker-client.h"

static double now_us(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e6 + ts.tv_nsec / 1e3;
}
static int cmp_d(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return x < y ? -1 : x > y;
}
static double median(double *v, int n) { qsort(v, (size_t)n, sizeof *v, cmp_d); return v[n / 2]; }

static TEEC_Context ctx;
static TEEC_Session sess;

static TEEC_Result invoke(uint32_t cmd, TEEC_Operation *op) {
    uint32_t eo = 0;
    TEEC_Result r = TEEC_InvokeCommand(&sess, cmd, op, &eo);
    return r;
}

int main(int argc, char **argv) {
    const char *host = "10.0.2.2";     /* QEMU slirp: the host's loopback */
    int port = 9500, iters = 100, n_nodes = 1, force32 = 0;
    int64_t K = 896, N = 896;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--host") && i + 1 < argc) host = argv[++i];
        else if (!strcmp(argv[i], "--port") && i + 1 < argc) port = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--k") && i + 1 < argc) K = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--n") && i + 1 < argc) N = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--nodes") && i + 1 < argc) n_nodes = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--iters") && i + 1 < argc) iters = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--force32")) force32 = 1;
    }
    if (n_nodes < 1 || n_nodes > 8 || iters < 4) errx(2, "bad args");

    /* fixture weights -> SETUP blob */
    fx_rng g = { FX_SEED };
    int8_t *w[8] = { 0 };
    for (int i = 0; i < n_nodes; i++)
        if (!(w[i] = fx_weight(&g, K, N))) errx(2, "oom");
    size_t blob_len = 4 + (size_t)n_nodes * 8;
    for (int i = 0; i < n_nodes; i++) blob_len += (size_t)K * N;
    uint8_t *blob = malloc(blob_len);
    if (!blob) errx(2, "oom");
    uint32_t u32 = (uint32_t)n_nodes; memcpy(blob, &u32, 4);
    size_t off = 4;
    for (int i = 0; i < n_nodes; i++) {
        u32 = (uint32_t)K; memcpy(blob + off, &u32, 4); off += 4;
        u32 = (uint32_t)N; memcpy(blob + off, &u32, 4); off += 4;
    }
    for (int i = 0; i < n_nodes; i++) { memcpy(blob + off, w[i], (size_t)K * N); off += (size_t)K * N; }

    TEEC_UUID uuid = TA_ANCHOR_UUID;
    uint32_t eo = 0;
    if (TEEC_InitializeContext(NULL, &ctx) != TEEC_SUCCESS) errx(2, "TEEC_InitializeContext");
    if (TEEC_OpenSession(&ctx, &sess, &uuid, TEEC_LOGIN_PUBLIC, NULL, NULL, &eo) != TEEC_SUCCESS)
        errx(2, "TEEC_OpenSession (eo=%u)", eo);

    TEEC_Operation op;

    /* SETUP */
    memset(&op, 0, sizeof op);
    op.paramTypes = TEEC_PARAM_TYPES(TEEC_MEMREF_TEMP_INPUT, TEEC_VALUE_OUTPUT,
                                     TEEC_NONE, TEEC_NONE);
    op.params[0].tmpref.buffer = blob; op.params[0].tmpref.size = blob_len;
    double t0 = now_us();
    if (invoke(TA_ANCHOR_CMD_SETUP, &op) != TEEC_SUCCESS) errx(2, "SETUP failed");
    double setup_us = now_us() - t0;
    const uint32_t footprint_kb = op.params[1].value.a;

    /* the worker, over TCP (slirp to the host, or a LAN/tether address) */
    wc_client wc; memset(&wc, 0, sizeof wc);
    for (int i = 0; i < n_nodes; i++)
        if (wc_add(&wc, K, N) < 0) errx(2, "wc_add: %s", wc.err);
    if (wc_connect_install(&wc, host, port, (const int8_t *const *)w, force32) != 0)
        errx(2, "install: %s", wc.err);

    int8_t *planes  = malloc((size_t)3 * K);
    int8_t *planes2 = malloc((size_t)3 * K);
    if (!planes || !planes2) errx(2, "oom");
    const uint8_t *reply; size_t rlen;

    /* NOP: the world-switch + marshal floor */
    double tnop[64];
    for (int i = 0; i < 64; i++) {
        memset(&op, 0, sizeof op);
        op.paramTypes = TEEC_PARAM_TYPES(TEEC_NONE, TEEC_NONE, TEEC_NONE, TEEC_NONE);
        double a = now_us();
        if (invoke(TA_ANCHOR_CMD_NOP, &op) != TEEC_SUCCESS) errx(2, "NOP failed");
        tnop[i] = now_us() - a;
    }

#define PAD() do { memset(&op, 0, sizeof op); \
        op.paramTypes = TEEC_PARAM_TYPES(TEEC_NONE, TEEC_NONE, TEEC_NONE, TEEC_NONE); \
        if (invoke(TA_ANCHOR_CMD_PAD, &op) != TEEC_SUCCESS) errx(2, "PAD failed"); } while (0)

#define MASK(seed, idx, buf) do { memset(&op, 0, sizeof op); \
        op.paramTypes = TEEC_PARAM_TYPES(TEEC_VALUE_INPUT, TEEC_MEMREF_TEMP_OUTPUT, \
                                         TEEC_NONE, TEEC_NONE); \
        op.params[0].value.a = (seed); op.params[0].value.b = (idx); \
        op.params[1].tmpref.buffer = (buf); op.params[1].tmpref.size = (size_t)3 * K; \
        if (invoke(TA_ANCHOR_CMD_MASK, &op) != TEEC_SUCCESS) errx(2, "MASK failed"); } while (0)

    /* FINISH returns (verified, exact) in p2 */
#define FINISH(rep, rl, vfd, exc) do { memset(&op, 0, sizeof op); \
        op.paramTypes = TEEC_PARAM_TYPES(TEEC_MEMREF_TEMP_INPUT, TEEC_VALUE_INPUT, \
                                         TEEC_VALUE_OUTPUT, TEEC_NONE); \
        op.params[0].tmpref.buffer = (void *)(rep); op.params[0].tmpref.size = (rl); \
        op.params[1].value.a = (uint32_t)wc.ywidth; \
        if (invoke(TA_ANCHOR_CMD_FINISH, &op) != TEEC_SUCCESS) errx(2, "FINISH failed"); \
        (vfd) = op.params[2].value.a; (exc) = op.params[2].value.b; } while (0)

    uint32_t vfd, exc;
    int exact = 1, verified = 1, lie_rejected = 0, pads_distinct = 0;

    /* pads_distinct: same (seed,index) twice -> planes must differ */
    PAD(); MASK(FX_SEED, 0, planes);
    if (wc_exchange(&wc, planes, 1, &reply, &rlen) != 0) errx(2, "exchange: %s", wc.err);
    FINISH(reply, rlen, vfd, exc); verified &= vfd; exact &= exc;
    PAD(); MASK(FX_SEED, 0, planes2);
    if (wc_exchange(&wc, planes2, 1, &reply, &rlen) != 0) errx(2, "exchange: %s", wc.err);
    FINISH(reply, rlen, vfd, exc); verified &= vfd; exact &= exc;
    pads_distinct = memcmp(planes, planes2, (size_t)3 * K) != 0;

    /* lie_rejected: one corrupted byte must be refused */
    PAD(); MASK(FX_SEED, 1, planes);
    if (wc_exchange(&wc, planes, 1, &reply, &rlen) != 0) errx(2, "exchange: %s", wc.err);
    {
        uint8_t *evil = malloc(rlen);
        if (!evil) errx(2, "oom");
        memcpy(evil, reply, rlen);
        evil[rlen / 2] ^= 1;
        FINISH(evil, rlen, vfd, exc);
        lie_rejected = vfd == 0;
        free(evil);
    }

    /* the measured loop */
    double *tp = malloc((size_t)iters * sizeof(double)), *tm = malloc((size_t)iters * sizeof(double)),
           *tw = malloc((size_t)iters * sizeof(double)), *tf = malloc((size_t)iters * sizeof(double));
    if (!tp || !tm || !tw || !tf) errx(2, "oom");
    int done = 0;
    for (int it = 0; it < iters; it++) {
        double a0 = now_us();
        PAD();
        double a1 = now_us();
        MASK(FX_SEED, 100 + (uint32_t)it, planes);
        double a2 = now_us();
        if (wc_exchange(&wc, planes, 1, &reply, &rlen) != 0) { fprintf(stderr, "exchange: %s\n", wc.err); break; }
        double a3 = now_us();
        FINISH(reply, rlen, vfd, exc);
        double a4 = now_us();
        if (!vfd) { verified = 0; break; }
        if (!exc) { exact = 0; break; }
        tp[it] = a1 - a0; tm[it] = a2 - a1; tw[it] = a3 - a2; tf[it] = a4 - a3;
        done++;
    }

    /* STATS */
    memset(&op, 0, sizeof op);
    op.paramTypes = TEEC_PARAM_TYPES(TEEC_VALUE_OUTPUT, TEEC_NONE, TEEC_NONE, TEEC_NONE);
    invoke(TA_ANCHOR_CMD_STATS, &op);
    const uint32_t pads = op.params[0].value.a, vfail = op.params[0].value.b;

    wc_close(&wc);
    const int pass = exact && verified && lie_rejected && pads_distinct && done == iters;
    printf("{\"rung\":\"optee\",\"exact\":%s,\"verified\":%s,\"lie_rejected\":%s,"
           "\"pads_distinct\":%s,\"iters\":%d,\"done\":%d,\"ywidth\":%d,"
           "\"K\":%lld,\"N\":%lld,\"nodes\":%d,\"footprint_kb\":%u,\"setup_us\":%.0f,"
           "\"median_us\":{\"nop\":%.1f,\"pad\":%.1f,\"mask\":%.1f,\"wire\":%.1f,\"finish\":%.1f},"
           "\"pads_issued\":%u,\"verify_fail\":%u}\n",
           exact ? "true" : "false", verified ? "true" : "false",
           lie_rejected ? "true" : "false", pads_distinct ? "true" : "false",
           iters, done, wc.ywidth, (long long)K, (long long)N, n_nodes,
           footprint_kb, setup_us,
           median(tnop, 64),
           done ? median(tp, done) : 0.0, done ? median(tm, done) : 0.0,
           done ? median(tw, done) : 0.0, done ? median(tf, done) : 0.0,
           pads, vfail);

    TEEC_CloseSession(&sess);
    TEEC_FinalizeContext(&ctx);
    for (int i = 0; i < n_nodes; i++) free(w[i]);
    free(blob); free(planes); free(planes2); free(tp); free(tm); free(tw); free(tf);
    return pass ? 0 : 1;
}
