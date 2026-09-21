/*
 * bench_pads.c -- what LPN-structured pads cost on a real CPU, measured.
 *
 * Mirrors lpnpad.py's formulas with AVX-512 kernels over Z_2^32 (or Z_2^16),
 * with the weights held INPUT-MAJOR: W_in[j][i] = W[i][j], n rows of m int8.
 * That layout makes "column j of W" one contiguous m-byte row, which is what
 * both the uniform pass and the LPN gather want:
 *
 *   plain    u[b][:] += r[b][j] * W_in[j][:]          for all j       (n rows)
 *   wa       u[b][:] += s[b][l] * WA[l][:]            for all l       (k rows, ring width)
 *   gather   u[b][:] += e[b][j] * W_in[j][:]          for j in supp   (t rows per pad, union over the batch)
 *   a_s      r[b][j]  = sum_l A[j][l] * s[b][l]                        (n.k multiplies; dense / dense8 / toeplitz)
 *   lpn      a_s + scatter e + wa + gather, timed as one region
 *
 * Threads split the OUTPUT columns, so every thread streams its own slice of
 * each row and no reduction is needed. Rows are processed four at a time so a
 * loaded weight vector is reused across the batch and across rows.
 *
 * --layers L allocates L independent copies of (W, WA, A) and cycles through
 * them, so a cold measurement can be taken where W.A does not sit in L3
 * between two pads of the same layer -- the honest per-token case, since a
 * token visits every layer once. L=1 is the hot case the handoff's section 4.3
 * hypothesises.
 *
 * The LPN path is checked against the plain path bit for bit before anything
 * is timed: u_lpn(s, e) must equal plain(W, A.s + e).
 *
 *   gcc -O3 -march=native -fopenmp bench_pads.c -o bench_pads
 *   ./bench_pads --n 16384 --m 16384 --k 597 --t 2470 --batch 1 --threads 8 --layers 4
 */
#define _GNU_SOURCE
#include <immintrin.h>
#include <omp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef uint32_t u32; typedef uint16_t u16; typedef int8_t i8; typedef uint8_t u8;

static double now(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec + ts.tv_nsec * 1e-9; }
static int cmp_d(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : x > y; }
static double median(double *v, int n) { qsort(v, n, sizeof *v, cmp_d); return v[n / 2]; }

/* xorshift: data only; nothing here is a pad anyone uses */
static uint64_t rs = 0x9E3779B97F4A7C15ull;
static uint64_t rnd(void) { rs ^= rs << 13; rs ^= rs >> 7; rs ^= rs << 17; return rs; }

static void *xalloc(size_t bytes) { void *p = NULL; if (posix_memalign(&p, 64, bytes ? bytes : 64)) { fprintf(stderr, "oom %zu\n", bytes); exit(1); } return p; }

/* ---------------------------------------------------------------- config */
static int64_t N = 16384, M = 16384, K = 597, T = 2470;
static int B = 1, THREADS = 8, LAYERS = 1, REPS = 7, RING = 32, REGULAR = 1, JSON = 0, VERIFY = 1;
static const char *AMODE = "toeplitz";

typedef struct {
    i8  *W;      /* n x m, input-major */
    void *WA;    /* k x m, u32 or u16 */
    void *A;     /* dense: n x k u32/u16; dense8: n x k u8; toeplitz: (n+k-1) u32/u16 */
} layer_t;

/* ---------------------------------------------------- column partitioning */
static void col_range(int tid, int nth, int64_t m, int64_t align, int64_t *c0, int64_t *c1) {
    int64_t blocks = (m + align - 1) / align;
    int64_t per = (blocks + nth - 1) / nth;
    int64_t b0 = (int64_t)tid * per, b1 = b0 + per; if (b1 > blocks) b1 = blocks; if (b0 > blocks) b0 = blocks;
    *c0 = b0 * align; *c1 = b1 * align; if (*c1 > m) *c1 = m;
}

/* ------------------------------------------------- the axpy kernels
 * u[b][c0..c1) += coef[b][j] * row_j[c0..c1) for the listed rows.
 *
 * Column TILES: the accumulator tile (B x TW x width) must stay in L1 while
 * the rows stream past, so TW shrinks as B grows (B = 1: the thread's whole
 * range; B = 64: 128 columns). Rows are taken four at a time so a loaded
 * weight vector is reused across the batch and four multiplies share one
 * accumulator round trip. The accumulator's row stride is PADDED (M + 16
 * elements): consecutive pads at a stride of exactly M x 4 bytes alias the
 * same L1 set (16 KiB multiples on a 48 KiB 12-way L1) and a B = 64 batch
 * spent its time on conflict misses -- 52 GMAC/s instead of ~350.
 */
static int64_t tile_width(int64_t range, int width) {
    int64_t tw = (32 * 1024) / ((int64_t)B * width);   /* 32 KiB of accumulator per thread */
    tw &= ~(int64_t)63; if (tw < 64) tw = 64;
    return tw < range ? tw : range;
}

#define LOAD_I8_32(p)  _mm512_cvtepi8_epi32(_mm_loadu_si128((const __m128i *)(p)))
#define LOAD_U32(p)    _mm512_loadu_si512((const void *)(p))
#define LOAD_I8_16(p)  _mm512_cvtepi8_epi16(_mm256_loadu_si256((const __m256i *)(p)))
#define LOAD_U16(p)    _mm512_loadu_si512((const void *)(p))

