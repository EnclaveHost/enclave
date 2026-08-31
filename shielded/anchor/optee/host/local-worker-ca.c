/*
 * local-worker-ca -- the whole anchor split, inside one QEMU boot, no network.
 *
 * This is the demonstration the spike was for: masked activations leave a
 * TrustZone TA, an UNTRUSTED normal-world process does the linear algebra on
 * the ciphertext, and the TA unmasks, verifies over the integers, and reports.
 *
 * The normal-world half here plays the GPU worker's exact role. It holds the
 * PUBLIC weights (weight secrecy is a non-goal, per docs/shielded-inference.md)
 * and receives only the three residue planes of the masked activation, which
 * are uniform over the field by construction. It reconstructs the masked value
 * per element with CRT and accumulates the product -- the same arithmetic
 * worker.cu performs on the card, in scalar C:
 *
 *     xm[k] = crt(p0[k], p1[k], p2[k])          (balanced, = x + r mod M)
 *     y[j]  = balanced( sum_k xm[k] * W[j][k] )
 *
 * It never sees x, r, u = r.W, the Freivalds secrets, or an unmasked y. Those
 * exist only inside the TA. That is the property the whole tier rests on, and
 * running it this way makes the boundary a process boundary and a world switch
 * rather than a comment.
 *
 * It also measures what only real hardware (or an emulator) can show: the cost
 * of a TEEC_InvokeCommand round trip, which is the TA equivalent of the network
 * round trip that dominates the phone-anchored measurements.
 */
#include <err.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <tee_client_api.h>

#include "anchor_ta.h"
#include "shielded-field.h"

static double now_us(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e6 + ts.tv_nsec / 1e3;
}
static int cmp_d(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return x < y ? -1 : x > y;
}
static double median(double *v, int n) { qsort(v, (size_t)n, sizeof *v, cmp_d); return v[n / 2]; }

/* THE UNTRUSTED HALF: public weights + ciphertext planes -> masked products. */
static void worker_gemm(const int8_t *planes, int64_t K, const int8_t *W,
                        int64_t N, int32_t *y_out, int ywidth, uint8_t *reply)
{
    const int8_t *p0 = planes, *p1 = planes + K, *p2 = planes + 2 * K;
    int64_t *xm = malloc((size_t)K * sizeof(int64_t));
    if (!xm) errx(2, "oom");
    for (int64_t k = 0; k < K; k++)
        xm[k] = sh_crt(p0[k], p1[k], p2[k]);          /* balanced masked value */
    for (int64_t j = 0; j < N; j++) {
        const int8_t *w = W + j * K;
        int64_t acc = 0;
        for (int64_t k = 0; k < K; k++) acc += xm[k] * w[k];
        const int64_t b = sh_balanced(acc);
        y_out[j] = (int32_t)b;
        if (ywidth == 3) {
            reply[3 * j] = (uint8_t)b; reply[3 * j + 1] = (uint8_t)(b >> 8); reply[3 * j + 2] = (uint8_t)(b >> 16);
        } else {
            memcpy(reply + 4 * j, &b, 4);
        }
    }
    free(xm);
}

/* the fixture, integer-only so it matches the TA's gen_x exactly */
static void gen_weights(int8_t *W, int64_t K, int64_t N, uint32_t seed) {
    uint32_t s = seed;
    for (int64_t i = 0; i < K * N; i++) {
        s = (uint32_t)(s * 1103515245u + 12345u) & 0x7fffffff;
        W[i] = (int8_t)((int)(s % 239) - 119);        /* within the int8 lane */
    }
}

