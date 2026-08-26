/*
 * shielded-simd.c -- the hot loops of the trusted half.
 *
 * Compiled TWICE by the Makefile: once with the AVX-512 VNNI target
 * (-DSH_SIMD_AVX512, suffix _avx512) and once generic (suffix _generic), and
 * shielded-tee.c picks at run time. The .so has to load on any x86-64 -- a
 * SIGILL inside the engine is not a degraded mode -- and the same C body has to
 * be the reference for its vectorised twin, which is why nearly everything
 * here is plain loops the compiler vectorises rather than intrinsics. The one
 * exception is the refill inner product, where vpdpbusd is the whole point.
 *
 * Every function here is arithmetic on values the TEE already holds. Nothing
 * here touches a socket, and nothing here decides what crosses to the worker.
 */
#include "shielded-field.h"
#include "shielded-simd.h"

#include <math.h>
#include <string.h>

#ifdef SH_SIMD_AVX512
#include <immintrin.h>
#define FN(name) sh_simd_avx512_##name
#else
#define FN(name) sh_simd_generic_##name
#endif

#define Q0 SH_Q0
#define Q1 SH_Q1
#define Q2 SH_Q2
#define M_MOD SH_M_MOD
/* Garner constants: inv(Q0) mod Q1 and inv(Q0*Q1) mod Q2. Asserted against
 * sh_crt by sh_simd_selftest, so a typo here fails loudly rather than quietly. */
#define INV01  217
#define INV012 10

/* v mod q for |v| < 2^28, branch-free and vectorisable: one float estimate of
 * the quotient, then two corrections. The estimate is within 1 of the truth
 * for the whole range, so two corrections are exact. */
static inline int32_t modq(int32_t v, int32_t q, float inv) {
    int32_t t = (int32_t)((float)v * inv);
    int32_t r = v - t * q;
    r += (r < 0) ? q : 0;
    r -= (r >= q) ? q : 0;
    return r;
}

static inline int32_t crt_balanced(int32_t a0, int32_t a1, int32_t a2) {
    const int32_t r0 = modq(a0, Q0, 1.0f / Q0);
    const int32_t r1 = modq(a1, Q1, 1.0f / Q1);
    const int32_t r2 = modq(a2, Q2, 1.0f / Q2);
    const int32_t t1 = modq((r1 - r0) * INV01, Q1, 1.0f / Q1);
    int32_t x = r0 + Q0 * t1;                                   /* < Q0*Q1 */
    const int32_t t2 = modq((r2 - modq(x, Q2, 1.0f / Q2)) * INV012, Q2, 1.0f / Q2);
    x += Q0 * Q1 * t2;                                          /* < M */
    return x > (int32_t)(M_MOD / 2) ? x - (int32_t)M_MOD : x;
}

/* Unsigned residue planes of a pad, [0,q). The pad is in [0,M). */
void FN(pad_planes)(const int32_t *r, size_t n, uint8_t *p0, uint8_t *p1, uint8_t *p2) {
    for (size_t i = 0; i < n; i++) {
        const int32_t v = r[i];
        p0[i] = (uint8_t)modq(v, Q0, 1.0f / Q0);
        p1[i] = (uint8_t)modq(v, Q1, 1.0f / Q1);
        p2[i] = (uint8_t)modq(v, Q2, 1.0f / Q2);
    }
}

/* Balanced residue planes of (x + r) mod M -- what crosses to the worker. x is
 * the plaintext field element (any int64; a value outside the field wraps here
 * and Freivalds catches the consequence), r the one-time pad in [0,M). */
void FN(mask_planes)(const int64_t *x, const int32_t *r, size_t n, int8_t *p0, int8_t *p1, int8_t *p2) {
    const double invM = 1.0 / (double)M_MOD;
    for (size_t i = 0; i < n; i++) {
        int64_t v = x[i] + r[i];
        int64_t t = (int64_t)((double)v * invM);
        v -= t * M_MOD;
        v += (v < 0) ? M_MOD : 0;
        v -= (v >= M_MOD) ? M_MOD : 0;
        const int32_t w = (int32_t)v;
        int32_t a0 = modq(w, Q0, 1.0f / Q0), a1 = modq(w, Q1, 1.0f / Q1), a2 = modq(w, Q2, 1.0f / Q2);
        a0 -= (a0 > Q0 / 2) ? Q0 : 0;
        a1 -= (a1 > Q1 / 2) ? Q1 : 0;
        a2 -= (a2 > Q2 / 2) ? Q2 : 0;
        p0[i] = (int8_t)a0; p1[i] = (int8_t)a1; p2[i] = (int8_t)a2;
    }
}

