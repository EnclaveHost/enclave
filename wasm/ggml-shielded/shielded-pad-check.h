#ifndef SHIELDED_PAD_CHECK_H
#define SHIELDED_PAD_CHECK_H

#include "shielded-field.h"
#include <stdint.h>
#if defined(__cplusplus)
static_assert(SH_M_MOD > 0 && SH_M_MOD < (INT64_C(1) << 24), "online pad dot requires a field below 2^24");
#else
_Static_assert(SH_M_MOD > 0 && SH_M_MOD < (INT64_C(1) << 24), "online pad dot requires a field below 2^24");
#endif

/* Online pad dot product modulo M. Both operands must be in [-(M-1), M-1]:
 * r and W^T s are reduced field values, u is balanced, and s is below 2^20.
 * A chunk contributes at most 32768*(M-1)^2 < 2^63 in magnitude. Reducing
 * between chunks permits arbitrary supported K/N without signed overflow.
 * Unlike the preparation helper below, this is NOT a full-int32-domain API.
 * Fixed public chunk sizes and sequential reads do not depend on secrets.
 */
static inline int32_t sh_pad_check_dot_field(const int32_t *a, const int32_t *b, int64_t n) {
    enum { VALUES = 32768 };
    int64_t result = 0;
    for (int64_t at = 0; at < n;) {
        const int count = n - at < VALUES ? (int)(n - at) : VALUES;
        int64_t acc = 0;
        for (int i = 0; i < count; i++) acc += (int64_t)a[at + i] * b[at + i];
        result = (result + acc % SH_M_MOD) % SH_M_MOD;
        at += count;
    }
    return (int32_t)((result + SH_M_MOD) % SH_M_MOD);
}

/* Column-strided __int128 reference over st[k_begin, k_end). Same expression
 * and same modulus as pad_check_prepare's serial loop, which is left in place
 * unchanged; this form exists so a threaded dispatch can cover a sub-range.
 * Reads W with the original row stride K. */
static inline void sh_pad_check_ref_range(const int8_t *weights, int64_t K, int64_t N,
                                          int64_t k_begin, int64_t k_end,
                                          const int32_t *s, int32_t *st) {
    for (int64_t k = k_begin; k < k_end; k++) {
        __int128 acc = 0;
        for (int64_t j = 0; j < N; j++) acc += (__int128)weights[j * K + k] * s[j];
        int64_t v = (int64_t)(acc % SH_M_MOD); if (v < 0) v += SH_M_MOD;
        st[k] = (int32_t)v;
    }
}

/* Compute W^T s modulo M, with the same result as the column-strided
 * __int128 reference. Each tile reads consecutive weight bytes and keeps its
 * accumulators in a small stack buffer. The caller validates K*N and buffers.
 *
 * Even for the full int8/int32 domains, 32768 rows contribute at most
 * 32768 * 128 * 2^31 = 2^53 in magnitude. Reducing between row chunks keeps
 * every int64 accumulator bounded independently of the total row count.
 * No secret-dependent branches, indices, or early exits. */
/* The tiled kernel now takes an explicit [k_begin, k_end) column range. The
 * arithmetic, the tile sizes, the row chunking and the reduction order are
 * unchanged; only the loop bounds are parameterised. The row chunking (j0,
 * ROWS) does not depend on k_begin, so a column's reduction sequence - and
 * therefore st[k] - is the same under any column partition. Callers still
 * align split points to COLS so each worker's tiling is the serial tiling. */
static inline void sh_pad_check_tiled_range(const int8_t *weights, int64_t K, int64_t N,
                                            int64_t k_begin, int64_t k_end,
                                            const int32_t *s, int32_t *st) {
    enum { COLS = 128, ROWS = 32768 };
    for (int64_t k0 = k_begin; k0 < k_end;) {
        const int cols = k_end - k0 < COLS ? (int)(k_end - k0) : COLS;
        for (int c = 0; c < cols; c++) st[k0 + c] = 0;
        for (int64_t j0 = 0; j0 < N;) {
            const int rows = N - j0 < ROWS ? (int)(N - j0) : ROWS;
            int64_t acc[COLS] = {0};
            for (int j = 0; j < rows; j++) {
                const int8_t *row = weights + (j0 + j) * K + k0;
                const int64_t sj = s[j0 + j];
                for (int c = 0; c < cols; c++) acc[c] += (int64_t)row[c] * sj;
            }
            for (int c = 0; c < cols; c++) {
                const int64_t v = acc[c] % SH_M_MOD + st[k0 + c] + SH_M_MOD;
                st[k0 + c] = (int32_t)(v % SH_M_MOD);
            }
            j0 += rows;
        }
        k0 += cols;
    }
}

/* Original entry point: unchanged signature and behaviour, full column range. */
static inline void sh_pad_check_tiled(const int8_t *weights, int64_t K, int64_t N,
                                     const int32_t *s, int32_t *st) {
    sh_pad_check_tiled_range(weights, K, N, 0, K, s, st);
}
#endif