#define DEFINE_AXPY(NAME, RT, CT, LOADV, LANES, MUL, ADD, SET1, CAST)                                   \
static void NAME(const RT **rows, const CT *coef, int64_t nrows, int64_t coef_stride,                     \
                 int64_t c0, int64_t c1, CT *u, int64_t u_stride) {                                       \
    const int64_t TW = tile_width(c1 - c0, sizeof(CT));                                                   \
    for (int64_t t0 = c0; t0 < c1; t0 += TW) {                                                            \
        const int64_t t1 = t0 + TW < c1 ? t0 + TW : c1;                                                   \
        int64_t j = 0;                                                                                    \
        for (; j + 4 <= nrows; j += 4) {                                                                  \
            const RT *w0 = rows[j], *w1 = rows[j+1], *w2 = rows[j+2], *w3 = rows[j+3];                    \
            for (int64_t c = t0; c < t1; c += LANES) {                                                    \
                __m512i x0 = LOADV(w0 + c), x1 = LOADV(w1 + c), x2 = LOADV(w2 + c), x3 = LOADV(w3 + c);   \
                for (int b = 0; b < B; b++) {                                                             \
                    const CT *cb = coef + (size_t)b * coef_stride + j;                                    \
                    CT *ub = u + (size_t)b * u_stride + c;                                                \
                    __m512i acc = _mm512_loadu_si512((const void *)ub);                                   \
                    acc = ADD(acc, MUL(x0, SET1((CAST)cb[0])));                                           \
                    acc = ADD(acc, MUL(x1, SET1((CAST)cb[1])));                                           \
                    acc = ADD(acc, MUL(x2, SET1((CAST)cb[2])));                                           \
                    acc = ADD(acc, MUL(x3, SET1((CAST)cb[3])));                                           \
                    _mm512_storeu_si512((void *)ub, acc);                                                 \
                }                                                                                         \
            }                                                                                             \
        }                                                                                                 \
        for (; j < nrows; j++) {                                                                          \
            const RT *w0 = rows[j];                                                                       \
            for (int64_t c = t0; c < t1; c += LANES) {                                                    \
                __m512i x0 = LOADV(w0 + c);                                                               \
                for (int b = 0; b < B; b++) {                                                             \
                    CT *ub = u + (size_t)b * u_stride + c;                                                \
                    __m512i acc = _mm512_loadu_si512((const void *)ub);                                   \
                    acc = ADD(acc, MUL(x0, SET1((CAST)coef[(size_t)b * coef_stride + j])));               \
                    _mm512_storeu_si512((void *)ub, acc);                                                 \
                }                                                                                         \
            }                                                                                             \
        }                                                                                                 \
    }                                                                                                     \
}
DEFINE_AXPY(axpy_i8_u32,  i8,  u32, LOAD_I8_32, 16, _mm512_mullo_epi32, _mm512_add_epi32, _mm512_set1_epi32, int)
DEFINE_AXPY(axpy_u32_u32, u32, u32, LOAD_U32,   16, _mm512_mullo_epi32, _mm512_add_epi32, _mm512_set1_epi32, int)
DEFINE_AXPY(axpy_i8_u16,  i8,  u16, LOAD_I8_16, 32, _mm512_mullo_epi16, _mm512_add_epi16, _mm512_set1_epi16, short)
DEFINE_AXPY(axpy_u16_u16, u16, u16, LOAD_U16,   32, _mm512_mullo_epi16, _mm512_add_epi16, _mm512_set1_epi16, short)

/* One pad's rows only (B' = 1 view of the same kernel): the PER-PAD batched
 * gather runs this once per pad on its own t rows, reading B.t rows in all
 * but every read at streaming efficiency. */
#define DEFINE_AXPY1(NAME, RT, CT, LOADV, LANES, MUL, ADD, SET1, CAST)                                  \
static void NAME(const RT **rows, const CT *coef, int64_t nrows, int64_t c0, int64_t c1, CT *u) {        \
    int64_t j = 0;                                                                                        \
    for (; j + 4 <= nrows; j += 4) {                                                                      \
        const RT *w0 = rows[j], *w1 = rows[j+1], *w2 = rows[j+2], *w3 = rows[j+3];                        \
        const __m512i k0 = SET1((CAST)coef[j]), k1 = SET1((CAST)coef[j+1]), k2 = SET1((CAST)coef[j+2]), k3 = SET1((CAST)coef[j+3]); \
        for (int64_t c = c0; c < c1; c += LANES) {                                                        \
            __m512i acc = _mm512_loadu_si512((const void *)(u + c));                                      \
            acc = ADD(acc, MUL(LOADV(w0 + c), k0)); acc = ADD(acc, MUL(LOADV(w1 + c), k1));               \
            acc = ADD(acc, MUL(LOADV(w2 + c), k2)); acc = ADD(acc, MUL(LOADV(w3 + c), k3));               \
            _mm512_storeu_si512((void *)(u + c), acc);                                                    \
        }                                                                                                 \
    }                                                                                                     \
    for (; j < nrows; j++) {                                                                              \
        const RT *w0 = rows[j]; const __m512i k0 = SET1((CAST)coef[j]);                                   \
        for (int64_t c = c0; c < c1; c += LANES) {                                                        \
            __m512i acc = _mm512_loadu_si512((const void *)(u + c));                                      \
            _mm512_storeu_si512((void *)(u + c), ADD(acc, MUL(LOADV(w0 + c), k0)));                       \
        }                                                                                                 \
    }                                                                                                     \
}
DEFINE_AXPY1(axpy1_i8_u32, i8, u32, LOAD_I8_32, 16, _mm512_mullo_epi32, _mm512_add_epi32, _mm512_set1_epi32, int)
DEFINE_AXPY1(axpy1_i8_u16, i8, u16, LOAD_I8_16, 32, _mm512_mullo_epi16, _mm512_add_epi16, _mm512_set1_epi16, short)