/* y = balanced(ym - u): both operands already balanced in (-M/2, M/2]. */
void FN(unmask)(const int32_t *ym, const int32_t *u, size_t n, int64_t *y) {
    for (size_t i = 0; i < n; i++) {
        int32_t v = ym[i] - u[i];
        v += (v <= -(int32_t)(M_MOD / 2)) ? (int32_t)M_MOD : 0;
        v -= (v > (int32_t)(M_MOD / 2)) ? (int32_t)M_MOD : 0;
        y[i] = v;
    }
}

/* x_field = round(src * scale). */
void FN(encode)(const float *src, size_t n, float scale, int64_t *x) {
    for (size_t i = 0; i < n; i++) x[i] = (int64_t)lrintf(src[i] * scale);
}

/* dst[j] = y[j] * inv[j], the per-column descale. */
void FN(descale)(const int64_t *y, const float *inv, size_t n, float *dst) {
    for (size_t i = 0; i < n; i++) dst[i] = (float)y[i] * inv[i];
}

/* sum_j y[j] * s[j*stride + rep] mod P2. |y| < 2^24 and |s| < 2^20, so the
 * int64 sum is exact up to N = 2^19 terms; chunk beyond that. */
int64_t FN(fv_dot)(const int64_t *y, const int64_t *s, int stride, int rep, int64_t n) {
    const int64_t P2 = SH_FV_P2;
    int64_t total = 0;
    for (int64_t k0 = 0; k0 < n; k0 += 262144) {
        const int64_t k1 = k0 + 262144 < n ? k0 + 262144 : n;
        int64_t acc = 0;
        for (int64_t j = k0; j < k1; j++) acc += y[j] * s[j * stride + rep];
        acc %= P2; if (acc < 0) acc += P2;
        total = (total + acc) % P2;
    }
    return total;
}

/* sum_k x[k] * st[k*stride + rep] mod P2 for the rhs, where st < 2^31 and x is
 * the plaintext activation (any int64 in practice below 2^31): chunks of 128
 * keep the accumulator under 2^62. */
int64_t FN(fv_dot_x)(const int64_t *x, const int64_t *st, int stride, int rep, int64_t n) {
    const int64_t P2 = SH_FV_P2;
    int64_t total = 0;
    for (int64_t k0 = 0; k0 < n; k0 += 128) {
        const int64_t k1 = k0 + 128 < n ? k0 + 128 : n;
        int64_t acc = 0;
        for (int64_t k = k0; k < k1; k++) acc += x[k] * st[k * stride + rep];
        acc %= P2; if (acc < 0) acc += P2;
        total = (total + acc) % P2;
    }
    return total;
}

/* st[k*REPS+rep] = sum_j W[j][k] * s[j*REPS+rep] mod P2, W in (N,K). Row-wise
 * axpy so the weight streams once; the int64 accumulator holds 2^44 at N=2^17. */
void FN(fv_prepare)(const int8_t *W, int64_t K, int64_t N, const int64_t *s, int reps, int64_t *st) {
    for (int64_t i = 0; i < K * reps; i++) st[i] = 0;
    for (int64_t j = 0; j < N; j++) {
        const int8_t *w = W + j * K;
        for (int rep = 0; rep < reps; rep++) {
            const int64_t sj = s[j * reps + rep];
            int64_t *o = st + rep;
            for (int64_t k = 0; k < K; k++) o[k * reps] += sj * (int64_t)w[k];
        }
    }
    for (int64_t i = 0; i < K * reps; i++) { int64_t v = st[i] % SH_FV_P2; if (v < 0) v += SH_FV_P2; st[i] = v; }
}

