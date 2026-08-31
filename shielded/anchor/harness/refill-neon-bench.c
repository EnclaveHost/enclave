/*
 * refill-neon-bench -- can the phone afford u = r.W?
 *
 * Refill is the anchor's one unoffloadable term (a GPU computing r.W learns
 * the pad) and it costs three residue planes per offloaded MAC. On the CVM it
 * is an AVX-512 VNNI loop built on `vpdpbusd`, whose whole point is a MIXED
 * u8 x s8 dot product: the pad residues are unsigned [0,250], the encoded
 * weights signed [-119,119].
 *
 * AArch64 has no mixed-sign dot product. Measured on the target device
 * (SM-G996U1, Snapdragon 888): `asimddp` IS present, `i8mm` is NOT -- so the
 * instruction available is SDOT/UDOT (ARMv8.2 dotprod), not the ARMv8.6 i8mm
 * the handoff assumed. SDOT is signed x signed. The identity that recovers the
 * mixed product exactly:
 *
 *     x in [0,250] unsigned, w in [-119,119] signed
 *     let xs = x - 128  (fits int8: [-128,122])
 *     sum_k x[k]*w[k] = sum_k xs[k]*w[k] + 128 * sum_k w[k]
 *
 * and `sum_k w[k]` is a per-output-row CONSTANT of the public weights, so it
 * is precomputed once at registration and costs nothing per pad. No rounding,
 * no approximation: this is integer algebra, and the bench asserts bit-equality
 * against the scalar kernel before reporting a single timing.
 *
 * Reports G-MAC/s for both, so the number is comparable with REPORT.md's
 * per-core CVM figures.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if defined(__aarch64__) && defined(__ARM_FEATURE_DOTPROD)
#include <arm_neon.h>
#define AN_HAVE_SDOT 1
#endif

static double now_us(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e6 + ts.tv_nsec / 1e3;
}

/* the shipped generic kernel's inner shape: 3 planes x 4 pad rows per weight row */
static void refill_scalar(const uint8_t *planes, int b, const int8_t *W,
                          int64_t K, int64_t N, int32_t *acc) {
    for (int64_t j = 0; j < N; j++) {
        const int8_t *w = W + j * K;
        for (int p = 0; p < 3; p++)
            for (int r = 0; r < 4; r++) {
                const int row = r < b ? r : b - 1;
                const uint8_t *x = planes + ((size_t)p * b + row) * K;
                int32_t a = 0;
                for (int64_t k = 0; k < K; k++) a += (int32_t)x[k] * (int32_t)w[k];
                acc[(p * 4 + r) * N + j] = a;
            }
    }
}

#if defined(__aarch64__) && defined(__ARM_FEATURE_DOTPROD)
/* wsum[j] = sum_k W[j][k], precomputed once per weight (public, registration time) */
static void row_sums(const int8_t *W, int64_t K, int64_t N, int32_t *wsum) {
    for (int64_t j = 0; j < N; j++) {
        const int8_t *w = W + j * K;
        int32_t s = 0;
        for (int64_t k = 0; k < K; k++) s += w[k];
        wsum[j] = s;
    }
}

static void refill_sdot(const uint8_t *planes, int b, const int8_t *W,
                        int64_t K, int64_t N, const int32_t *wsum, int32_t *acc) {
    const int64_t K16 = K & ~(int64_t)15;
    const uint8x16_t bias = vdupq_n_u8(128);
    for (int64_t j = 0; j < N; j++) {
        const int8_t *w = W + j * K;
        const int32_t corr = 128 * wsum[j];
        for (int p = 0; p < 3; p++) {
            for (int r = 0; r < 4; r++) {
                const int row = r < b ? r : b - 1;
                const uint8_t *x = planes + ((size_t)p * b + row) * K;
                int32x4_t a = vdupq_n_s32(0);
                int64_t k = 0;
                for (; k < K16; k += 16) {
                    /* xs = x - 128, reinterpreted as signed: exact, no saturation */
                    const int8x16_t xs = vreinterpretq_s8_u8(vsubq_u8(vld1q_u8(x + k), bias));
                    a = vdotq_s32(a, xs, vld1q_s8(w + k));
                }
                int32_t t = vaddvq_s32(a);
                for (; k < K; k++) t += ((int32_t)x[k] - 128) * (int32_t)w[k];
                acc[(p * 4 + r) * N + j] = t + corr;
            }
        }
    }
}
#endif