/* ------------------------------------------------------------------ A . s */
/* r[b][j] = sum_l A[j][l] s[b][l]; threads split j. 32-bit ring only for
 * dense/dense8 (the 16-bit variant halves it the same way as WA; measured
 * through toeplitz which has both). */
static void a_s_dense_u32(const u32 *A, const u32 *s, u32 *r, int64_t j0, int64_t j1) {
    const int64_t k16 = K & ~(int64_t)15;
    for (int64_t j = j0; j < j1; j++) {
        const u32 *aj = A + (size_t)j * K;
        for (int b = 0; b < B; b++) {
            const u32 *sb = s + (size_t)b * K;
            __m512i acc = _mm512_setzero_si512();
            int64_t l = 0;
            for (; l < k16; l += 16)
                acc = _mm512_add_epi32(acc, _mm512_mullo_epi32(_mm512_loadu_si512((const void *)(aj + l)), _mm512_loadu_si512((const void *)(sb + l))));
            u32 sum = (u32)_mm512_reduce_add_epi32(acc);
            for (; l < K; l++) sum += aj[l] * sb[l];
            r[(size_t)b * N + j] = sum;
        }
    }
}
static void a_s_dense8_u32(const u8 *A, const u32 *s, u32 *r, int64_t j0, int64_t j1) {
    const int64_t k16 = K & ~(int64_t)15;
    for (int64_t j = j0; j < j1; j++) {
        const u8 *aj = A + (size_t)j * K;
        for (int b = 0; b < B; b++) {
            const u32 *sb = s + (size_t)b * K;
            __m512i acc = _mm512_setzero_si512();
            int64_t l = 0;
            for (; l < k16; l += 16)
                acc = _mm512_add_epi32(acc, _mm512_mullo_epi32(_mm512_cvtepu8_epi32(_mm_loadu_si128((const __m128i *)(aj + l))), _mm512_loadu_si512((const void *)(sb + l))));
            u32 sum = (u32)_mm512_reduce_add_epi32(acc);
            for (; l < K; l++) sum += (u32)aj[l] * sb[l];
            r[(size_t)b * N + j] = sum;
        }
    }
}
/* toeplitz: r[b][j] = sum_l a[j + l] s[b][l]; vectorised over j (16 outputs per vector) */
static void a_s_toeplitz_u32(const u32 *a, const u32 *s, u32 *r, int64_t j0, int64_t j1) {
    for (int b = 0; b < B; b++) {
        const u32 *sb = s + (size_t)b * K;
        int64_t j = j0;
        for (; j + 16 <= j1; j += 16) {
            __m512i acc0 = _mm512_setzero_si512(), acc1 = _mm512_setzero_si512();
            int64_t l = 0;
            for (; l + 2 <= K; l += 2) {
                acc0 = _mm512_add_epi32(acc0, _mm512_mullo_epi32(_mm512_loadu_si512((const void *)(a + j + l)), _mm512_set1_epi32((int)sb[l])));
                acc1 = _mm512_add_epi32(acc1, _mm512_mullo_epi32(_mm512_loadu_si512((const void *)(a + j + l + 1)), _mm512_set1_epi32((int)sb[l + 1])));
            }
            for (; l < K; l++)
                acc0 = _mm512_add_epi32(acc0, _mm512_mullo_epi32(_mm512_loadu_si512((const void *)(a + j + l)), _mm512_set1_epi32((int)sb[l])));
            _mm512_storeu_si512((void *)(r + (size_t)b * N + j), _mm512_add_epi32(acc0, acc1));
        }
        for (; j < j1; j++) { u32 sum = 0; for (int64_t l = 0; l < K; l++) sum += a[j + l] * sb[l]; r[(size_t)b * N + j] = sum; }
    }
}
static void a_s_toeplitz_u16(const u16 *a, const u16 *s, u16 *r, int64_t j0, int64_t j1) {
    for (int b = 0; b < B; b++) {
        const u16 *sb = s + (size_t)b * K;
        int64_t j = j0;
        for (; j + 32 <= j1; j += 32) {
            __m512i acc0 = _mm512_setzero_si512(), acc1 = _mm512_setzero_si512();
            int64_t l = 0;
            for (; l + 2 <= K; l += 2) {
                acc0 = _mm512_add_epi16(acc0, _mm512_mullo_epi16(_mm512_loadu_si512((const void *)(a + j + l)), _mm512_set1_epi16((short)sb[l])));
                acc1 = _mm512_add_epi16(acc1, _mm512_mullo_epi16(_mm512_loadu_si512((const void *)(a + j + l + 1)), _mm512_set1_epi16((short)sb[l + 1])));
            }
            for (; l < K; l++)
                acc0 = _mm512_add_epi16(acc0, _mm512_mullo_epi16(_mm512_loadu_si512((const void *)(a + j + l)), _mm512_set1_epi16((short)sb[l])));
            _mm512_storeu_si512((void *)(r + (size_t)b * N + j), _mm512_add_epi16(acc0, acc1));
        }
        for (; j < j1; j++) { u16 sum = 0; for (int64_t l = 0; l < K; l++) sum = (u16)(sum + a[j + l] * sb[l]); r[(size_t)b * N + j] = sum; }
    }
}