/* THE REFILL: u[b][j] = sum_k r[b][k] * W[j][k] over Z_M, from the unsigned
 * residue planes of r, for `b` pads at once. Each weight row is read once per
 * batch and dotted against every pad row in all three planes, so the batch is
 * what amortises the weight stream; the pad planes stay in L1/L2.
 *
 * Accumulators: K * 250 * 119 < 2^31 for K < 72k. No saturation anywhere. */
#ifdef SH_SIMD_AVX512
static inline void refill_rows4(const uint8_t *planes, int b, int b0,
                                const int8_t *W, int64_t K, int64_t N, int32_t *acc /* [3][4][N] */) {
    const int64_t K64 = K & ~(int64_t)63;
    const __mmask64 tail = (K & 63) ? ((__mmask64)1 << (K & 63)) - 1 : 0;
    const uint8_t *pl[3][4];
    for (int p = 0; p < 3; p++)
        for (int r = 0; r < 4; r++) {
            const int row = b0 + r < b ? b0 + r : b - 1;          /* clamp: duplicates are discarded */
            pl[p][r] = planes + ((size_t)p * b + row) * K;
        }
    for (int64_t j = 0; j < N; j++) {
        const int8_t *w = W + j * K;
        __m512i a00 = _mm512_setzero_si512(), a01 = a00, a02 = a00, a03 = a00;
        __m512i a10 = a00, a11 = a00, a12 = a00, a13 = a00;
        __m512i a20 = a00, a21 = a00, a22 = a00, a23 = a00;
        int64_t k = 0;
        for (; k < K64; k += 64) {
            const __m512i wv = _mm512_loadu_si512((const void *)(w + k));
            a00 = _mm512_dpbusd_epi32(a00, _mm512_loadu_si512((const void *)(pl[0][0] + k)), wv);
            a01 = _mm512_dpbusd_epi32(a01, _mm512_loadu_si512((const void *)(pl[0][1] + k)), wv);
            a02 = _mm512_dpbusd_epi32(a02, _mm512_loadu_si512((const void *)(pl[0][2] + k)), wv);
            a03 = _mm512_dpbusd_epi32(a03, _mm512_loadu_si512((const void *)(pl[0][3] + k)), wv);
            a10 = _mm512_dpbusd_epi32(a10, _mm512_loadu_si512((const void *)(pl[1][0] + k)), wv);
            a11 = _mm512_dpbusd_epi32(a11, _mm512_loadu_si512((const void *)(pl[1][1] + k)), wv);
            a12 = _mm512_dpbusd_epi32(a12, _mm512_loadu_si512((const void *)(pl[1][2] + k)), wv);
            a13 = _mm512_dpbusd_epi32(a13, _mm512_loadu_si512((const void *)(pl[1][3] + k)), wv);
            a20 = _mm512_dpbusd_epi32(a20, _mm512_loadu_si512((const void *)(pl[2][0] + k)), wv);
            a21 = _mm512_dpbusd_epi32(a21, _mm512_loadu_si512((const void *)(pl[2][1] + k)), wv);
            a22 = _mm512_dpbusd_epi32(a22, _mm512_loadu_si512((const void *)(pl[2][2] + k)), wv);
            a23 = _mm512_dpbusd_epi32(a23, _mm512_loadu_si512((const void *)(pl[2][3] + k)), wv);
        }
        if (tail) {
            const __m512i wv = _mm512_maskz_loadu_epi8(tail, w + k);
            a00 = _mm512_dpbusd_epi32(a00, _mm512_maskz_loadu_epi8(tail, pl[0][0] + k), wv);
            a01 = _mm512_dpbusd_epi32(a01, _mm512_maskz_loadu_epi8(tail, pl[0][1] + k), wv);
            a02 = _mm512_dpbusd_epi32(a02, _mm512_maskz_loadu_epi8(tail, pl[0][2] + k), wv);
            a03 = _mm512_dpbusd_epi32(a03, _mm512_maskz_loadu_epi8(tail, pl[0][3] + k), wv);
            a10 = _mm512_dpbusd_epi32(a10, _mm512_maskz_loadu_epi8(tail, pl[1][0] + k), wv);
            a11 = _mm512_dpbusd_epi32(a11, _mm512_maskz_loadu_epi8(tail, pl[1][1] + k), wv);
            a12 = _mm512_dpbusd_epi32(a12, _mm512_maskz_loadu_epi8(tail, pl[1][2] + k), wv);
            a13 = _mm512_dpbusd_epi32(a13, _mm512_maskz_loadu_epi8(tail, pl[1][3] + k), wv);
            a20 = _mm512_dpbusd_epi32(a20, _mm512_maskz_loadu_epi8(tail, pl[2][0] + k), wv);
            a21 = _mm512_dpbusd_epi32(a21, _mm512_maskz_loadu_epi8(tail, pl[2][1] + k), wv);
            a22 = _mm512_dpbusd_epi32(a22, _mm512_maskz_loadu_epi8(tail, pl[2][2] + k), wv);
            a23 = _mm512_dpbusd_epi32(a23, _mm512_maskz_loadu_epi8(tail, pl[2][3] + k), wv);
        }
        acc[(0 * 4 + 0) * N + j] = _mm512_reduce_add_epi32(a00);
        acc[(0 * 4 + 1) * N + j] = _mm512_reduce_add_epi32(a01);
        acc[(0 * 4 + 2) * N + j] = _mm512_reduce_add_epi32(a02);
        acc[(0 * 4 + 3) * N + j] = _mm512_reduce_add_epi32(a03);
        acc[(1 * 4 + 0) * N + j] = _mm512_reduce_add_epi32(a10);
        acc[(1 * 4 + 1) * N + j] = _mm512_reduce_add_epi32(a11);
        acc[(1 * 4 + 2) * N + j] = _mm512_reduce_add_epi32(a12);
        acc[(1 * 4 + 3) * N + j] = _mm512_reduce_add_epi32(a13);
        acc[(2 * 4 + 0) * N + j] = _mm512_reduce_add_epi32(a20);
        acc[(2 * 4 + 1) * N + j] = _mm512_reduce_add_epi32(a21);
        acc[(2 * 4 + 2) * N + j] = _mm512_reduce_add_epi32(a22);
        acc[(2 * 4 + 3) * N + j] = _mm512_reduce_add_epi32(a23);
    }
}
#else
static inline void refill_rows4(const uint8_t *planes, int b, int b0,
                                const int8_t *W, int64_t K, int64_t N, int32_t *acc) {
    for (int64_t j = 0; j < N; j++) {
        const int8_t *w = W + j * K;
        for (int p = 0; p < 3; p++)
            for (int r = 0; r < 4; r++) {
                const int row = b0 + r < b ? b0 + r : b - 1;
                const uint8_t *x = planes + ((size_t)p * b + row) * K;
                int32_t a = 0;
                for (int64_t k = 0; k < K; k++) a += (int32_t)x[k] * (int32_t)w[k];
                acc[(p * 4 + r) * N + j] = a;
            }
    }
}
#endif

