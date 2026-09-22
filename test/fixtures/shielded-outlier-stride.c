/* The TEE-side outlier term over a COLUMN SLICE.
 *
 * A column-split card adds only its own columns of y, while the channel rows
 * of the outlier table it reads are still `stride` apart in the primary card's
 * full-width table. That is the only difference from the whole-tensor call,
 * and it must not change a single output bit: the split path and the
 * whole-tensor path have to agree with each other AND with a plain integer
 * reference, including on the fallback the kernel takes when the activation is
 * too large or there are too many channels for the exact double form.
 *
 * This is what guards the scalar->SIMD change in sh_split_post_slice: the
 * split used to hand-roll `y[j] += xv * w[j]`, which is correct but is the
 * form outlier_add exists to avoid. */
#include "../../wasm/ggml-shielded/shielded-simd.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { NOUT_MAX = 80, N = 1031 };

/* The vtable lives in shielded-tee.c, which would drag the whole link in.
 * These are the same functions it would install, called by name. */
typedef struct {
    const char *name;
    void (*add)(const int64_t *, const int8_t *, int, int64_t, int64_t *);
    void (*add_stride)(const int64_t *, const int8_t *, int, int64_t, int64_t, int64_t *);
} table;

static void check(const table *s, int nout, int64_t xmag);


static uint64_t rng = 0x9e3779b97f4a7c15ull;
static uint64_t nextr(void) { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return rng; }

/* The definition, in plain integers. */
static void reference(const int64_t *x, const int8_t *wc, int nout,
                      int64_t c0, int64_t nc, int64_t stride, int64_t *y) {
    for (int c = 0; c < nout; c++) {
        const int64_t xv = x[c];
        const int8_t *w = wc + (size_t)c * stride + c0;
        for (int64_t j = 0; j < nc; j++) y[c0 + j] += xv * w[j];
    }
}

static void check(const table *s, int nout, int64_t xmag) {
    int8_t *wc = malloc((size_t)NOUT_MAX * N); assert(wc);
    for (size_t i = 0; i < (size_t)NOUT_MAX * N; i++) wc[i] = (int8_t)((int)(nextr() % 239) - 119);
    int64_t x[NOUT_MAX];
    for (int c = 0; c < nout; c++) {
        const int64_t v = (int64_t)(nextr() % (uint64_t)(2 * xmag + 1)) - xmag;
        x[c] = v;
    }
    /* Whole tensor: the strided form with stride == n_cols must equal the
     * plain entry point, which is how the two cannot drift apart. */
    int64_t *a = calloc(N, sizeof *a), *b = calloc(N, sizeof *b), *r = calloc(N, sizeof *r);
    assert(a && b && r);
    for (int64_t i = 0; i < N; i++) a[i] = b[i] = r[i] = (int64_t)(nextr() % 4001) - 2000;
    s->add(x, wc, nout, N, a);
    s->add_stride(x, wc, nout, N, N, b);
    reference(x, wc, nout, 0, N, N, r);
    for (int64_t i = 0; i < N; i++) { assert(a[i] == r[i]); assert(b[i] == r[i]); }

    /* Slices, including 32-column aligned boundaries like the planner's, the
     * degenerate ends, and a slice that is the whole row. */
    const int64_t edges[] = { 0, 1, 31, 32, 64, 512, N - 1, N };
    for (size_t e = 0; e + 1 < sizeof edges / sizeof edges[0]; e++) {
        for (size_t f = e + 1; f < sizeof edges / sizeof edges[0]; f++) {
            const int64_t c0 = edges[e], nc = edges[f] - edges[e];
            if (nc <= 0) continue;
            int64_t *ys = calloc(N, sizeof *ys), *yr = calloc(N, sizeof *yr);
            assert(ys && yr);
            for (int64_t i = 0; i < N; i++) ys[i] = yr[i] = (int64_t)(nextr() % 4001) - 2000;
            s->add_stride(x, wc + c0, nout, nc, N, ys + c0);
            reference(x, wc, nout, c0, nc, N, yr);
            for (int64_t i = 0; i < N; i++) {
                if (ys[i] != yr[i]) {
                    fprintf(stderr, "%s nout=%d xmag=%lld slice %lld+%lld: col %lld got %lld want %lld\n",
                            s->name, nout, (long long)xmag, (long long)c0, (long long)nc,
                            (long long)i, (long long)ys[i], (long long)yr[i]);
                    assert(!"outlier_add_stride disagrees with the integer reference");
                }
            }
            free(ys); free(yr);
        }
    }
    free(a); free(b); free(r); free(wc);
}

int main(void) {
    const table tables[] = {
        { "generic", sh_simd_generic_outlier_add, sh_simd_generic_outlier_add_stride },
#if !defined(__aarch64__)
        { "avx512",  sh_simd_avx512_outlier_add,  sh_simd_avx512_outlier_add_stride  },
#else
        { "neon",    sh_simd_neon_outlier_add,    sh_simd_neon_outlier_add_stride    },
#endif
    };
    for (size_t t = 0; t < sizeof tables / sizeof tables[0]; t++) {
        /* nout 0 and 1 are the edges; 64 and 65 straddle the kernel's exact
         * limit; xmag at and above 2^40 takes the plain int64 fallback, which
         * has its own stride arithmetic and so needs the same coverage. */
        const int nouts[] = { 0, 1, 2, 8, 16, 63, 64, 65, 80 };
        const int64_t mags[] = { 1, 1000, (INT64_C(1) << 39), (INT64_C(1) << 40), (INT64_C(1) << 41) };
        for (size_t i = 0; i < sizeof nouts / sizeof nouts[0]; i++)
            for (size_t m = 0; m < sizeof mags / sizeof mags[0]; m++)
                check(&tables[t], nouts[i], mags[m]);
        fprintf(stderr, "outlier stride: %s ok\n", tables[t].name);
    }
    return 0;
}
