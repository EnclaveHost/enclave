/* pack24-selftest -- the 3-byte pad codec (shielded-pack24.h) on its own.
 *
 *   - every one of the 2^24 patterns, decoded as r and as u: accepted exactly
 *     when in range, to exactly the value, and re-packed to the same 3 bytes
 *     (which also packs every valid r and every valid u once);
 *   - out-of-range int32 at and around every boundary, INT32_MIN/MAX included:
 *     pack refuses and leaves the destination wholly poisoned;
 *   - odd lengths 0..67 at unaligned offsets, random values weighted to the
 *     extremes: exact round trip, and no byte written outside the row;
 *   - one bad value first, in the middle or last: no partial row either way
 *     (pack -> all poison, unpack -> all zero);
 *   - the poison bytes never decode; the overflow helpers; the wipe.
 *
 *   cc -std=c11 -O2 -Wall -Wextra -fsanitize=address,undefined -I. pack24-selftest.c -o pack24-selftest
 * Needs no other object: only the header's macros are used from shielded-field.h. */
#include "shielded-pack24.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures;
#define CHECK(c, ...) do { if (!(c)) { if (failures++ < 50) { fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } } } while (0)

static uint64_t rs = 0x243f6a8885a308d3ull;
static uint64_t rnd(void) { rs ^= rs << 13; rs ^= rs >> 7; rs ^= rs << 17; return rs; }

#define M    ((int32_t)SH_M_MOD)
#define HALF ((int32_t)SH_HALF_M)
#define GUARD 16
#define CANARY 0xA5

static int32_t rand_r_val(void) {
    switch (rnd() % 6) {
    case 0: return 0;
    case 1: return M - 1;
    case 2: return (int32_t)(rnd() % 4);
    case 3: return M - 1 - (int32_t)(rnd() % 4);
    default: return (int32_t)(rnd() % (uint64_t)M);
    }
}
static int32_t rand_u_val(void) {
    switch (rnd() % 7) {
    case 0: return -HALF;
    case 1: return HALF;
    case 2: return 0;
    case 3: return -1;
    case 4: return HALF - (int32_t)(rnd() % 4);
    case 5: return -HALF + (int32_t)(rnd() % 4);
    default: return (int32_t)(rnd() % (uint64_t)(2 * (int64_t)HALF + 1)) - HALF;
    }
}

static int guards_ok(const uint8_t *buf, size_t lo, size_t hi, size_t total) {
    for (size_t i = 0; i < lo; i++) if (buf[i] != CANARY) return 0;
    for (size_t i = hi; i < total; i++) if (buf[i] != CANARY) return 0;
    return 1;
}
static int all_bytes(const uint8_t *p, size_t n, uint8_t v) {
    for (size_t i = 0; i < n; i++) if (p[i] != v) return 0;
    return 1;
}

static void test_constants(void) {
    CHECK(M == 14457349 && HALF == 7228674, "field constants %d %d", M, HALF);
    CHECK(sh_p24_sext(0x800000u) == -8388608 && sh_p24_sext(0x7FFFFFu) == 8388607 &&
          sh_p24_sext(0xFFFFFFu) == -1 && sh_p24_sext(0) == 0, "sign extension");
    CHECK(!sh_p24_r_bad(0) && !sh_p24_r_bad(M - 1) && sh_p24_r_bad(M) && sh_p24_r_bad(-1) &&
          sh_p24_r_bad(INT32_MIN) && sh_p24_r_bad(INT32_MAX), "r range");
    CHECK(!sh_p24_u_bad(-HALF) && !sh_p24_u_bad(HALF) && !sh_p24_u_bad(0) && sh_p24_u_bad(HALF + 1) &&
          sh_p24_u_bad(-HALF - 1) && sh_p24_u_bad(INT32_MIN) && sh_p24_u_bad(INT32_MAX), "u range");
}

/* Every 24-bit pattern, as r and as u. */
static void test_exhaustive(void) {
    uint64_t r_ok = 0, u_ok = 0;
    for (uint32_t p = 0; p < (1u << 24); p++) {
        uint8_t b[3], back[3]; int32_t v = 0x5A5A5A5A;
        sh_p24_put(b, p);
        const bool okr = sh_p24_unpack_r(b, 1, &v);
        if (okr != (p < (uint32_t)M)) CHECK(0, "r pattern %06x accepted=%d", p, okr);
        if (okr) {
            r_ok++;
            if (v != (int32_t)p) CHECK(0, "r pattern %06x -> %d", p, v);
            if (!sh_p24_pack_r(&v, 1, back) || memcmp(b, back, 3)) CHECK(0, "r %d does not re-pack to %06x", v, p);
        } else if (v != 0) CHECK(0, "rejected r pattern %06x left %d behind", p, v);

        v = 0x5A5A5A5A;
        const int32_t s = sh_p24_sext(p);
        const bool want_u = s >= -HALF && s <= HALF;
        const bool oku = sh_p24_unpack_u(b, 1, &v);
        if (oku != want_u) CHECK(0, "u pattern %06x (%d) accepted=%d", p, s, oku);
        if (oku) {
            u_ok++;
            if (v != s) CHECK(0, "u pattern %06x -> %d, want %d", p, v, s);
            if (!sh_p24_pack_u(&v, 1, back) || memcmp(b, back, 3)) CHECK(0, "u %d does not re-pack to %06x", v, p);
        } else if (v != 0) CHECK(0, "rejected u pattern %06x left %d behind", p, v);
    }
    CHECK(r_ok == (uint64_t)M, "valid r patterns %llu", (unsigned long long)r_ok);
    CHECK(u_ok == (uint64_t)(2 * (int64_t)HALF + 1), "valid u patterns %llu", (unsigned long long)u_ok);
}