void FN(refill)(const uint8_t *planes, int b, const int8_t *W, int64_t K, int64_t N,
                int32_t *u, int64_t u_stride, int32_t *acc) {
    for (int b0 = 0; b0 < b; b0 += 4) {
        refill_rows4(planes, b, b0, W, K, N, acc);
        const int rows = b - b0 < 4 ? b - b0 : 4;
        for (int r = 0; r < rows; r++) {
            const int32_t *a0 = acc + (0 * 4 + r) * N, *a1 = acc + (1 * 4 + r) * N, *a2 = acc + (2 * 4 + r) * N;
            int32_t *o = u + (int64_t)(b0 + r) * u_stride;
            for (int64_t j = 0; j < N; j++) o[j] = crt_balanced(a0[j], a1[j], a2[j]);
        }
    }
}

/* The outlier term: y[row][j] += x_tee[row][c] * Wc[c][j], in the TEE. */
void FN(outlier_add)(const int64_t *x_tee, const int8_t *wc, int nout, int64_t N, int64_t *y) {
    for (int c = 0; c < nout; c++) {
        const int64_t xv = x_tee[c];
        if (!xv) continue;
        const int8_t *w = wc + (size_t)c * N;
        for (int64_t j = 0; j < N; j++) y[j] += xv * w[j];
    }
}