/* ------------------------------------------------------------- the passes */
typedef struct {
    /* per batch inputs */
    void *r;        /* [B][n] uniform pads (plain) or A.s + e (lpn) */
    void *s;        /* [B][k] */
    int64_t *pos;   /* [B][t] noise positions */
    void *val;      /* [B][t] noise values (units) */
    /* gather bookkeeping: union of positions across the batch */
    int64_t *rows_used; int64_t n_used;   /* sorted unique rows */
    void *coef;     /* [B][n_used] coefficient of row rows_used[i] in pad b (0 if absent) */
    const i8 **row_ptrs;                  /* pointers to W rows for rows_used */
    int32_t *nz_off;                      /* [n_used + 1] offsets into nz_b / nz_c */
    int32_t *nz_b;                        /* pad index of each nonzero, grouped by row */
    void *nz_c;                           /* its coefficient (u32 / u16) */
    const i8 **all_rows;                  /* pointers to all n rows of W */
    const i8 **pad_rows;                  /* [B][t] row pointers for the per-pad gather */
    void *u;        /* [B][MP] outputs, MP = padded stride */
    void *u2;       /* [B][MP] outputs for the check */
    void *u3;       /* [B][MP] second gather strategy */
} work_t;

static size_t ring_bytes(void) { return RING == 32 ? 4 : 2; }
static int64_t MP;                               /* padded accumulator stride, elements */
static void zero_u(void *u) { memset(u, 0, (size_t)B * MP * ring_bytes()); }

static void fill_noise(work_t *w) {
    /* positions: regular = one per block; random = t distinct */
    for (int b = 0; b < B; b++) {
        int64_t *p = w->pos + (size_t)b * T;
        if (REGULAR) {
            for (int64_t i = 0; i < T; i++) {
                int64_t lo = (N * i) / T, hi = (N * (i + 1)) / T;
                p[i] = lo + (int64_t)(rnd() % (uint64_t)(hi - lo));
            }
        } else {
            u8 *seen = calloc((size_t)N, 1);
            for (int64_t i = 0; i < T; i++) { int64_t x; do { x = (int64_t)(rnd() % (uint64_t)N); } while (seen[x]); seen[x] = 1; p[i] = x; }
            free(seen);
        }
        if (RING == 32) { u32 *v = (u32 *)w->val + (size_t)b * T; for (int64_t i = 0; i < T; i++) v[i] = (u32)rnd() | 1u; }
        else            { u16 *v = (u16 *)w->val + (size_t)b * T; for (int64_t i = 0; i < T; i++) v[i] = (u16)rnd() | 1u; }
    }
    /* union of rows, sorted, and per-row coefficients */
    u8 *mark = calloc((size_t)N, 1);
    for (int64_t i = 0; i < (int64_t)B * T; i++) mark[w->pos[i]] = 1;
    w->n_used = 0;
    for (int64_t j = 0; j < N; j++) if (mark[j]) w->rows_used[w->n_used++] = j;
    int64_t *where = malloc((size_t)N * sizeof *where);
    for (int64_t i = 0; i < w->n_used; i++) where[w->rows_used[i]] = i;
    memset(w->coef, 0, (size_t)B * N * ring_bytes());
    for (int b = 0; b < B; b++)
        for (int64_t i = 0; i < T; i++) {
            int64_t idx = where[w->pos[(size_t)b * T + i]];
            if (RING == 32) ((u32 *)w->coef)[(size_t)b * N + idx] = ((u32 *)w->val)[(size_t)b * T + i];
            else            ((u16 *)w->coef)[(size_t)b * N + idx] = ((u16 *)w->val)[(size_t)b * T + i];
        }
    /* per-row lists of (pad, coefficient): the batched gather touches only
     * the pads that actually have noise on a row, not all B of them */
    int32_t cnt = 0;
    for (int64_t i = 0; i < w->n_used; i++) {
        w->nz_off[i] = cnt;
        for (int b = 0; b < B; b++) {
            int nz = RING == 32 ? ((u32 *)w->coef)[(size_t)b * N + i] != 0 : ((u16 *)w->coef)[(size_t)b * N + i] != 0;
            if (!nz) continue;
            w->nz_b[cnt] = b;
            if (RING == 32) ((u32 *)w->nz_c)[cnt] = ((u32 *)w->coef)[(size_t)b * N + i]; else ((u16 *)w->nz_c)[cnt] = ((u16 *)w->coef)[(size_t)b * N + i];
            cnt++;
        }
    }
    w->nz_off[w->n_used] = cnt;
    free(mark); free(where);
}

/* the UNION batched gather: each used row once, only the pads with noise on
 * it (per-row lists). Rows in fours where possible is not available here
 * (the pad sets differ per row), so this is the one-row form. */
