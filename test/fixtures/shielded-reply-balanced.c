/* The untrusted reply's range check, which decides whether a kernel is allowed
 * to touch the worker's reply at all.
 *
 * It moved from shielded-tee.c into the SIMD table so it is built with the
 * arch flags (shielded-simd.c is compiled twice; shielded-tee.c once, at
 * baseline). That is a performance move, and a performance move on a security
 * check is only safe if the predicate is EXACTLY the same one. So: every
 * table's version against the portable reference, over the boundaries that
 * matter -- the last accepted value, the first rejected one either side,
 * INT32_MIN/MAX (which is why the predicate adds unsigned), and a bad value
 * placed at every position in the buffer including the very last, since an
 * OR reduction that dropped a tail element would still pass a random test. */
#include "../../wasm/ggml-shielded/shielded-field.h"
#include "../../wasm/ggml-shielded/shielded-simd.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Byte-for-byte the predicate shielded-tee.c kept as its reference. */
static bool reference(const int32_t *values, size_t n) {
    uint32_t bad = 0;
    for (size_t i = 0; i < n; i++)
        bad |= (uint32_t)values[i] + (uint32_t)SH_HALF_M >= (uint32_t)SH_M_MOD;
    return bad == 0;
}

typedef struct {
    const char *name;
    bool (*fn)(const int32_t *, size_t);
    bool (*within)(const int64_t *, size_t, uint64_t);
} table;

/* The activation bound moved for the same reason and needs the same holding to
 * account: same predicate, built with the arch flags. */
static bool within_reference(const int64_t *values, size_t n, uint64_t limit) {
    uint64_t bad = 0;
    for (size_t i = 0; i < n; i++) bad |= (uint64_t)values[i] + limit - 1 >= 2 * limit - 1;
    return bad == 0;
}

static uint64_t rng = 0x243f6a8885a308d3ull;
static uint64_t nextr(void) { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return rng; }

int main(void) {
    const table tables[] = {
        { "generic", sh_simd_generic_reply32_balanced, sh_simd_generic_values_within },
#if !defined(__aarch64__)
        { "avx512",  sh_simd_avx512_reply32_balanced,  sh_simd_avx512_values_within  },
#else
        { "neon",    sh_simd_neon_reply32_balanced,    sh_simd_neon_values_within    },
#endif
    };
    /* The exact edges of (-M/2, M/2]. */
    const int32_t edges[] = {
        0, 1, -1,
        (int32_t)SH_HALF_M, (int32_t)SH_HALF_M + 1, (int32_t)SH_HALF_M - 1,
        -(int32_t)SH_HALF_M, -(int32_t)SH_HALF_M + 1, -(int32_t)SH_HALF_M - 1,
        (int32_t)SH_M_MOD, -(int32_t)SH_M_MOD,
        INT32_MAX, INT32_MIN, INT32_MAX - 1, INT32_MIN + 1,
    };
    const size_t ne = sizeof edges / sizeof edges[0];

    for (size_t t = 0; t < sizeof tables / sizeof tables[0]; t++) {
        const table *T = &tables[t];
        /* Singletons: the two must agree on every edge value on its own. */
        for (size_t i = 0; i < ne; i++) {
            const int32_t v = edges[i];
            const bool r = reference(&v, 1), g = T->fn(&v, 1);
            if (r != g) { fprintf(stderr, "%s: value %d -> ref %d table %d\n", T->name, v, (int)r, (int)g); return 1; }
        }
        /* n = 0 must not read and must accept. */
        assert(T->fn(NULL, 0) == reference(NULL, 0));

        /* A bad value at EVERY position of buffers whose length straddles the
         * vector width and its tail. */
        for (size_t n = 1; n <= 200; n++) {
            int32_t *buf = malloc(n * sizeof *buf); assert(buf);
            for (size_t i = 0; i < n; i++) buf[i] = (int32_t)(nextr() % (uint64_t)SH_M_MOD) - (int32_t)SH_HALF_M;
            for (size_t i = 0; i < n; i++) if (buf[i] > (int32_t)SH_HALF_M) buf[i] = (int32_t)SH_HALF_M;
            if (reference(buf, n) != T->fn(buf, n)) { fprintf(stderr, "%s: clean buffer n=%zu disagrees\n", T->name, n); return 1; }
            for (size_t pos = 0; pos < n; pos++) {
                for (size_t e = 0; e < ne; e++) {
                    const int32_t save = buf[pos];
                    buf[pos] = edges[e];
                    const bool r = reference(buf, n), g = T->fn(buf, n);
                    if (r != g) {
                        fprintf(stderr, "%s: n=%zu pos=%zu value=%d -> ref %d table %d\n",
                                T->name, n, pos, edges[e], (int)r, (int)g);
                        return 1;
                    }
                    buf[pos] = save;
                }
            }
            free(buf);
        }
        /* A large buffer, one bad value in the final element: an OR reduction
         * that mishandled its tail would accept this. */
        const size_t big = 100003;
        int32_t *b = malloc(big * sizeof *b); assert(b);
        for (size_t i = 0; i < big; i++) b[i] = (int32_t)(nextr() % (uint64_t)SH_M_MOD) - (int32_t)SH_HALF_M;
        assert(reference(b, big) == T->fn(b, big));
        b[big - 1] = INT32_MIN;
        if (T->fn(b, big) || reference(b, big)) { fprintf(stderr, "%s: bad final element accepted\n", T->name); return 1; }
        free(b);
        /* The activation bound, at the same kind of edges. SH_FV_X_LIMIT is the
         * one the hot path uses; HALF_M+1 is the one fv_check uses on y. */
        const uint64_t limits[] = { (uint64_t)SH_FV_X_LIMIT, (uint64_t)SH_HALF_M + 1, 1, 2 };
        for (size_t li = 0; li < sizeof limits / sizeof limits[0]; li++) {
            const uint64_t L = limits[li];
            const int64_t wedges[] = {
                0, 1, -1, (int64_t)L - 1, (int64_t)L, -(int64_t)L + 1, -(int64_t)L, (int64_t)L + 1,
                -(int64_t)L - 1, INT64_MAX, INT64_MIN, INT64_MAX - 1, INT64_MIN + 1,
            };
            const size_t nw = sizeof wedges / sizeof wedges[0];
            for (size_t i = 0; i < nw; i++) {
                const int64_t v = wedges[i];
                if (within_reference(&v, 1, L) != T->within(&v, 1, L)) {
                    fprintf(stderr, "%s: within limit=%llu value=%lld disagrees\n",
                            T->name, (unsigned long long)L, (long long)v); return 1;
                }
            }
            assert(T->within(NULL, 0, L) == within_reference(NULL, 0, L));
            for (size_t n = 1; n <= 80; n++) {
                int64_t *wb = malloc(n * sizeof *wb); assert(wb);
                for (size_t i = 0; i < n; i++) wb[i] = (int64_t)(nextr() % (L ? L : 1));
                for (size_t pos = 0; pos < n; pos++) for (size_t e = 0; e < nw; e++) {
                    const int64_t save = wb[pos]; wb[pos] = wedges[e];
                    if (within_reference(wb, n, L) != T->within(wb, n, L)) {
                        fprintf(stderr, "%s: within limit=%llu n=%zu pos=%zu value=%lld\n",
                                T->name, (unsigned long long)L, n, pos, (long long)wedges[e]); return 1;
                    }
                    wb[pos] = save;
                }
                free(wb);
            }
        }
        fprintf(stderr, "reply-balanced: %s ok (reply + activation bound)\n", T->name);
    }
    return 0;
}
