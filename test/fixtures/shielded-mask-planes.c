/* mask_planes produces the three byte planes that CROSS to the untrusted
 * worker. It used to reduce x+r modulo M before reducing modulo each Q; that
 * reduction is redundant, because M = Q0*Q1*Q2, so ((x+r) mod M) mod Q equals
 * (x+r) mod Q. Removing it is a performance change to the masking kernel, so
 * "the tests passed" is not the standard: the planes must be identical for
 * EVERY input the kernel can be handed.
 *
 * They can be. The kernel's contract is |x| < SH_FV_X_LIMIT = 2^26 (enforced
 * at the link boundary by values_within, before any pad is taken) and
 * 0 <= r < M, so w = x + r ranges over (-2^26, 2^26 + M) -- about 1.5e8
 * values, which is exhaustible. This walks all of them and compares the old
 * formula against the new one, per plane. Then it runs the real kernels from
 * both SIMD tables against the OLD formula over random and boundary (x, r).
 *
 * If the reduction were NOT redundant this exits non-zero on the first w. */
#include "../../wasm/ggml-shielded/shielded-field.h"
#include "../../wasm/ggml-shielded/shielded-simd.h"

#include <assert.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#define Q0 251
#define Q1 241
#define Q2 239
#define M_MOD ((int32_t)SH_M_MOD)

static inline int32_t modq(int32_t v, int32_t q, float inv) {
    int32_t t = (int32_t)((float)v * inv);
    int32_t r = v - t * q;
    r += (r < 0) ? q : 0;
    r -= (r >= q) ? q : 0;
    return r;
}
/* Exactly the code that was removed, kept here as the thing to match. */
static void old_planes(int64_t x, int32_t r, int8_t *o0, int8_t *o1, int8_t *o2) {
    const double invM = 1.0 / (double)M_MOD;
    int64_t v = x + r;
    int64_t t = (int64_t)((double)v * invM);
    v -= t * M_MOD;
    v += (v < 0) ? M_MOD : 0;
    v -= (v >= M_MOD) ? M_MOD : 0;
    const int32_t w = (int32_t)v;
    int32_t a0 = modq(w, Q0, 1.0f / Q0), a1 = modq(w, Q1, 1.0f / Q1), a2 = modq(w, Q2, 1.0f / Q2);
    a0 -= (a0 > Q0 / 2) ? Q0 : 0;
    a1 -= (a1 > Q1 / 2) ? Q1 : 0;
    a2 -= (a2 > Q2 / 2) ? Q2 : 0;
    *o0 = (int8_t)a0; *o1 = (int8_t)a1; *o2 = (int8_t)a2;
}
static void new_planes_from_w(int32_t w, int8_t *o0, int8_t *o1, int8_t *o2) {
    int32_t a0 = modq(w, Q0, 1.0f / Q0), a1 = modq(w, Q1, 1.0f / Q1), a2 = modq(w, Q2, 1.0f / Q2);
    a0 -= (a0 > Q0 / 2) ? Q0 : 0;
    a1 -= (a1 > Q1 / 2) ? Q1 : 0;
    a2 -= (a2 > Q2 / 2) ? Q2 : 0;
    *o0 = (int8_t)a0; *o1 = (int8_t)a1; *o2 = (int8_t)a2;
}
/* The old formula expressed on w alone, so the sweep needs one variable. */
static void old_planes_from_w(int32_t w, int8_t *o0, int8_t *o1, int8_t *o2) {
    const double invM = 1.0 / (double)M_MOD;
    int64_t v = w;
    int64_t t = (int64_t)((double)v * invM);
    v -= t * M_MOD;
    v += (v < 0) ? M_MOD : 0;
    v -= (v >= M_MOD) ? M_MOD : 0;
    new_planes_from_w((int32_t)v, o0, o1, o2);
}

static uint64_t rng = 0xcbbf7a44ull;
static uint64_t nextr(void) { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return rng; }

int main(void) {
    /* 1. EXHAUSTIVE over every w the kernel can see. */
    const int64_t lo = -(int64_t)SH_FV_X_LIMIT, hi = (int64_t)SH_FV_X_LIMIT + M_MOD;
    int64_t checked = 0;
    for (int64_t w = lo; w <= hi; w++) {
        int8_t a0, a1, a2, b0, b1, b2;
        old_planes_from_w((int32_t)w, &a0, &a1, &a2);
        new_planes_from_w((int32_t)w, &b0, &b1, &b2);
        if (a0 != b0 || a1 != b1 || a2 != b2) {
            fprintf(stderr, "w=%" PRId64 ": old (%d,%d,%d) new (%d,%d,%d)\n",
                    w, a0, a1, a2, b0, b1, b2);
            return 1;
        }
        checked++;
    }
    fprintf(stderr, "mask-planes: %" PRId64 " values of x+r exhausted, planes identical\n", checked);

    /* 2. The real kernels, against the OLD formula, on (x, r) pairs. */
    const sh_simd *tables[2]; const char *names[2]; int nt = 0;
    tables[nt] = NULL; (void)tables;
    struct { const char *name; void (*fn)(const int64_t *, const int32_t *, size_t, int8_t *, int8_t *, int8_t *); } impl[] = {
        { "generic", sh_simd_generic_mask_planes },
#if !defined(__aarch64__)
        { "avx512",  sh_simd_avx512_mask_planes  },
#else
        { "neon",    sh_simd_neon_mask_planes    },
#endif
    };
    (void)names; (void)nt;
    enum { N = 4096 };
    int64_t *x = malloc(N * sizeof *x); int32_t *r = malloc(N * sizeof *r);
    int8_t *p0 = malloc(N), *p1 = malloc(N), *p2 = malloc(N);
    assert(x && r && p0 && p1 && p2);
    const int64_t xedge[] = { 0, 1, -1, SH_FV_X_LIMIT - 1, -(SH_FV_X_LIMIT - 1), M_MOD, -M_MOD, SH_HALF_M, -SH_HALF_M };
    const int32_t redge[] = { 0, 1, M_MOD - 1, (int32_t)SH_HALF_M, (int32_t)SH_HALF_M + 1 };
    for (size_t t = 0; t < sizeof impl / sizeof impl[0]; t++) {
        for (int round = 0; round < 40; round++) {
            for (int i = 0; i < N; i++) {
                if (round == 0) {          /* every edge pair */
                    x[i] = xedge[i % (int)(sizeof xedge / sizeof xedge[0])];
                    r[i] = redge[(i / 9) % (int)(sizeof redge / sizeof redge[0])];
                } else {
                    x[i] = (int64_t)(nextr() % (2ull * SH_FV_X_LIMIT)) - SH_FV_X_LIMIT + 1;
                    r[i] = (int32_t)(nextr() % (uint64_t)M_MOD);
                }
            }
            impl[t].fn(x, r, N, p0, p1, p2);
            for (int i = 0; i < N; i++) {
                int8_t a0, a1, a2;
                old_planes(x[i], r[i], &a0, &a1, &a2);
                if (a0 != p0[i] || a1 != p1[i] || a2 != p2[i]) {
                    fprintf(stderr, "%s: x=%" PRId64 " r=%d -> old (%d,%d,%d) kernel (%d,%d,%d)\n",
                            impl[t].name, x[i], r[i], a0, a1, a2, p0[i], p1[i], p2[i]);
                    return 1;
                }
            }
        }
        fprintf(stderr, "mask-planes: %s kernel matches the old formula\n", impl[t].name);
    }
    free(x); free(r); free(p0); free(p1); free(p2);
    return 0;
}
