#include "shielded-field.h"
#include <math.h>
#include <string.h>

const int sh_primes[3] = { SH_Q0, SH_Q1, SH_Q2 };

/* Garner constants. Computed once here rather than hardcoded so a change of
 * primes cannot leave a stale magic number behind. */
static int32_t inv_mod(int32_t a, int32_t m) {
    /* m is prime and small; Fermat by square-and-multiply keeps this branch-free
     * of an extended-Euclid sign bug. */
    int64_t r = 1, b = ((a % m) + m) % m; int32_t e = m - 2;
    while (e) { if (e & 1) r = (r * b) % m; b = (b * b) % m; e >>= 1; }
    return (int32_t)r;
}

float sh_half_to_float(uint16_t h) {
    const int s = (h & 0x8000) ? -1 : 1;
    const int e = (h >> 10) & 0x1f;
    const int f = h & 0x3ff;
    if (e == 0)  return (float)s * ldexpf((float)f, -24);        /* zero + subnormal */
    if (e == 31) return f ? NAN : (float)s * INFINITY;
    return (float)s * ldexpf((float)(1024 + f), e - 25);
}

int64_t sh_encode_weight_fixed(uint16_t wd_half, int8_t wq) {
    /* Every intermediate is float, deliberately. Widening any of them to double
     * changes the rounding of the final floor on values that land exactly on a
     * half, and the two halves of the protocol would then disagree. */
    const float d256 = sh_half_to_float(wd_half) * 256.0f;
    const float prod = d256 * (float)wq;
    return (int64_t)floorf(prod + 0.5f);
}

int64_t sh_balanced(int64_t a) {
    int64_t r = a % SH_M_MOD;
    if (r < 0) r += SH_M_MOD;                 /* C truncates toward zero; Python floors */
    return r > SH_HALF_M ? r - SH_M_MOD : r;
}

int8_t sh_residue(int64_t a, int q) {
    int64_t r = a % q;
    if (r < 0) r += q;
    return (int8_t)(r > q / 2 ? r - q : r);
}

int64_t sh_crt(int32_t r0, int32_t r1, int32_t r2) {
    static int32_t inv_q0_mod_q1 = 0, inv_q0q1_mod_q2 = 0;
    if (!inv_q0_mod_q1) {
        inv_q0_mod_q1   = inv_mod(SH_Q0 % SH_Q1, SH_Q1);
        inv_q0q1_mod_q2 = inv_mod((int32_t)(((int64_t)SH_Q0 * SH_Q1) % SH_Q2), SH_Q2);
    }
    int64_t x = ((int64_t)r0 % SH_Q0 + SH_Q0) % SH_Q0;
    int64_t t1 = (((int64_t)r1 % SH_Q1 + SH_Q1) % SH_Q1) - x;
    t1 = ((t1 % SH_Q1 + SH_Q1) % SH_Q1) * inv_q0_mod_q1 % SH_Q1;
    x += (int64_t)SH_Q0 * t1;
    int64_t t2 = (((int64_t)r2 % SH_Q2 + SH_Q2) % SH_Q2) - x;
    t2 = ((t2 % SH_Q2 + SH_Q2) % SH_Q2) * inv_q0q1_mod_q2 % SH_Q2;
    x += (int64_t)SH_Q0 * SH_Q1 * t2;
    return x > SH_HALF_M ? x - SH_M_MOD : x;
}

bool sh_weights_fit_byte(const int64_t *w_fixed, int64_t n) {
    for (int64_t i = 0; i < n; i++) {
        int64_t a = w_fixed[i] < 0 ? -w_fixed[i] : w_fixed[i];
        if (a > SH_WEIGHT_BYTE_LIMIT) return false;
    }
    return true;
}

uint16_t sh_float_to_half(float v) {
    /* Round-to-nearest-EVEN, because numpy's astype(float16) does and the scales
     * this produces are half of THE shared encoding. Truncating instead -- the
     * obvious shift-and-mask -- silently lands one ulp low on roughly half of all
     * blocks, which does not fail anywhere: it just makes the TEE and the GPU
     * derive different weights, and the unmasking subtraction returns noise. */
    uint32_t x; memcpy(&x, &v, 4);
    const uint32_t sign = (x >> 16) & 0x8000u;
    const uint32_t biased = (x >> 23) & 0xffu;
    const uint32_t man = x & 0x7fffffu;

    if (biased == 0xff) return (uint16_t)(sign | (man ? 0x7e00u : 0x7c00u));

    const int32_t exp = (int32_t)biased - 127;
    if (exp > 15) return (uint16_t)(sign | 0x7c00u);        /* overflow to inf */

    if (exp >= -14) {                                        /* normal half */
        const uint32_t lsb   = (man >> 13) & 1u;
        const uint32_t rem   = man & 0x1fffu;
        const uint32_t inc   = (rem > 0x1000u) || (rem == 0x1000u && lsb);
        uint32_t h = ((uint32_t)(exp + 15) << 10) | (man >> 13);
        h += inc;                    /* a carry out of the mantissa bumps the exponent, correctly */
        return (uint16_t)(sign | h);
    }
    if (exp < -25) return (uint16_t)sign;                    /* underflow to zero */

    /* Subnormal half. Real GGUF scales reach here and must not be refused. */
    const uint32_t m = man | 0x800000u;
    const uint32_t total_shift = 13u + (uint32_t)(-14 - exp);
    if (total_shift > 31) return (uint16_t)sign;
    const uint32_t q    = m >> total_shift;
    const uint32_t rem  = m & ((1u << total_shift) - 1u);
    const uint32_t half = 1u << (total_shift - 1);
    return (uint16_t)(sign | (q + ((rem > half) || (rem == half && (q & 1u)))));
}