static void gather_union_u32(const work_t *w, int64_t c0, int64_t c1, u32 *u) {
    for (int64_t i = 0; i < w->n_used; i++) {
        const i8 *row = w->row_ptrs[i];
        const int32_t o0 = w->nz_off[i], o1 = w->nz_off[i + 1];
        for (int64_t c = c0; c < c1; c += 16) {
            __m512i x0 = LOAD_I8_32(row + c);
            for (int32_t o = o0; o < o1; o++) {
                u32 *ub = u + (size_t)w->nz_b[o] * MP + c;
                _mm512_storeu_si512((void *)ub, _mm512_add_epi32(_mm512_loadu_si512((const void *)ub),
                                     _mm512_mullo_epi32(x0, _mm512_set1_epi32((int)((const u32 *)w->nz_c)[o]))));
            }
        }
    }
}
static void gather_union_u16(const work_t *w, int64_t c0, int64_t c1, u16 *u) {
    for (int64_t i = 0; i < w->n_used; i++) {
        const i8 *row = w->row_ptrs[i];
        const int32_t o0 = w->nz_off[i], o1 = w->nz_off[i + 1];
        for (int64_t c = c0; c < c1; c += 32) {
            __m512i x0 = LOAD_I8_16(row + c);
            for (int32_t o = o0; o < o1; o++) {
                u16 *ub = u + (size_t)w->nz_b[o] * MP + c;
                _mm512_storeu_si512((void *)ub, _mm512_add_epi16(_mm512_loadu_si512((const void *)ub),
                                     _mm512_mullo_epi16(x0, _mm512_set1_epi16((short)((const u16 *)w->nz_c)[o]))));
            }
        }
    }
}

static void fill_s(work_t *w) {
    if (RING == 32) { u32 *s = w->s; for (int64_t i = 0; i < (int64_t)B * K; i++) s[i] = (u32)rnd(); }
    else            { u16 *s = w->s; for (int64_t i = 0; i < (int64_t)B * K; i++) s[i] = (u16)rnd(); }
}
static void fill_r_uniform(work_t *w) {
    if (RING == 32) { u32 *r = w->r; for (int64_t i = 0; i < (int64_t)B * N; i++) r[i] = (u32)rnd(); }
    else            { u16 *r = w->r; for (int64_t i = 0; i < (int64_t)B * N; i++) r[i] = (u16)rnd(); }
}

/* plain: u = W . r over all n rows */
static void pass_plain(const layer_t *L, work_t *w, void *u) {
    zero_u(u);
    #pragma omp parallel num_threads(THREADS)
    {
        int64_t c0, c1; col_range(omp_get_thread_num(), omp_get_num_threads(), M, 64, &c0, &c1);
        if (c0 < c1) {
            if (RING == 32) axpy_i8_u32(w->all_rows, w->r, N, N, c0, c1, u, MP);
            else            axpy_i8_u16(w->all_rows, w->r, N, N, c0, c1, u, MP);
        }
    }
}
static const void **wa_rows_buf;
static void pass_wa(const layer_t *L, work_t *w, void *u, int zero) {
    if (zero) zero_u(u);
    for (int64_t l = 0; l < K; l++) wa_rows_buf[l] = (const u8 *)L->WA + (size_t)l * M * ring_bytes();
    #pragma omp parallel num_threads(THREADS)
    {
        int64_t c0, c1; col_range(omp_get_thread_num(), omp_get_num_threads(), M, 64, &c0, &c1);
        if (c0 < c1) {
            if (RING == 32) axpy_u32_u32((const u32 **)wa_rows_buf, w->s, K, K, c0, c1, u, MP);
            else            axpy_u16_u16((const u16 **)wa_rows_buf, w->s, K, K, c0, c1, u, MP);
        }
    }
}
/* gather, strategy 0 = per pad (B.t row reads, streaming), 1 = union (each used row once, per-row pad lists) */
static void pass_gather(const layer_t *L, work_t *w, void *u, int zero, int strategy) {
    if (zero) zero_u(u);
    for (int64_t i = 0; i < w->n_used; i++) w->row_ptrs[i] = L->W + (size_t)w->rows_used[i] * M;
    for (int b = 0; b < B; b++) for (int64_t i = 0; i < T; i++) w->pad_rows[(size_t)b * T + i] = L->W + (size_t)w->pos[(size_t)b * T + i] * M;
    #pragma omp parallel num_threads(THREADS)
    {
        int64_t c0, c1; col_range(omp_get_thread_num(), omp_get_num_threads(), M, 64, &c0, &c1);
        if (c0 < c1) {
            if (strategy == 0) {
                for (int b = 0; b < B; b++) {
                    if (RING == 32) axpy1_i8_u32(w->pad_rows + (size_t)b * T, (const u32 *)w->val + (size_t)b * T, T, c0, c1, (u32 *)u + (size_t)b * MP);
                    else            axpy1_i8_u16(w->pad_rows + (size_t)b * T, (const u16 *)w->val + (size_t)b * T, T, c0, c1, (u16 *)u + (size_t)b * MP);
                }
            } else {
                if (RING == 32) gather_union_u32(w, c0, c1, u);
                else            gather_union_u16(w, c0, c1, u);
            }
        }
    }
}
static void pass_a_s(const layer_t *L, work_t *w) {
    #pragma omp parallel num_threads(THREADS)
    {
        int64_t j0, j1; col_range(omp_get_thread_num(), omp_get_num_threads(), N, 32, &j0, &j1);
        if (j0 < j1) {
            if (!strcmp(AMODE, "toeplitz")) { if (RING == 32) a_s_toeplitz_u32(L->A, w->s, w->r, j0, j1); else a_s_toeplitz_u16(L->A, w->s, w->r, j0, j1); }
            else if (!strcmp(AMODE, "dense8")) a_s_dense8_u32(L->A, w->s, w->r, j0, j1);
            else a_s_dense_u32(L->A, w->s, w->r, j0, j1);
        }
    }
}
static void scatter_e(work_t *w) {
    for (int b = 0; b < B; b++)
        for (int64_t i = 0; i < T; i++) {
            int64_t j = w->pos[(size_t)b * T + i];
            if (RING == 32) ((u32 *)w->r)[(size_t)b * N + j] += ((u32 *)w->val)[(size_t)b * T + i];
            else            ((u16 *)w->r)[(size_t)b * N + j] += ((u16 *)w->val)[(size_t)b * T + i];
        }
}
/* the whole LPN pad: r = A.s + e and u = WA.s + W.e */
static void pass_lpn(const layer_t *L, work_t *w, void *u, int strategy) {
    pass_a_s(L, w);
    scatter_e(w);
    pass_wa(L, w, u, 1);
    pass_gather(L, w, u, 0, strategy);
}

