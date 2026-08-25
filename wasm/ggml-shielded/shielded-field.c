#include "shielded-field.h"
#include <math.h>

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