int main(int argc, char **argv) {
    int64_t K = 256, N = 256;
    int iters = 50, ywidth = 4;
    for (int i = 1; i < argc - 1; i++) {
        if (!strcmp(argv[i], "--k")) K = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--n")) N = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--iters")) iters = atoi(argv[++i]);
    }

    int8_t *W = malloc((size_t)K * N);
    int8_t *planes = malloc((size_t)3 * K);
    int32_t *y = malloc((size_t)N * sizeof(int32_t));
    uint8_t *reply = malloc((size_t)N * 4);
    if (!W || !planes || !y || !reply) errx(2, "oom");
    gen_weights(W, K, N, 0x2f6e2b1u);

    /* SETUP blob: n_nodes, (K,N), then w_fixed -- public weights into the TA */
    size_t blob_len = 4 + 8 + (size_t)K * N;
    uint8_t *blob = malloc(blob_len);
    if (!blob) errx(2, "oom");
    uint32_t u32 = 1; memcpy(blob, &u32, 4);
    u32 = (uint32_t)K; memcpy(blob + 4, &u32, 4);
    u32 = (uint32_t)N; memcpy(blob + 8, &u32, 4);
    memcpy(blob + 12, W, (size_t)K * N);

    TEEC_Context ctx; TEEC_Session sess; TEEC_Operation op; uint32_t eo = 0;
    TEEC_UUID uuid = TA_ANCHOR_UUID;
    if (TEEC_InitializeContext(NULL, &ctx) != TEEC_SUCCESS) errx(2, "TEEC_InitializeContext");
    if (TEEC_OpenSession(&ctx, &sess, &uuid, TEEC_LOGIN_PUBLIC, NULL, NULL, &eo) != TEEC_SUCCESS)
        errx(2, "TEEC_OpenSession failed (eo=0x%x) -- is the TA installed in /lib/optee_armtz?", eo);

    memset(&op, 0, sizeof op);
    op.paramTypes = TEEC_PARAM_TYPES(TEEC_MEMREF_TEMP_INPUT, TEEC_VALUE_OUTPUT, TEEC_NONE, TEEC_NONE);
    op.params[0].tmpref.buffer = blob; op.params[0].tmpref.size = blob_len;
    double t0 = now_us();
    if (TEEC_InvokeCommand(&sess, TA_ANCHOR_CMD_SETUP, &op, &eo) != TEEC_SUCCESS)
        errx(2, "SETUP failed (eo=0x%x)", eo);
    const double setup_us = now_us() - t0;
    const uint32_t footprint_kb = op.params[1].value.a;

    /* NOP: the bare world-switch + marshal floor */
    double tnop[32];
    for (int i = 0; i < 32; i++) {
        memset(&op, 0, sizeof op);
        op.paramTypes = TEEC_PARAM_TYPES(TEEC_NONE, TEEC_NONE, TEEC_NONE, TEEC_NONE);
        double a = now_us();
        if (TEEC_InvokeCommand(&sess, TA_ANCHOR_CMD_NOP, &op, &eo) != TEEC_SUCCESS) errx(2, "NOP");
        tnop[i] = now_us() - a;
    }

    double *tp = malloc((size_t)iters * sizeof(double)), *tm = malloc((size_t)iters * sizeof(double));
    double *tw = malloc((size_t)iters * sizeof(double)), *tf = malloc((size_t)iters * sizeof(double));
    if (!tp || !tm || !tw || !tf) errx(2, "oom");

    int exact = 1, verified = 1, lie_rejected = 0, pads_distinct = 0, done = 0;
    uint8_t *first_planes = malloc((size_t)3 * K);
    if (!first_planes) errx(2, "oom");

    for (int it = 0; it < iters; it++) {
        double a0 = now_us();
        memset(&op, 0, sizeof op);
        op.paramTypes = TEEC_PARAM_TYPES(TEEC_NONE, TEEC_NONE, TEEC_NONE, TEEC_NONE);
        if (TEEC_InvokeCommand(&sess, TA_ANCHOR_CMD_PAD, &op, &eo) != TEEC_SUCCESS) { warnx("PAD failed"); break; }
        double a1 = now_us();

        memset(&op, 0, sizeof op);
        op.paramTypes = TEEC_PARAM_TYPES(TEEC_VALUE_INPUT, TEEC_MEMREF_TEMP_OUTPUT, TEEC_NONE, TEEC_NONE);
        op.params[0].value.a = 0x2f6e2b1u; op.params[0].value.b = (uint32_t)it;
        op.params[1].tmpref.buffer = planes; op.params[1].tmpref.size = (size_t)3 * K;
        if (TEEC_InvokeCommand(&sess, TA_ANCHOR_CMD_MASK, &op, &eo) != TEEC_SUCCESS) { warnx("MASK failed"); break; }
        double a2 = now_us();

        /* same activation index 0 twice at the start: the planes must differ */
        if (it == 0) memcpy(first_planes, planes, (size_t)3 * K);
        if (it == 1) pads_distinct = memcmp(first_planes, planes, (size_t)3 * K) != 0;

        worker_gemm(planes, K, W, N, y, ywidth, reply);
        double a3 = now_us();

        memset(&op, 0, sizeof op);
        op.paramTypes = TEEC_PARAM_TYPES(TEEC_MEMREF_TEMP_INPUT, TEEC_VALUE_INPUT, TEEC_VALUE_OUTPUT, TEEC_NONE);
        op.params[0].tmpref.buffer = reply; op.params[0].tmpref.size = (size_t)N * ywidth;
        op.params[1].value.a = (uint32_t)ywidth;
        if (TEEC_InvokeCommand(&sess, TA_ANCHOR_CMD_FINISH, &op, &eo) != TEEC_SUCCESS) { warnx("FINISH failed"); break; }
        double a4 = now_us();
        if (!op.params[2].value.a) { verified = 0; warnx("verification failed at iter %d", it); break; }
        if (!op.params[2].value.b) { exact = 0; warnx("TA-local equality failed at iter %d", it); break; }

        tp[it] = a1 - a0; tm[it] = a2 - a1; tw[it] = a3 - a2; tf[it] = a4 - a3;
        done++;
    }

    /* a corrupted reply must be refused */
    memset(&op, 0, sizeof op);
    op.paramTypes = TEEC_PARAM_TYPES(TEEC_NONE, TEEC_NONE, TEEC_NONE, TEEC_NONE);
    if (TEEC_InvokeCommand(&sess, TA_ANCHOR_CMD_PAD, &op, &eo) == TEEC_SUCCESS) {
        memset(&op, 0, sizeof op);
        op.paramTypes = TEEC_PARAM_TYPES(TEEC_VALUE_INPUT, TEEC_MEMREF_TEMP_OUTPUT, TEEC_NONE, TEEC_NONE);
        op.params[0].value.a = 0x2f6e2b1u; op.params[0].value.b = 9999;
        op.params[1].tmpref.buffer = planes; op.params[1].tmpref.size = (size_t)3 * K;
        if (TEEC_InvokeCommand(&sess, TA_ANCHOR_CMD_MASK, &op, &eo) == TEEC_SUCCESS) {
            worker_gemm(planes, K, W, N, y, ywidth, reply);
            reply[(N / 2) * ywidth] ^= 1;                     /* one flipped bit */
            memset(&op, 0, sizeof op);
            op.paramTypes = TEEC_PARAM_TYPES(TEEC_MEMREF_TEMP_INPUT, TEEC_VALUE_INPUT, TEEC_VALUE_OUTPUT, TEEC_NONE);
            op.params[0].tmpref.buffer = reply; op.params[0].tmpref.size = (size_t)N * ywidth;
            op.params[1].value.a = (uint32_t)ywidth;
            if (TEEC_InvokeCommand(&sess, TA_ANCHOR_CMD_FINISH, &op, &eo) == TEEC_SUCCESS)
                lie_rejected = (op.params[2].value.a == 0);
        }
    }

    memset(&op, 0, sizeof op);
    op.paramTypes = TEEC_PARAM_TYPES(TEEC_VALUE_OUTPUT, TEEC_NONE, TEEC_NONE, TEEC_NONE);
    TEEC_InvokeCommand(&sess, TA_ANCHOR_CMD_STATS, &op, &eo);
    const uint32_t pads = op.params[0].value.a, vfail = op.params[0].value.b;

    const int pass = exact && verified && lie_rejected && pads_distinct && done == iters;
    printf("{\"rung\":\"optee-qemu\",\"exact\":%s,\"verified\":%s,\"lie_rejected\":%s,"
           "\"pads_distinct\":%s,\"iters\":%d,\"done\":%d,\"K\":%" PRId64 ",\"N\":%" PRId64 ","
           "\"ta_heap_kb\":%u,\"setup_us\":%.0f,"
           "\"median_us\":{\"nop\":%.1f,\"pad\":%.1f,\"mask\":%.1f,\"worker\":%.1f,\"finish\":%.1f},"
           "\"pads_issued\":%u,\"verify_fail\":%u,\"PASS\":%s}\n",
           exact?"true":"false", verified?"true":"false", lie_rejected?"true":"false",
           pads_distinct?"true":"false", iters, done, K, N, footprint_kb, setup_us,
           median(tnop,32), done?median(tp,done):0.0, done?median(tm,done):0.0,
           done?median(tw,done):0.0, done?median(tf,done):0.0,
           pads, vfail, pass?"true":"false");

    TEEC_CloseSession(&sess); TEEC_FinalizeContext(&ctx);
    return pass ? 0 : 1;
}
