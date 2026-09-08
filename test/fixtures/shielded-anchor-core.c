#include "../../shielded/anchor/core/anchor-core.h"
#include "shielded-field.h"
#include "shielded-simd.h"
#include <string.h>
#include <assert.h>
#include <stdio.h>

enum { K = 64, N0 = 17, N1 = 5, TOTAL = N0 + N1 };
static int rng(void *buf, size_t n) {
    static uint32_t state = 1;
    unsigned char *p = buf;
    for (size_t i = 0; i < n; i++) { state = state * 1664525u + 1013904223u; p[i] = state >> 24; }
    return 0;
}
static uint64_t pads(an_ctx *c) { uint64_t v; an_stats(c, &v, NULL, NULL); return v; }
static uint64_t exchanges(an_ctx *c) { uint64_t v; an_stats(c, NULL, &v, NULL); return v; }
static uint64_t verify_fail(an_ctx *c) { uint64_t v; an_stats(c, NULL, NULL, &v); return v; }
static int8_t weights[TOTAL * K];
static uint8_t *mutate_before_unmask;
void __real_sh_simd_generic_unmask_fv(const int32_t *, const int32_t *, const int32_t *,
                                    int, int64_t, int64_t *, int64_t *);
void __wrap_sh_simd_generic_unmask_fv(const int32_t *ym, const int32_t *u, const int32_t *s,
                                    int reps, int64_t n, int64_t *y, int64_t *out) {
    if (mutate_before_unmask) {
        // Model the normal world modifying shared reply memory AFTER the
        // range check. The trusted kernel must consume the checked snapshot.
        const int32_t hostile = INT32_MAX;
        memcpy(mutate_before_unmask, &hostile, sizeof hostile);
        mutate_before_unmask = NULL;
    }
    __real_sh_simd_generic_unmask_fv(ym, u, s, reps, n, y, out);
}
static an_ctx *make(void) {
    an_ctx *c = an_create(rng); assert(c);
    assert(an_peak_abs_y(c) == 0 && an_y_digest(c, 0) == 0);
    for (int j = 0; j < TOTAL; j++) for (int k = 0; k < K; k++) weights[j * K + k] = (j + k * 3) % 13 - 6;
    assert(an_add_weight(c, weights, K, N0) == 0);
    assert(an_add_weight(c, weights + N0 * K, K, N1) == 1);
    assert(an_peak_abs_y(c) == 0 && an_y_digest(c, 0) == 0);
    assert(an_prepare(c) == AN_OK);
    assert(an_peak_abs_y(c) == 0 && an_y_digest(c, 0) == 0);
    assert(an_check_local(c) == AN_ERR_PARAM);
    return c;
}
static void honest_reply(const int8_t *planes, int width, uint8_t *out) {
    // Independent public-weight worker oracle: only ciphertext is used.
    for (int j = 0; j < TOTAL; j++) {
        int32_t r[3] = {0};
        for (int p = 0; p < 3; p++) for (int k = 0; k < K; k++)
            r[p] += (int32_t)planes[p * K + k] * weights[j * K + k];
        uint32_t value = (uint32_t)(int32_t)sh_crt(r[0], r[1], r[2]);
        for (int b = 0; b < width; b++) out[j * width + b] = (uint8_t)(value >> (8 * b));
    }
}
static void begin(an_ctx *c, int64_t *x, int8_t *planes) {
    assert(an_pad_gen(c) == AN_OK);
    assert(an_mask(c, x, planes) == AN_OK);
    assert(an_check_local(c) == AN_ERR_PARAM);
    assert(an_peak_abs_y(c) == 0 && an_y_digest(c, 0) == 0);
    uint64_t before = pads(c);
    assert(an_pad_gen(c) == AN_ERR_PARAM);
    assert(an_mask(c, x, planes) == AN_ERR_PARAM);
    assert(pads(c) == before);
}
static void valid(int width, int alignment) {
    an_ctx *c = make();
    int64_t x[K]; int8_t planes[K * 3]; uint8_t storage[TOTAL * 4 + 4];
    uint8_t *reply = storage + alignment;
    for (int pass = 0; pass < 3; pass++) {
        for (int k = 0; k < K; k++) x[k] = (k * 7 + pass) % 31 - 15;
        begin(c, x, planes);
        honest_reply(planes, width, reply);
        if (width == 4 && pass == 1) mutate_before_unmask = reply;
        assert(an_finish(c, reply, TOTAL * width, width) == AN_OK);
        assert(an_check_local(c) == AN_OK);
        const uint64_t digest = an_y_digest(c, 0);
        assert(digest != 0 && an_peak_abs_y(c) > 0);
        uint64_t before = exchanges(c);
        assert(an_finish(c, reply, TOTAL * width, width) == AN_ERR_PARAM);
        assert(exchanges(c) == before && an_y_digest(c, 0) == digest);
    }
    assert(pads(c) == 3 && exchanges(c) == 3 && verify_fail(c) == 0);
    an_destroy(c);
}
static void failures(void) {
    an_ctx *c = make(); int64_t x[K] = {0}; int8_t planes[K * 3]; uint8_t reply[TOTAL * 4 + 1];
    const int64_t extremes[] = {INT64_MIN, -SH_FV_X_LIMIT, SH_FV_X_LIMIT, INT64_MAX};
    assert(an_pad_gen(c) == AN_OK);
    for (size_t i = 0; i < sizeof extremes / sizeof extremes[0]; i++) {
        x[K - 1] = extremes[i]; memset(planes, 0x5a, sizeof planes);
        assert(an_mask(c, x, planes) == AN_ERR_VERIFY && an_pad_ready(c));
        for (size_t j = 0; j < sizeof planes; j++) assert((uint8_t)planes[j] == 0x5a);
    }
    x[K - 1] = 0;
    assert(an_mask(c, x, planes) == AN_OK);
    honest_reply(planes, 4, reply);
    assert(an_finish(c, reply, TOTAL * 4 - 1, 4) == AN_ERR_PARAM);
    assert(an_finish(c, reply, TOTAL * 4, 4) == AN_ERR_PARAM);
    assert(an_check_local(c) == AN_ERR_PARAM && an_y_digest(c, 0) == 0);
    const int32_t bad[] = {INT32_MIN, -(int32_t)SH_HALF_M - 1, (int32_t)SH_HALF_M + 1, INT32_MAX};
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        begin(c, x, planes); honest_reply(planes, 4, reply + 1);
        memcpy(reply + 1 + (TOTAL - 1) * 4, bad + i, 4);
        assert(an_finish(c, reply + 1, TOTAL * 4, 4) == AN_ERR_VERIFY);
        assert(an_finish(c, reply + 1, TOTAL * 4, 4) == AN_ERR_PARAM);
        assert(an_y_digest(c, 0) == 0 && an_peak_abs_y(c) == 0 && an_check_local(c) == AN_ERR_PARAM);
    }
    for (int width = 3; width <= 4; width++) {
        begin(c, x, planes); honest_reply(planes, width, reply);
        reply[(TOTAL - 1) * width] ^= 1;
        assert(an_finish(c, reply, TOTAL * width, width) == AN_ERR_VERIFY);
        assert(an_y_digest(c, 0) == 0 && an_peak_abs_y(c) == 0 && an_check_local(c) == AN_ERR_PARAM);
    }
    for (int kind = 0; kind < 3; kind++) {
        begin(c, x, planes); honest_reply(planes, 4, reply);
        assert(an_finish(c, kind == 0 ? NULL : reply, kind == 1 ? TOTAL * 4 + 1 : TOTAL * 4, kind == 2 ? 2 : 4) == AN_ERR_PARAM);
        assert(an_finish(c, reply, TOTAL * 4, 4) == AN_ERR_PARAM);
        assert(an_y_digest(c, 0) == 0);
    }
    assert(pads(c) == 10 && exchanges(c) == 0 && verify_fail(c) == 6);
    // Failures consume their attempt but do not poison a new exchange.
    begin(c, x, planes); honest_reply(planes, 4, reply);
    assert(an_finish(c, reply, TOTAL * 4, 4) == AN_OK && an_check_local(c) == AN_OK);
    assert(exchanges(c) == 1);
    an_destroy(c);
}
int main(void) {
    for (int width = 3; width <= 4; width++) for (int align = 0; align < 4; align++) valid(width, align);
    failures();
    puts("anchor one-response state, input/reply bounds and unaligned replies: ok");
}
