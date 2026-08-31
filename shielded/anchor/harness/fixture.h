/*
 * fixture.h -- the spike's deterministic test weights and activations.
 *
 * Same LCG as wasm/ggml-shielded/shielded-probe.c, so a failure reproduces
 * from the log and the numbers are comparable with the probe's. The fixture
 * is PUBLIC by construction (it stands in for public weights and for a test
 * activation); nothing here handles a secret.
 *
 * Weights are produced in q8_0-shaped (wq, wd) halves and encoded to THE
 * fixed-point form via sh_encode_weight_fixed -- float math, which is why
 * fixture generation lives in the NORMAL-WORLD side of every harness (the TA
 * needs no floating point at all; it receives w_fixed bytes).
 */
#ifndef ANCHOR_FIXTURE_H
#define ANCHOR_FIXTURE_H

#include "shielded-field.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

typedef struct { uint32_t s; } fx_rng;

static double fx_rnd(fx_rng *g) {
    g->s = (uint32_t)(g->s * 1103515245u + 12345u) & 0x7fffffff;
    return (double)g->s / (double)0x7fffffff;
}

static uint16_t fx_float_to_half(float v) {
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

/* One weight, (N,K) int8 in THE encoding, row per output -- what both the
 * anchor core and the worker install path take. Returns malloc'd buffer. */
static int8_t *fx_weight(fx_rng *g, int64_t K, int64_t N) {
    uint16_t *wd = (uint16_t *)malloc((size_t)(K / SH_QK) * N * 2);
    int8_t   *wq = (int8_t *)malloc((size_t)K * N);
    int8_t   *wr = (int8_t *)malloc((size_t)N * K);
    if (!wd || !wq || !wr) { free(wd); free(wq); free(wr); return NULL; }
    for (int64_t i = 0; i < (K / SH_QK) * N; i++)
        wd[i] = fx_float_to_half((float)(0.001 + fx_rnd(g) * 0.0025));
    for (int64_t i = 0; i < K * N; i++)
        wq[i] = (int8_t)lrint((fx_rnd(g) * 2 - 1) * 127);
    for (int64_t k = 0; k < K; k++)
        for (int64_t j = 0; j < N; j++)
            wr[(size_t)j * K + k] = (int8_t)sh_encode_weight_fixed(
                wd[(size_t)(k / SH_QK) * N + j], wq[(size_t)k * N + j]);
    free(wd); free(wq);
    return wr;
}

/* One activation row, K balanced field elements in |x| <= xmax. The caller
 * picks xmax to stand in for the site's calibrated exponent; 900 is the
 * probe's value and is right for K=896. */
static void fx_activation(fx_rng *g, int64_t K, int64_t *x, int xmax) {
    for (int64_t i = 0; i < K; i++) x[i] = (int64_t)lrint((fx_rnd(g) * 2 - 1) * (double)xmax);
}

#define FX_SEED 0x2f6e2b1u   /* the probe's seed */

#endif
