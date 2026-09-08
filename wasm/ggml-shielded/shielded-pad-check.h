#ifndef SHIELDED_PAD_CHECK_H
#define SHIELDED_PAD_CHECK_H

#include "shielded-field.h"
#include <stdint.h>

/* Compute W^T s modulo M, with the same result as the column-strided
 * __int128 reference. Each tile reads consecutive weight bytes and keeps its
 * accumulators in a small stack buffer. The caller validates K*N and buffers.
 *
 * Even for the full int8/int32 domains, 32768 rows contribute at most
 * 32768 * 128 * 2^31 = 2^53 in magnitude. Reducing between row chunks keeps
 * every int64 accumulator bounded independently of the total row count.
 * No secret-dependent branches, indices, or early exits. */
static inline void sh_pad_check_tiled(const int8_t *weights, int64_t K, int64_t N,
                                     const int32_t *s, int32_t *st) {
    enum { COLS = 128, ROWS = 32768 };
    for (int64_t k0 = 0; k0 < K;) {
        const int cols = K - k0 < COLS ? (int)(K - k0) : COLS;
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
#endif
