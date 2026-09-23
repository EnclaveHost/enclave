/* tpu_corr.h -- the masked lane's out-of-lane correction, as pure functions the host can test (tpu/test/corr-order-test.cpp).
 *
 * For each request row r with out-of-lane entries (i, d) -- a value beyond its lane, or a modular wrap -- and each output j:
 *     y[r][j] = s_in * sw[j] * sum_k d[r][k] * W[j][i[r][k]]
 * The sum is exact in int64 and converted once, so the result does not depend on the order of the entries (the count of
 * wraps is pad-dependent, and float accumulation once flipped a token at a near-tie).
 *
 * ROW-MAJOR (tpu_corr_rows): each output row of W is read once and every request row's entries are picked out of it --
 * ascending indices inside one contiguous weight row -- so the matrix is swept once per exchange however many rows the
 * exchange carries. COLUMN-MAJOR (tpu_corr_col, the form it replaced): one strided column walk per entry, a cache miss
 * per output per entry, repeated per row; it cost 4.97 ms of an 11.2 ms exchange at ~4 rows (results/corrjoin). Both
 * produce the same bits; the test proves it. */
#ifndef TPU_CORR_H
#define TPU_CORR_H
#include <algorithm>
#include <cstdint>
#include <cstddef>
#include <utility>
#include <vector>

typedef std::vector<std::vector<std::pair<uint32_t, int32_t>>> tpu_outliers;   /* per request row: (input index, delta) */

/* outputs [j0, j1) for every request row; y is rows x n_out */
static inline void tpu_corr_rows(const int8_t *Wq, size_t n_in, uint32_t n_out, const float *sw, float s_in, const tpu_outliers &outl,
                                 uint32_t rows, float *y, uint32_t j0, uint32_t j1) {
    for (uint32_t j = j0; j < j1; j++) {
        const int8_t *w = Wq + (size_t)j * n_in;
        if (j + 2 < j1) __builtin_prefetch(w + 2 * n_in, 0, 0);
        for (uint32_t r = 0; r < rows; r++) {
            int64_t a = 0;
            for (const auto &o : outl[r]) a += (int64_t)o.second * (int64_t)w[o.first];
            /* the SAME association as the column form, (a * s_in) * sw -- floating multiply is not associative, and
             * pre-multiplying s_in * sw once per row would differ from it in rare last bits */
            y[(size_t)r * n_out + j] = (float)((double)a * (double)s_in * (double)sw[j]);
        }
    }
}
/* the column-major reference: one request row, all outputs */
static inline void tpu_corr_col(const int8_t *Wq, size_t n_in, uint32_t n_out, const float *sw, float s_in, const tpu_outliers &outl,
                                uint32_t r, float *y) {
    std::vector<int64_t> acc(n_out, 0);
    for (const auto &o : outl[r]) {
        const int64_t d = (int64_t)o.second; const int8_t *w = Wq + o.first;
        for (uint32_t j = 0; j < n_out; j++) { if (j + 24 < n_out) __builtin_prefetch(w + (size_t)(j + 24) * n_in, 0, 0); acc[j] += d * (int64_t)w[(size_t)j * n_in]; }
    }
    for (uint32_t j = 0; j < n_out; j++) y[(size_t)r * n_out + j] = (float)((double)acc[j] * (double)s_in * (double)sw[j]);
}
#endif