int main(int argc, char **argv) {
    int64_t K = 896, N = 4864;
    int iters = 20, b = 4;
    for (int i = 1; i < argc - 1; i++) {
        if (!strcmp(argv[i], "--k")) K = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--n")) N = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--iters")) iters = atoi(argv[++i]);
    }
    if (K % 16) { fprintf(stderr, "K must be a multiple of 16\n"); return 2; }

    uint8_t *planes = malloc((size_t)3 * b * K);
    int8_t  *W      = malloc((size_t)N * K);
    int32_t *acc_a  = malloc((size_t)12 * N * sizeof(int32_t));
    int32_t *acc_b  = malloc((size_t)12 * N * sizeof(int32_t));
    int32_t *wsum   = malloc((size_t)N * sizeof(int32_t));
    if (!planes || !W || !acc_a || !acc_b || !wsum) { fprintf(stderr, "oom\n"); return 2; }

    uint64_t s = 0x243f6a8885a308d3ull;
#define RND() (s ^= s << 13, s ^= s >> 7, s ^= s << 17, s)
    for (int64_t i = 0; i < 3 * b * K; i++) planes[i] = (uint8_t)(RND() % 251);   /* residues < max prime */
    for (int64_t i = 0; i < N * K; i++)     W[i] = (int8_t)((int)(RND() % 239) - 119);
#undef RND

    const double macs = 3.0 * 4.0 * (double)K * (double)N;   /* 3 planes x 4 rows */

    double t0 = now_us();
    for (int i = 0; i < iters; i++) refill_scalar(planes, b, W, K, N, acc_a);
    const double us_scalar = (now_us() - t0) / iters;

#if defined(__aarch64__) && defined(__ARM_FEATURE_DOTPROD)
    row_sums(W, K, N, wsum);
    /* correctness BEFORE timing: one mismatched element means the pad and the
     * worker's product disagree, and unmasking returns noise with no signal. */
    refill_sdot(planes, b, W, K, N, wsum, acc_b);
    int mismatch = memcmp(acc_a, acc_b, (size_t)12 * N * sizeof(int32_t)) != 0;
    int64_t first = -1;
    if (mismatch) for (int64_t i = 0; i < 12 * N; i++) if (acc_a[i] != acc_b[i]) { first = i; break; }

    t0 = now_us();
    for (int i = 0; i < iters; i++) refill_sdot(planes, b, W, K, N, wsum, acc_b);
    const double us_sdot = (now_us() - t0) / iters;

    printf("{\"arch\":\"aarch64\",\"K\":%lld,\"N\":%lld,\"b\":%d,\"iters\":%d,"
           "\"exact_match\":%s,\"first_mismatch\":%lld,"
           "\"scalar\":{\"us\":%.1f,\"gmac_s\":%.2f},"
           "\"sdot\":{\"us\":%.1f,\"gmac_s\":%.2f},\"speedup\":%.2f}\n",
           (long long)K, (long long)N, b, iters,
           mismatch ? "false" : "true", (long long)first,
           us_scalar, macs / us_scalar / 1e3,
           us_sdot, macs / us_sdot / 1e3,
           us_scalar / us_sdot);
    free(planes); free(W); free(acc_a); free(acc_b); free(wsum);
    return mismatch ? 1 : 0;
#else
    (void)wsum; (void)acc_b;
    printf("{\"arch\":\"other\",\"K\":%lld,\"N\":%lld,\"b\":%d,\"iters\":%d,"
           "\"scalar\":{\"us\":%.1f,\"gmac_s\":%.2f}}\n",
           (long long)K, (long long)N, b, iters, us_scalar, macs / us_scalar / 1e3);
    free(planes); free(W); free(acc_a); free(acc_b); free(wsum);
    return 0;
#endif
}
