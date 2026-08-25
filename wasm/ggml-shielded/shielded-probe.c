/*
 * shielded-probe -- one real masked GEMM through the C stack, asserted four ways.
 *
 * The C counterpart of metal/guest/shielded-probe.mjs, and the thing that proves
 * shielded-field/-wire/-tee actually talk to a live worker rather than merely
 * compiling. It asserts, against the bytes that really crossed the socket:
 *   exact         the unmasked product equals a local int64 reference
 *   verified      Freivalds accepts the honest result
 *   lie_rejected  Freivalds rejects a single-element corruption
 *   denylist      the worker refuses a denylisted op ON THE WIRE
 *
 * The FIXTURE is a seeded LCG so a failure reproduces from the log. The Freivalds
 * secret is NOT part of the fixture -- it comes from the OS CSPRNG inside
 * shielded-tee, because "lie_rejected" only means something if the worker could
 * not have predicted s.
 */
#include "shielded-field.h"
#include "shielded-tee.h"
#include "shielded-wire.h"

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>

static uint32_t seed = 0x2f6e2b1;
static double rnd(void) { seed = (uint32_t)(seed * 1103515245u + 12345u) & 0x7fffffff; return (double)seed / (double)0x7fffffff; }

static uint16_t float_to_half(float v) {
    uint32_t x; memcpy(&x, &v, 4);
    uint32_t sign = (x >> 16) & 0x8000;
    int exp = (int)((x >> 23) & 0xff) - 127 + 15;
    uint32_t man = (x >> 13) & 0x3ff;
    if (exp <= 0) {
        int shift = 1 - exp;
        if (shift > 24) return (uint16_t)sign;
        man = ((x & 0x7fffff) | 0x800000) >> (13 + shift);
        return (uint16_t)(sign | man);
    }
    if (exp >= 31) return (uint16_t)(sign | 0x7c00);
    return (uint16_t)(sign | ((uint32_t)exp << 10) | man);
}

int main(int argc, char **argv) {
    const char *host = "127.0.0.1";
    int port = 9500, K = 512, N = 256, m = 1;
    for (int i = 1; i < argc - 1; i++) {
        if (!strcmp(argv[i], "--host")) host = argv[++i];
        else if (!strcmp(argv[i], "--port")) port = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--k")) K = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--n")) N = atoi(argv[++i]);
    }

    int8_t   *wq = malloc((size_t)K * N);
    uint16_t *wd = malloc((size_t)(K / SH_QK) * N * 2);
    int64_t  *x  = malloc((size_t)m * K * sizeof(int64_t));
    int64_t  *y  = malloc((size_t)m * N * sizeof(int64_t));
    int64_t  *want = malloc((size_t)m * N * sizeof(int64_t));
    int8_t   *wf = malloc((size_t)K * N);
    if (!wq || !wd || !x || !y || !want || !wf) { fprintf(stderr, "oom\n"); return 2; }

    for (int i = 0; i < (K / SH_QK) * N; i++) wd[i] = float_to_half((float)(0.001 + rnd() * 0.0025));
    for (int i = 0; i < K * N; i++) wq[i] = (int8_t)lrint((rnd() * 2 - 1) * 127);
    for (int i = 0; i < m * K; i++) x[i] = (int64_t)lrint((rnd() * 2 - 1) * 900);

    /* Independent reference: recompute the encoding and the product in int64. */
    for (int k = 0; k < K; k++)
        for (int j = 0; j < N; j++)
            wf[(size_t)k * N + j] = (int8_t)sh_encode_weight_fixed(wd[(size_t)(k / SH_QK) * N + j],
                                                                   wq[(size_t)k * N + j]);
    int64_t peak = 0;
    for (int i = 0; i < m; i++)
        for (int j = 0; j < N; j++) {
            int64_t acc = 0;
            for (int k = 0; k < K; k++) acc += x[(size_t)i * K + k] * wf[(size_t)k * N + j];
            want[(size_t)i * N + j] = acc;
            int64_t a = acc < 0 ? -acc : acc;
            if (a > peak) peak = a;
        }

    int err = SH_OK;
    sh_link *l = sh_link_open(host, port, true, &err);
    if (!l) { fprintf(stderr, "open failed\n"); return 2; }
    int node = sh_link_add_weight(l, "probe", wq, wd, K, N, m, -1);
    if (node < 0) { fprintf(stderr, "add_weight: %s\n", sh_link_last_error(l)); return 2; }
    if ((err = sh_link_start(l)) != SH_OK) { fprintf(stderr, "start: %s\n", sh_link_last_error(l)); return 2; }

    int64_t *outs[1] = { y };
    int nodes[1] = { node };
    if ((err = sh_link_gemm(l, nodes, 1, x, m, outs)) != SH_OK) {
        fprintf(stderr, "gemm: %s\n", sh_link_last_error(l)); return 2;
    }

    int exact = 1;
    for (int i = 0; i < m * N; i++) if (y[i] != sh_balanced(want[i])) { exact = 0; break; }

    /* Both directions, against the same checker the online path uses. Asserting
     * only that it ACCEPTS the honest product would pass just as happily if the
     * check were `return true`. */
    int verified = sh_link_verify(l, node, x, y, m) ? 1 : 0;
    int64_t save = y[N / 2];
    y[N / 2] = save + 1;                /* a single-element lie */
    int lie_rejected = sh_link_verify(l, node, x, y, m) ? 0 : 1;
    y[N / 2] = save;

    uint64_t ex = 0, macs = 0, vf = 0;
    sh_link_stats(l, &ex, &macs, &vf);
    sh_link_close(l);

    /* The denylist, on the wire, on its own connection (install is once-only). */
    int denylist = 0;
    sh_pipe *p = sh_pipe_open(host, port, &err);
    if (p) {
        uint8_t pay[64]; sh_reply rep;
        size_t n = sh_pack_hello(pay, 1);
        if (sh_pipe_call(p, SH_CMD_HELLO, pay, n, &rep) == SH_OK) {
            sh_reply_free(&rep);
            n = sh_pack_alloc(pay, 4096, "activations");
            if (sh_pipe_call(p, SH_CMD_ALLOC_BUFFER, pay, n, &rep) == SH_OK) sh_reply_free(&rep);
            const char *bad = "{\"nodes\":[{\"op\":\"SOFT_MAX\"}],"
                              "\"outputs\":[{\"bid\":1,\"offset\":0,\"nbytes\":16}]}";
            int rc = sh_pipe_call(p, SH_CMD_GRAPH_INSTALL, bad, strlen(bad), &rep);
            denylist = (rc == SH_ERR_VIOLATION);
            if (denylist) fprintf(stderr, "worker refused as expected: %s\n", sh_pipe_last_error(p));
            if (rc == SH_OK) sh_reply_free(&rep);
        }
        sh_pipe_close(p);
    }

    printf("{\"exact\":%s,\"verified\":%s,\"lie_rejected\":%s,\"denylist_refused\":%s,"
           "\"peak_abs_y\":%lld,\"field_headroom\":%.2f,\"K\":%d,\"N\":%d,"
           "\"exchanges\":%llu,\"macs\":%llu,\"verify_fail\":%llu}\n",
           exact ? "true" : "false", verified ? "true" : "false",
           lie_rejected ? "true" : "false", denylist ? "true" : "false",
           (long long)peak, (double)SH_HALF_M / (double)(peak ? peak : 1), K, N,
           (unsigned long long)ex, (unsigned long long)macs, (unsigned long long)vf);
    return (exact && verified && lie_rejected && denylist && vf == 0) ? 0 : 1;
}