/* Out-of-range int32: pack refuses, the row is all poison, nothing outside it moves. */
static void test_pack_rejects(void) {
    static const int32_t bad_r[] = { -1, -2, M, M + 1, 0xFFFFFF, 0x1000000, INT32_MIN, INT32_MIN + 1, INT32_MAX, -M, -HALF };
    static const int32_t bad_u[] = { HALF + 1, -HALF - 1, 0x7FFFFF, -0x800000, 0x800000, 0xFFFFFF, M, -M,
                                     INT32_MIN, INT32_MIN + 1, INT32_MAX, HALF + 2, -HALF - 2 };
    uint8_t buf[GUARD + 3 + GUARD];
    for (size_t i = 0; i < sizeof bad_r / sizeof bad_r[0]; i++) {
        memset(buf, CANARY, sizeof buf);
        CHECK(!sh_p24_pack_r(&bad_r[i], 1, buf + GUARD), "pack_r accepted %d", bad_r[i]);
        CHECK(all_bytes(buf + GUARD, 3, SH_P24_R_POISON) && guards_ok(buf, GUARD, GUARD + 3, sizeof buf), "pack_r(%d) row", bad_r[i]);
    }
    for (size_t i = 0; i < sizeof bad_u / sizeof bad_u[0]; i++) {
        memset(buf, CANARY, sizeof buf);
        CHECK(!sh_p24_pack_u(&bad_u[i], 1, buf + GUARD), "pack_u accepted %d", bad_u[i]);
        CHECK(all_bytes(buf + GUARD, 3, SH_P24_U_POISON) && guards_ok(buf, GUARD, GUARD + 3, sizeof buf), "pack_u(%d) row", bad_u[i]);
    }
}

/* Odd lengths, unaligned offsets, exact round trips, nothing written outside. */
static void test_rows(void) {
    enum { NMAX = 67 };
    int32_t src[NMAX], out[NMAX + 2 * GUARD / 4 + 4];
    uint8_t buf[GUARD + 3 * NMAX + GUARD + 4];
    for (size_t n = 0; n <= NMAX; n++)
        for (size_t off = 0; off < 4; off++)
            for (int kind = 0; kind < 2; kind++)
                for (int rep = 0; rep < 8; rep++) {
                    for (size_t i = 0; i < n; i++) src[i] = kind ? rand_u_val() : rand_r_val();
                    const size_t lo = GUARD + off, hi = lo + 3 * n;
                    memset(buf, CANARY, sizeof buf);
                    const bool p = kind ? sh_p24_pack_u(src, n, buf + lo) : sh_p24_pack_r(src, n, buf + lo);
                    CHECK(p, "pack kind %d n %zu", kind, n);
                    CHECK(guards_ok(buf, lo, hi, sizeof buf), "pack wrote outside the row (kind %d n %zu off %zu)", kind, n, off);
                    /* int32 destination guarded the same way, one element either side */
                    int32_t *d = out + 1;
                    out[0] = 0x3C3C3C3C; d[n] = 0x3C3C3C3C;
                    const bool u = kind ? sh_p24_unpack_u(buf + lo, n, d) : sh_p24_unpack_r(buf + lo, n, d);
                    CHECK(u, "unpack kind %d n %zu", kind, n);
                    CHECK(out[0] == 0x3C3C3C3C && d[n] == 0x3C3C3C3C, "unpack wrote outside (kind %d n %zu)", kind, n);
                    CHECK(n == 0 || !memcmp(src, d, n * sizeof *d), "round trip kind %d n %zu off %zu", kind, n, off);
                }
}

