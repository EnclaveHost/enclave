/*
 * shielded-simd.h -- the hot loops, dispatched at run time.
 *
 * shielded-simd.c is compiled twice (AVX-512 VNNI and generic); sh_simd_get()
 * returns the table for this CPU. SHIELDED_NO_SIMD=1 forces the generic build,
 * which is also how the two are checked against each other.
 */
#ifndef SHIELDED_SIMD_H
#define SHIELDED_SIMD_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SH_FV_P2 2147483647

typedef struct {
    const char *name;
    void    (*pad_planes)(const int32_t *r, size_t n, uint8_t *p0, uint8_t *p1, uint8_t *p2);
    void    (*mask_planes)(const int64_t *x, const int32_t *r, size_t n, int8_t *p0, int8_t *p1, int8_t *p2);
    void    (*unmask)(const int32_t *ym, const int32_t *u, size_t n, int64_t *y);
    void    (*encode)(const float *src, size_t n, float scale, int64_t *x);
    void    (*descale)(const int64_t *y, const float *inv, size_t n, float *dst);
    int64_t (*fv_dot)(const int64_t *y, const int64_t *s, int stride, int rep, int64_t n);
    int64_t (*fv_dot_x)(const int64_t *x, const int64_t *st, int stride, int rep, int64_t n);
    void    (*fv_prepare)(const int8_t *W, int64_t K, int64_t N, const int64_t *s, int reps, int64_t *st);
    void    (*refill)(const uint8_t *planes, int b, const int8_t *W, int64_t K, int64_t N,
                      int32_t *u, int64_t u_stride, int32_t *acc);
    void    (*outlier_add)(const int64_t *x_tee, const int8_t *wc, int nout, int64_t N, int64_t *y);
} sh_simd;

const sh_simd *sh_simd_get(void);
const sh_simd *sh_simd_generic(void);

#define SH_SIMD_DECL(sfx) \
    void    sh_simd_##sfx##_pad_planes(const int32_t *, size_t, uint8_t *, uint8_t *, uint8_t *); \
    void    sh_simd_##sfx##_mask_planes(const int64_t *, const int32_t *, size_t, int8_t *, int8_t *, int8_t *); \
    void    sh_simd_##sfx##_unmask(const int32_t *, const int32_t *, size_t, int64_t *); \
    void    sh_simd_##sfx##_encode(const float *, size_t, float, int64_t *); \
    void    sh_simd_##sfx##_descale(const int64_t *, const float *, size_t, float *); \
    int64_t sh_simd_##sfx##_fv_dot(const int64_t *, const int64_t *, int, int, int64_t); \
    int64_t sh_simd_##sfx##_fv_dot_x(const int64_t *, const int64_t *, int, int, int64_t); \
    void    sh_simd_##sfx##_fv_prepare(const int8_t *, int64_t, int64_t, const int64_t *, int, int64_t *); \
    void    sh_simd_##sfx##_refill(const uint8_t *, int, const int8_t *, int64_t, int64_t, int32_t *, int64_t, int32_t *); \
    void    sh_simd_##sfx##_outlier_add(const int64_t *, const int8_t *, int, int64_t, int64_t *);
SH_SIMD_DECL(avx512)
SH_SIMD_DECL(generic)

#ifdef __cplusplus
}
#endif
#endif