/* ------------------------------------------------------------------ main */
static void usage(void) {
    fprintf(stderr, "bench_pads --n N --m M --k K --t T [--batch B] [--threads T] [--layers L] [--reps R] [--ring 32|16] [--a dense|dense8|toeplitz] [--random] [--json] [--no-verify]\n");
    exit(2);
}

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        #define ARG(name, var, conv) if (!strcmp(argv[i], name) && i + 1 < argc) { var = conv(argv[++i]); continue; }
        ARG("--n", N, atoll) ARG("--m", M, atoll) ARG("--k", K, atoll) ARG("--t", T, atoll)
        ARG("--batch", B, atoi) ARG("--threads", THREADS, atoi) ARG("--layers", LAYERS, atoi) ARG("--reps", REPS, atoi) ARG("--ring", RING, atoi)
        if (!strcmp(argv[i], "--a") && i + 1 < argc) { AMODE = argv[++i]; continue; }
        if (!strcmp(argv[i], "--random")) { REGULAR = 0; continue; }
        if (!strcmp(argv[i], "--json")) { JSON = 1; continue; }
        if (!strcmp(argv[i], "--no-verify")) { VERIFY = 0; continue; }
        usage();
    }
    if (RING != 32 && RING != 16) usage();
    if (M % 64) { fprintf(stderr, "m must be a multiple of 64\n"); return 2; }
    if (RING == 16 && strcmp(AMODE, "toeplitz")) { fprintf(stderr, "ring 16 implements only --a toeplitz\n"); return 2; }
    if (K > N || T > N || T < 1 || K < 1) { fprintf(stderr, "need 1 <= k, t <= n\n"); return 2; }
    const size_t rb = ring_bytes();
    MP = M + (RING == 32 ? 16 : 32);
    wa_rows_buf = xalloc((size_t)K * sizeof(void *));

    /* layers */
    layer_t *Ls = calloc((size_t)LAYERS, sizeof *Ls);
    for (int L = 0; L < LAYERS; L++) {
        Ls[L].W = xalloc((size_t)N * M);
        for (size_t i = 0; i < (size_t)N * M; i++) Ls[L].W[i] = (i8)((int)(rnd() % 239) - 119);
        Ls[L].WA = xalloc((size_t)K * M * rb);
        if (!strcmp(AMODE, "toeplitz")) { Ls[L].A = xalloc((size_t)(N + K) * rb); }
        else if (!strcmp(AMODE, "dense8")) { Ls[L].A = xalloc((size_t)N * K); for (size_t i = 0; i < (size_t)N * K; i++) ((u8 *)Ls[L].A)[i] = (u8)rnd(); }
        else { Ls[L].A = xalloc((size_t)N * K * 4); for (size_t i = 0; i < (size_t)N * K; i++) ((u32 *)Ls[L].A)[i] = (u32)rnd(); }
        if (!strcmp(AMODE, "toeplitz")) { if (RING == 32) for (size_t i = 0; i < (size_t)(N + K); i++) ((u32 *)Ls[L].A)[i] = (u32)rnd(); else for (size_t i = 0; i < (size_t)(N + K); i++) ((u16 *)Ls[L].A)[i] = (u16)rnd(); }
        /* WA = W . A : for the benchmark, random content is as good as the
         * real product (same bytes, same arithmetic) EXCEPT for the check, which
         * needs the true product; computed for layer 0 only, below. */
        if (RING == 32) for (size_t i = 0; i < (size_t)K * M; i++) ((u32 *)Ls[L].WA)[i] = (u32)rnd();
        else            for (size_t i = 0; i < (size_t)K * M; i++) ((u16 *)Ls[L].WA)[i] = (u16)rnd();
    }

    work_t w = {0};
    w.r = xalloc((size_t)B * N * rb); w.s = xalloc((size_t)B * K * rb);
    w.pos = xalloc((size_t)B * T * sizeof(int64_t)); w.val = xalloc((size_t)B * T * rb);
    w.rows_used = xalloc((size_t)N * sizeof(int64_t)); w.coef = xalloc((size_t)B * N * rb);
    w.row_ptrs = xalloc((size_t)N * sizeof(i8 *)); w.all_rows = xalloc((size_t)N * sizeof(i8 *));
    w.nz_off = xalloc(((size_t)N + 1) * sizeof(int32_t)); w.nz_b = xalloc((size_t)B * T * sizeof(int32_t)); w.nz_c = xalloc((size_t)B * T * rb);
    w.pad_rows = xalloc((size_t)B * T * sizeof(i8 *));
    w.u = xalloc((size_t)B * MP * rb); w.u2 = xalloc((size_t)B * MP * rb); w.u3 = xalloc((size_t)B * MP * rb);
    zero_u(w.u); zero_u(w.u2); zero_u(w.u3);

    /* ---- the check: layer 0 with the TRUE W.A, u_lpn == plain(W, A.s + e) ---- */
    if (VERIFY) {
        layer_t *L0 = &Ls[0];
        for (int64_t j = 0; j < N; j++) w.all_rows[j] = L0->W + (size_t)j * M;
        /* WA[l][i] = sum_j W_in[j][i] * A[j][l]: A column l as coefficients over rows of W_in.
         * Reuse the axpy kernel with B' = 1 per l would be slow for large k; do it in
         * batches of the current B via the r buffer: coef[b][j] = A[j][l_b]. */
        void *AT = xalloc((size_t)K * N * rb);     /* A transposed: [l][j] */
        for (int64_t j = 0; j < N; j++)
            for (int64_t l = 0; l < K; l++) {
                if (!strcmp(AMODE, "toeplitz")) { if (RING == 32) ((u32 *)AT)[(size_t)l * N + j] = ((u32 *)L0->A)[j + l]; else ((u16 *)AT)[(size_t)l * N + j] = ((u16 *)L0->A)[j + l]; }
                else if (!strcmp(AMODE, "dense8")) ((u32 *)AT)[(size_t)l * N + j] = ((u8 *)L0->A)[(size_t)j * K + l];
                else ((u32 *)AT)[(size_t)l * N + j] = ((u32 *)L0->A)[(size_t)j * K + l];
            }
        int saveB = B;
        for (int64_t l0 = 0; l0 < K; l0 += saveB) {
            int bb = (int)((K - l0 < saveB) ? K - l0 : saveB);
            B = bb;
            memcpy(w.r, (u8 *)AT + (size_t)l0 * N * rb, (size_t)bb * N * rb);
            pass_plain(L0, &w, w.u2);
            for (int b = 0; b < bb; b++) memcpy((u8 *)L0->WA + ((size_t)l0 + b) * M * rb, (u8 *)w.u2 + (size_t)b * MP * rb, (size_t)M * rb);
        }
        B = saveB;
        free(AT);
        fill_s(&w); fill_noise(&w);
        pass_lpn(L0, &w, w.u, 0);              /* r = A.s + e, u = WA.s + W.e (per-pad gather) */
        pass_plain(L0, &w, w.u2);              /* plain(W, r) */
        pass_wa(L0, &w, w.u3, 1); pass_gather(L0, &w, w.u3, 0, 1);   /* union gather */
        if (memcmp(w.u, w.u2, (size_t)B * MP * rb)) { fprintf(stderr, "CHECK FAILED: u_lpn != W.(A.s + e)\n"); return 1; }
        if (memcmp(w.u, w.u3, (size_t)B * MP * rb)) { fprintf(stderr, "CHECK FAILED: union gather != per-pad gather\n"); return 1; }
        if (!JSON) fprintf(stderr, "check ok: u_lpn == W.(A.s+e) bit for bit (ring %d, n=%lld m=%lld k=%lld t=%lld B=%d, %s A, %s noise)\n",
                           RING, (long long)N, (long long)M, (long long)K, (long long)T, B, AMODE, REGULAR ? "regular" : "random");
    }

    /* ---- timing ---- */
    double t_plain[64], t_wa[64], t_gather[64], t_gather1[64], t_as[64], t_lpn[64], t_lpn1[64];
    if (REPS > 64) REPS = 64;
    int64_t used_sum = 0;
    for (int rep = 0; rep < REPS + 1; rep++) {              /* +1 warm-up, discarded */
        layer_t *L = &Ls[rep % LAYERS];
        for (int64_t j = 0; j < N; j++) w.all_rows[j] = L->W + (size_t)j * M;
        fill_s(&w); fill_noise(&w); fill_r_uniform(&w);
        int i = rep - 1;
        double t0 = now(); pass_plain(L, &w, w.u); double t1 = now(); if (i >= 0) t_plain[i] = t1 - t0;
        L = &Ls[(rep + 1) % LAYERS]; for (int64_t j = 0; j < N; j++) w.all_rows[j] = L->W + (size_t)j * M;
        t0 = now(); pass_wa(L, &w, w.u, 1); t1 = now(); if (i >= 0) t_wa[i] = t1 - t0;
        L = &Ls[(rep + 2) % LAYERS]; for (int64_t j = 0; j < N; j++) w.all_rows[j] = L->W + (size_t)j * M;
        t0 = now(); pass_gather(L, &w, w.u, 1, 0); t1 = now(); if (i >= 0) t_gather[i] = t1 - t0;
        L = &Ls[(rep + 3) % LAYERS];
        t0 = now(); pass_gather(L, &w, w.u, 1, 1); t1 = now(); if (i >= 0) t_gather1[i] = t1 - t0;
        L = &Ls[(rep + 4) % LAYERS];
        t0 = now(); pass_a_s(L, &w); t1 = now(); if (i >= 0) t_as[i] = t1 - t0;
        L = &Ls[(rep + 5) % LAYERS]; for (int64_t j = 0; j < N; j++) w.all_rows[j] = L->W + (size_t)j * M;
        t0 = now(); pass_lpn(L, &w, w.u, 0); t1 = now(); if (i >= 0) t_lpn[i] = t1 - t0;
        L = &Ls[(rep + 6) % LAYERS]; for (int64_t j = 0; j < N; j++) w.all_rows[j] = L->W + (size_t)j * M;
        t0 = now(); pass_lpn(L, &w, w.u, 1); t1 = now(); if (i >= 0) t_lpn1[i] = t1 - t0;
        if (i >= 0) used_sum += w.n_used;
    }
    /* W.A back to back on one layer, nothing else touching the cache in
     * between: the L3-resident case the handoff's section 4.3 hypothesises.
     * The loop above cannot show it, because each rep streams W (n.m bytes)
     * through the cache between two W.A passes. */
    double t_wa_hot[64];
    for (int i = 0; i < REPS + 1; i++) { double t0 = now(); pass_wa(&Ls[0], &w, w.u, 1); double t1 = now(); if (i > 0) t_wa_hot[i - 1] = t1 - t0; }
    double mwh = median(t_wa_hot, REPS);
    double mp = median(t_plain, REPS), mw = median(t_wa, REPS), ma = median(t_as, REPS);
    double mg0 = median(t_gather, REPS), mg1 = median(t_gather1, REPS), ml0 = median(t_lpn, REPS), ml1 = median(t_lpn1, REPS);
    const int best = (B > 1 && ml1 < ml0) ? 1 : 0;           /* B = 1: the two are the same kernel family; per-pad is canonical */
    double mg = best ? mg1 : mg0, ml = best ? ml1 : ml0;
    double rows_used = (double)used_sum / REPS;
    double rows_read = best ? rows_used : (double)B * T;
    double by_plain = (double)N * M, by_wa = (double)K * M * rb, by_gather = rows_read * M;
    double by_as = !strcmp(AMODE, "toeplitz") ? (double)(N + K) * rb : (!strcmp(AMODE, "dense8") ? (double)N * K : (double)N * K * 4);
    double fl_plain = (double)N * M * B, fl_wa = (double)K * M * B, fl_gather = (double)T * M * B, fl_as = (double)N * K * B;
    if (JSON) {
        printf("{\"n\":%lld,\"m\":%lld,\"k\":%lld,\"t\":%lld,\"batch\":%d,\"threads\":%d,\"layers\":%d,\"ring\":%d,\"a_mode\":\"%s\",\"regular\":%d,\"reps\":%d,"
               "\"rows_gathered\":%.1f,\"rows_read\":%.1f,\"gather_strategy\":\"%s\",\"gather_perpad_s\":%.6g,\"gather_union_s\":%.6g,\"lpn_perpad_s\":%.6g,\"lpn_union_s\":%.6g,"
               "\"plain\":{\"s\":%.6g,\"bytes\":%.6g,\"flops\":%.6g},"
               "\"wa\":{\"s\":%.6g,\"bytes\":%.6g,\"flops\":%.6g},\"wa_hot_s\":%.6g,"
               "\"gather\":{\"s\":%.6g,\"bytes\":%.6g,\"flops\":%.6g},"
               "\"a_s\":{\"s\":%.6g,\"bytes\":%.6g,\"flops\":%.6g},"
               "\"lpn\":{\"s\":%.6g,\"bytes\":%.6g,\"flops\":%.6g},"
               "\"speedup\":%.4g}\n",
               (long long)N, (long long)M, (long long)K, (long long)T, B, THREADS, LAYERS, RING, AMODE, REGULAR, REPS, rows_used, rows_read, best ? "union" : "perpad", mg0, mg1, ml0, ml1,
               mp, by_plain, fl_plain, mw, by_wa, fl_wa, mwh, mg, by_gather, fl_gather, ma, by_as, fl_as,
               ml, by_wa + by_gather + by_as, fl_wa + fl_gather + fl_as, mp / ml);
    } else {
        printf("n=%lld m=%lld k=%lld t=%lld B=%d threads=%d layers=%d ring=%d A=%s %s\n", (long long)N, (long long)M, (long long)K, (long long)T, B, THREADS, LAYERS, RING, AMODE, REGULAR ? "regular" : "random");
        printf("  %-8s %9s %9s %8s %8s\n", "term", "us/batch", "us/pad", "GB/s", "GMAC/s");
        #define ROW(name, t, by, fl) printf("  %-8s %9.1f %9.1f %8.1f %8.1f\n", name, (t) * 1e6, (t) * 1e6 / B, (by) / (t) / 1e9, (fl) / (t) / 1e9)
        ROW("plain", mp, by_plain, fl_plain); ROW("wa", mw, by_wa, fl_wa); ROW("wa-hot", mwh, by_wa, fl_wa); ROW("gather", mg, by_gather, fl_gather); ROW("a_s", ma, by_as, fl_as);
        ROW("lpn", ml, by_wa + by_gather + by_as, fl_wa + fl_gather + fl_as);
        printf("  speedup plain/lpn = %.2fx   (bytes ratio %.2f, union %.0f rows of %lld, %s gather wins: per-pad %.1f us vs union %.1f us)\n", mp / ml, (by_wa + by_gather + by_as) / by_plain, rows_used, (long long)N, best ? "union" : "per-pad", mg0 * 1e6, mg1 * 1e6);
    }
    return 0;
}