/* One bad value at the front, middle or back: never a partial row. */
static void test_no_partial(void) {
    static const size_t ns[] = { 1, 2, 3, 5, 17, 64, 67 };
    int32_t src[67], dst[67];
    uint8_t buf[GUARD + 3 * 67 + GUARD];
    for (size_t a = 0; a < sizeof ns / sizeof ns[0]; a++) {
        const size_t n = ns[a];
        const size_t at[3] = { 0, n / 2, n - 1 };
        for (int w = 0; w < 3; w++)
            for (int kind = 0; kind < 2; kind++) {
                for (size_t i = 0; i < n; i++) src[i] = kind ? rand_u_val() : rand_r_val();
                /* pack: one bad input */
                src[at[w]] = kind ? HALF + 1 : M;
                memset(buf, CANARY, sizeof buf);
                const bool p = kind ? sh_p24_pack_u(src, n, buf + GUARD) : sh_p24_pack_r(src, n, buf + GUARD);
                CHECK(!p, "pack accepted a bad value at %zu of %zu", at[w], n);
                CHECK(all_bytes(buf + GUARD, 3 * n, kind ? SH_P24_U_POISON : SH_P24_R_POISON),
                      "failed pack left a partial row (kind %d n %zu at %zu)", kind, n, at[w]);
                CHECK(guards_ok(buf, GUARD, GUARD + 3 * n, sizeof buf), "failed pack wrote outside the row");
                /* unpack: a valid row with one bad pattern */
                src[at[w]] = 0;
                CHECK(kind ? sh_p24_pack_u(src, n, buf + GUARD) : sh_p24_pack_r(src, n, buf + GUARD), "valid pack");
                sh_p24_put(buf + GUARD + 3 * at[w], kind ? 0x800000u : (uint32_t)M);
                memset(dst, 0x5A, sizeof dst);
                const bool u = kind ? sh_p24_unpack_u(buf + GUARD, n, dst) : sh_p24_unpack_r(buf + GUARD, n, dst);
                CHECK(!u, "unpack accepted a bad pattern at %zu of %zu", at[w], n);
                CHECK(all_bytes((const uint8_t *)dst, n * sizeof *dst, 0), "failed unpack left decoded values (kind %d n %zu at %zu)", kind, n, at[w]);
                CHECK(n == 67 || dst[n] == 0x5A5A5A5A, "failed unpack wiped past the row");
            }
    }
}

/* The poison never decodes, at any length. */
static void test_poison(void) {
    uint8_t buf[3 * 67]; int32_t dst[67];
    for (size_t n = 1; n <= 67; n++) {
        sh_p24_poison_r(buf, n);
        CHECK(!sh_p24_unpack_r(buf, n, dst), "r poison decoded (n %zu)", n);
        sh_p24_poison_u(buf, n);
        CHECK(!sh_p24_unpack_u(buf, n, dst), "u poison decoded (n %zu)", n);
    }
    /* A single poisoned value in an otherwise valid row is enough. */
    int32_t src[8] = { 0, 1, 2, 3, 4, 5, 6, 7 };
    CHECK(sh_p24_pack_r(src, 8, buf), "pack");
    sh_p24_poison_r(buf + 3 * 5, 1);
    CHECK(!sh_p24_unpack_r(buf, 8, dst), "one poisoned r in a row decoded");
    CHECK(sh_p24_pack_u(src, 8, buf), "pack");
    sh_p24_poison_u(buf + 3 * 7, 1);
    CHECK(!sh_p24_unpack_u(buf, 8, dst), "one poisoned u in a row decoded");
}

static void test_overflow_and_wipe(void) {
    size_t out = 1;
    CHECK(sh_p24_mul(0, SIZE_MAX, &out) && out == 0, "0 x MAX");
    CHECK(sh_p24_mul(SIZE_MAX, 1, &out) && out == SIZE_MAX, "MAX x 1");
    CHECK(!sh_p24_mul(SIZE_MAX, 2, &out), "MAX x 2");
    CHECK(!sh_p24_mul(SIZE_MAX / 2 + 1, 2, &out), "(MAX/2+1) x 2");
    CHECK(sh_p24_bytes(SIZE_MAX / 3, &out) && out == (SIZE_MAX / 3) * 3, "bytes MAX/3");
    CHECK(!sh_p24_bytes(SIZE_MAX / 3 + 1, &out), "bytes MAX/3 + 1");
    CHECK(sh_p24_mul3(0, SIZE_MAX, SIZE_MAX, &out) && out == 0, "0 x MAX x MAX");
    CHECK(!sh_p24_mul3(SIZE_MAX / 3 + 1, 1, 3, &out), "mul3 overflow in the second step");
    CHECK(!sh_p24_mul3(SIZE_MAX, 2, 1, &out), "mul3 overflow in the first step");
    CHECK(sh_p24_mul3(4096, 248320, 3, &out) && out == (size_t)4096 * 248320 * 3, "a real ring");
    uint8_t w[33];
    memset(w, 0xEE, sizeof w);
    sh_p24_wipe(w, 32);
    CHECK(all_bytes(w, 32, 0) && w[32] == 0xEE, "wipe");
    sh_p24_wipe(NULL, 32);
    sh_p24_wipe(w, 0);
}

int main(void) {
    test_constants();
    test_exhaustive();
    test_pack_rejects();
    test_rows();
    test_no_partial();
    test_poison();
    test_overflow_and_wipe();
    printf("{\"pack24_selftest\":%s,\"failures\":%d}\n", failures ? "false" : "true", failures);
    return failures ? 1 : 0;
}
