/* shielded-wide.h -- the few places the engine needs more than 64 bits, written so that a compiler
 * without __int128 (MSVC, for the VBS enclave build) gives the SAME answers: dot products reduced
 * mod M, and overflow-checked size arithmetic. Every function here is exact, not approximate:
 * a residue mod M is the same whether the sum was formed in 128 bits or reduced on the way. */
#ifndef SHIELDED_WIDE_H
#define SHIELDED_WIDE_H
#include <stdint.h>
#include <stddef.h>
#if defined(_MSC_VER) && !defined(__clang__)
#include <intrin.h>
static inline int sh_mul_u64(uint64_t a, uint64_t b, uint64_t *out) { uint64_t hi; *out = _umul128(a, b, &hi); return hi != 0; }   /* 1 = overflowed */
#else
static inline int sh_mul_u64(uint64_t a, uint64_t b, uint64_t *out) { return __builtin_mul_overflow(a, b, out); }
#endif
static inline int sh_add_u64(uint64_t a, uint64_t b, uint64_t *out) { *out = a + b; return *out < a; }

/* sum_j a[j]*b[j] mod M, in [0, M). Each product is reduced before it is added, so the running sum
 * stays below 2^31 * M and cannot overflow for any int32 inputs and any M < 2^32. */
static inline int64_t sh_dot_mod_i32(const int32_t *a, const int32_t *b, int64_t n, int64_t M) {
    int64_t acc = 0;
    for (int64_t j = 0; j < n; j++) { acc += ((int64_t)a[j] * b[j]) % M; if (acc >= ((int64_t)1 << 62) || acc <= -((int64_t)1 << 62)) acc %= M; }
    acc %= M; if (acc < 0) acc += M; return acc;
}
/* sum_j w[j*stride]*s[j] mod M with int8 w: a product is below 2^38 for |s| < 2^31, so 2^24 of them
 * fit before a reduction is needed. */
static inline int64_t sh_dot_mod_i8(const int8_t *w, int64_t stride, const int32_t *s, int64_t n, int64_t M) {
    int64_t acc = 0, part = 0, cnt = 0;
    for (int64_t j = 0; j < n; j++) { part += (int64_t)w[j * stride] * s[j]; if (++cnt == ((int64_t)1 << 24)) { acc = (acc + part % M) % M; part = 0; cnt = 0; } }
    acc = (acc + part % M) % M; if (acc < 0) acc += M; return acc;
}
/* K*N + m*(3K + 4N) <= INT64_MAX, without a wide multiply. */
static inline int sh_layout_fits(int64_t K, int64_t N, int64_t m) {
    uint64_t kn, k3, n4, s, ms, t;
    if (K <= 0 || N <= 0 || m < 0) return 0;
    if (sh_mul_u64((uint64_t)K, (uint64_t)N, &kn) || sh_mul_u64(3, (uint64_t)K, &k3) || sh_mul_u64(4, (uint64_t)N, &n4)) return 0;
    if (sh_add_u64(k3, n4, &s) || sh_mul_u64((uint64_t)m, s, &ms) || sh_add_u64(kn, ms, &t)) return 0;
    return t <= (uint64_t)INT64_MAX;
}
/* a 64-byte aligned block, freed with sh_aligned_free: MSVC's heap cannot free an aligned block with free() */
#include <stdlib.h>
#if defined(_MSC_VER) && !defined(__clang__)
#include <malloc.h>
static inline void *sh_aligned_alloc64(size_t n) { return _aligned_malloc(n, 64); }
static inline void sh_aligned_free(void *p) { _aligned_free(p); }
#else
static inline void *sh_aligned_alloc64(size_t n) { return aligned_alloc(64, (n + 63) & ~(size_t)63); }
static inline void sh_aligned_free(void *p) { free(p); }
#endif
#endif