int sh_prepare_weight(const uint16_t *wd_raw, const int8_t *wq,
                      int64_t K, int64_t N, uint16_t *wd_scaled_out, int *f_w_out) {
    if (K % SH_QK != 0) return -1;
    const int64_t nb = K / SH_QK;

    /* Per-column peak: the largest |w| this output column actually contains. A
     * per-TENSOR peak would let one outlier column set the exponent for all of
     * them, which is the 13.5%-of-weights-to-zero effect this exists to avoid. */
    for (int64_t j = 0; j < N; j++) {
        double peak = 0.0;
        for (int64_t b = 0; b < nb; b++) {
            const double d = fabs((double)sh_half_to_float(wd_raw[b * N + j]));
            if (d == 0.0) continue;
            for (int64_t t = 0; t < SH_QK; t++) {
                const double a = d * fabs((double)wq[(b * SH_QK + t) * N + j]);
                if (a > peak) peak = a;
            }
        }
        int f_w = SH_FRAC;
        if (peak > 0.0) f_w = (int)floor(log2((double)SH_WEIGHT_BYTE_LIMIT / peak));

        /* By construction, then VERIFIED against the real encoder: rounding can
         * push the encoded peak over a limit the estimate said would fit. */
        int chosen = -1;
        for (int cand = f_w; cand > f_w - 8 && chosen < 0; cand--) {
            const float mul = ldexpf(1.0f, cand - SH_FRAC);
            bool fits = true;
            for (int64_t b = 0; b < nb && fits; b++) {
                const float sc = sh_half_to_float(wd_raw[b * N + j]) * mul;
                if (!isfinite(sc)) { fits = false; break; }
                wd_scaled_out[b * N + j] = sh_float_to_half(sc);
            }
            if (!fits) continue;
            for (int64_t k = 0; k < K && fits; k++) {
                const int64_t v = sh_encode_weight_fixed(wd_scaled_out[(k / SH_QK) * N + j],
                                                         wq[k * N + j]);
                if (v > SH_WEIGHT_BYTE_LIMIT || v < -SH_WEIGHT_BYTE_LIMIT) fits = false;
            }
            if (fits) chosen = cand;
        }
        if (chosen < 0) return -1;
        f_w_out[j] = chosen;
    }
    return 0;
}

int sh_prepare_weight_rows(const void *blocks, int64_t K, int64_t N,
                           int8_t *w_fixed_out, int *f_w_out) {
    if (K % SH_QK != 0) return -1;
    const int64_t nb = K / SH_QK;
    const uint8_t *base = (const uint8_t *)blocks;
    uint16_t sc[4096];
    if (nb > 4096) return -1;                    /* K up to 131072 */
    for (int64_t j = 0; j < N; j++) {
        const uint8_t *row = base + (size_t)j * nb * 34;
        double peak = 0.0;
        for (int64_t b = 0; b < nb; b++) {
            uint16_t dh; memcpy(&dh, row + b * 34, 2);
            const double d = fabs((double)sh_half_to_float(dh));
            if (d == 0.0) continue;
            const int8_t *q = (const int8_t *)(row + b * 34 + 2);
            int amax = 0;
            for (int t = 0; t < SH_QK; t++) { const int a = q[t] < 0 ? -q[t] : q[t]; if (a > amax) amax = a; }
            const double a = d * amax;
            if (a > peak) peak = a;
        }
        int f_w = SH_FRAC;
        if (peak > 0.0) f_w = (int)floor(log2((double)SH_WEIGHT_BYTE_LIMIT / peak));
        int chosen = -1;
        for (int cand = f_w; cand > f_w - 8 && chosen < 0; cand--) {
            const float mul = ldexpf(1.0f, cand - SH_FRAC);
            bool fits = true;
            for (int64_t b = 0; b < nb && fits; b++) {
                uint16_t dh; memcpy(&dh, row + b * 34, 2);
                const float v = sh_half_to_float(dh) * mul;
                if (!isfinite(v)) { fits = false; break; }
                sc[b] = sh_float_to_half(v);
            }
            if (!fits) continue;
            int8_t *out = w_fixed_out + (size_t)j * K;
            for (int64_t b = 0; b < nb && fits; b++) {
                const int8_t *q = (const int8_t *)(row + b * 34 + 2);
                for (int t = 0; t < SH_QK; t++) {
                    const int64_t v = sh_encode_weight_fixed(sc[b], q[t]);
                    if (v > SH_WEIGHT_BYTE_LIMIT || v < -SH_WEIGHT_BYTE_LIMIT) { fits = false; break; }
                    out[b * SH_QK + t] = (int8_t)v;
                }
            }
            if (fits) chosen = cand;
        }
        if (chosen < 0) return -1;
        f_w_out[j] = chosen;
    }
    return 0;
}
