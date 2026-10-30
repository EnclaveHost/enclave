/* shielded-pack24.h -- lossless 3-byte storage for the pad ring (opt-in,
 * SHIELDED_POOL_PACK24=1). Header-only, portable scalar C, no SIMD.
 *
 * The ring holds two kinds of value, both of which fit 24 bits exactly:
 *   r: the mask, in [0, M), M = 14457349 < 2^24, stored unsigned;
 *   u: r.W as its balanced representative, in [-HALF_M, HALF_M] with
 *      HALF_M = 7228674 < 2^23, stored as 24-bit two's complement.
 * Little-endian, three bytes per value, no padding, no header: a row of n
 * values is exactly 3n bytes.
 *
 * Every call checks every value. Packing a value outside its range, or
 * unpacking a 24-bit pattern outside it, FAILS the whole call -- the caller
 * treats that as an integrity failure, never as data. A failed pack leaves the
 * whole destination poisoned (see below); a failed unpack leaves the whole
 * destination zeroed. Neither ever hands back a partial row.
 *
 * Poison. A repeated byte that no valid value of that kind can encode, so a
 * slot that was never written, or was already consumed and poisoned, can never
 * be read back as a pad: 0xFF for r (0xFFFFFF >= M), 0x80 for u (0x808080 is
 * -8355712 < -HALF_M). The two ranges are disjoint, so they need two bytes. */
#ifndef SHIELDED_PACK24_H
#define SHIELDED_PACK24_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "shielded-field.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SH_P24_BYTES    3
#define SH_P24_R_POISON 0xFF
#define SH_P24_U_POISON 0x80

#define SH_P24_R_LIMIT  ((uint32_t)SH_M_MOD)          /* r < this */
#define SH_P24_U_HALF   ((uint32_t)SH_HALF_M)         /* |u| <= this */

#if !defined(__cplusplus)
_Static_assert(SH_M_MOD == 14457349, "pack24: field modulus changed");
_Static_assert(SH_M_MOD < (1 << 24), "pack24: r does not fit 24 bits");
_Static_assert(SH_HALF_M < (1 << 23), "pack24: balanced u does not fit 24 signed bits");
_Static_assert(0xFFFFFF >= SH_M_MOD, "pack24: r poison decodes as a valid r");
_Static_assert(0x808080 - 0x1000000 < -SH_HALF_M, "pack24: u poison decodes as a valid u");
#endif

/* Overflow-checked a * b, and a * b * c, in size_t. */
static inline bool sh_p24_mul(size_t a, size_t b, size_t *out) {
    if (a && b > SIZE_MAX / a) return false;
    *out = a * b;
    return true;
}
static inline bool sh_p24_mul3(size_t a, size_t b, size_t c, size_t *out) {
    size_t ab;
    return sh_p24_mul(a, b, &ab) && sh_p24_mul(ab, c, out);
}
/* Bytes for n packed values. */
static inline bool sh_p24_bytes(size_t n, size_t *out) { return sh_p24_mul(n, SH_P24_BYTES, out); }

/* Zero a private buffer in a way the compiler may not drop as a dead store. */
static inline void sh_p24_wipe(void *p, size_t n) {
    if (!p || !n) return;
    memset(p, 0, n);
#if defined(__GNUC__) || defined(__clang__)
    __asm__ __volatile__("" : : "r"(p) : "memory");
#else
    volatile unsigned char *v = (volatile unsigned char *)p;
    for (size_t i = 0; i < n; i++) v[i] = 0;
#endif
}

static inline void sh_p24_poison_r(uint8_t *dst, size_t n) { memset(dst, SH_P24_R_POISON, n * SH_P24_BYTES); }
static inline void sh_p24_poison_u(uint8_t *dst, size_t n) { memset(dst, SH_P24_U_POISON, n * SH_P24_BYTES); }

static inline void sh_p24_put(uint8_t *d, uint32_t v) {
    d[0] = (uint8_t)v; d[1] = (uint8_t)(v >> 8); d[2] = (uint8_t)(v >> 16);
}
static inline uint32_t sh_p24_get(const uint8_t *s) {
    return (uint32_t)s[0] | ((uint32_t)s[1] << 8) | ((uint32_t)s[2] << 16);
}
/* 24-bit two's complement -> int32, without relying on signed shifts. */
static inline int32_t sh_p24_sext(uint32_t v24) {
    return (int32_t)(v24 ^ 0x800000u) - 0x800000;
}
/* The range tests, branch-free so the loops below accumulate them. */
static inline uint32_t sh_p24_r_bad(int32_t v) { return (uint32_t)v >= SH_P24_R_LIMIT; }
static inline uint32_t sh_p24_u_bad(int32_t v) {
    /* v in [-HALF, HALF]  <=>  v + HALF in [0, 2 HALF]; computed in uint32 so
     * INT32_MIN/INT32_MAX wrap to large values instead of overflowing. */
    return (uint32_t)v + SH_P24_U_HALF > 2u * SH_P24_U_HALF;
}

/* n values of r -> 3n bytes. False (and dst poisoned) if any r is outside [0, M). */
static inline bool sh_p24_pack_r(const int32_t *src, size_t n, uint8_t *dst) {
    uint32_t bad = 0;
    for (size_t i = 0; i < n; i++) {
        const int32_t v = src[i];
        bad |= sh_p24_r_bad(v);
        sh_p24_put(dst + SH_P24_BYTES * i, (uint32_t)v);
    }
    if (bad) { sh_p24_poison_r(dst, n); return false; }
    return true;
}

/* n balanced u -> 3n bytes. False (and dst poisoned) if any |u| > HALF_M. */
static inline bool sh_p24_pack_u(const int32_t *src, size_t n, uint8_t *dst) {
    uint32_t bad = 0;
    for (size_t i = 0; i < n; i++) {
        const int32_t v = src[i];
        bad |= sh_p24_u_bad(v);
        sh_p24_put(dst + SH_P24_BYTES * i, (uint32_t)v & 0xFFFFFFu);
    }
    if (bad) { sh_p24_poison_u(dst, n); return false; }
    return true;
}

/* 3n bytes -> n values of r. False (and dst zeroed) if any pattern is >= M. */
static inline bool sh_p24_unpack_r(const uint8_t *src, size_t n, int32_t *dst) {
    uint32_t bad = 0;
    for (size_t i = 0; i < n; i++) {
        const int32_t v = (int32_t)sh_p24_get(src + SH_P24_BYTES * i);
        bad |= sh_p24_r_bad(v);
        dst[i] = v;
    }
    if (bad) { sh_p24_wipe(dst, n * sizeof *dst); return false; }
    return true;
}

/* 3n bytes -> n balanced u. False (and dst zeroed) if any value is out of range. */
static inline bool sh_p24_unpack_u(const uint8_t *src, size_t n, int32_t *dst) {
    uint32_t bad = 0;
    for (size_t i = 0; i < n; i++) {
        const int32_t v = sh_p24_sext(sh_p24_get(src + SH_P24_BYTES * i));
        bad |= sh_p24_u_bad(v);
        dst[i] = v;
    }
    if (bad) { sh_p24_wipe(dst, n * sizeof *dst); return false; }
    return true;
}

#ifdef __cplusplus
}
#endif
#endif
