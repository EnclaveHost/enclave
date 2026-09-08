#include "../../shielded/anchor/core/anchor-core.h"
#include "shielded-field.h"
#include "shielded-simd.h"
#include <string.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

static int alloc_fail_after = -1, rng_fail_after = -1, count_secret;
static size_t allocation_calls, secret_count;
static struct { void *p; size_t n; } secret_allocs[128];
void *__real_malloc(size_t);
void __real_free(void *);
void *__wrap_malloc(size_t n) {
    allocation_calls++;
    if (alloc_fail_after == 0) { alloc_fail_after = -1; return NULL; }
    if (alloc_fail_after > 0) alloc_fail_after--;
    void *p = __real_malloc(n);
    if (p && count_secret) {
        assert(secret_count < sizeof secret_allocs / sizeof secret_allocs[0]);
        secret_allocs[secret_count].p = p; secret_allocs[secret_count++].n = n;
        // Also require cleanup to clear uninitialized allocation tails.
        memset(p, 0xa5, n);
    }
    return p;
}
void __wrap_free(void *p) {
    for (size_t i = 0; i < secret_count; i++) if (secret_allocs[i].p == p) {
        const unsigned char *bytes = p;
        for (size_t j = 0; j < secret_allocs[i].n; j++) assert(bytes[j] == 0);
        secret_allocs[i] = secret_allocs[--secret_count];
        break;
    }
    __real_free(p);
}

enum { K = 64, N0 = 17, N1 = 5, TOTAL = N0 + N1 };
static int rng(void *buf, size_t n) {
    static uint32_t state = 1;
    unsigned char *p = buf;
    for (size_t i = 0; i < n; i++) { state = state * 1664525u + 1013904223u; p[i] = state >> 24; }
    if (rng_fail_after == 0) { rng_fail_after = -1; return -1; }
    if (rng_fail_after > 0) rng_fail_after--;
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
static an_ctx *registered(void) {
    an_ctx *c = an_create(rng); assert(c);
    assert(an_peak_abs_y(c) == 0 && an_y_digest(c, 0) == 0);
    for (int j = 0; j < TOTAL; j++) for (int k = 0; k < K; k++) weights[j * K + k] = (j + k * 3) % 13 - 6;
    assert(an_add_weight(c, weights, K, N0) == 0);
    assert(an_add_weight(c, weights + N0 * K, K, N1) == 1);
    assert(an_peak_abs_y(c) == 0 && an_y_digest(c, 0) == 0);
    return c;
}
static an_ctx *make(void) {
    an_ctx *c = registered();
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
static void setup_failures(void) {
    an_ctx *c = registered();
    allocation_calls = 0; count_secret = 1;
    assert(an_prepare(c) == AN_OK);
    const size_t prepare_allocs = allocation_calls;
    assert(prepare_allocs > 10);
    count_secret = 0; an_destroy(c); assert(secret_count == 0);
    for (size_t fail = 0; fail < prepare_allocs; fail++) {
        c = registered(); alloc_fail_after = (int)fail; count_secret = 1;
        assert(an_prepare(c) == AN_ERR_NOMEM);
        assert(secret_count == 0 && an_pad_gen(c) == AN_ERR_PARAM && !an_pad_ready(c));
        assert(an_y_digest(c, 0) == 0 && an_check_local(c) == AN_ERR_PARAM);
        assert(an_prepare(c) == AN_OK);
        assert(an_pad_gen(c) == AN_OK);
        count_secret = 0; an_destroy(c); assert(secret_count == 0);
    }
    for (int fail = 0; fail < 2; fail++) {
        c = registered(); rng_fail_after = fail; count_secret = 1;
        assert(an_prepare(c) == AN_ERR_RNG);
        assert(secret_count == 0 && an_pad_gen(c) == AN_ERR_PARAM);
        assert(an_prepare(c) == AN_OK);
        count_secret = 0; an_destroy(c); assert(secret_count == 0);
    }
    rng_fail_after = 0; assert(an_create(rng) == NULL);
}
static void geometry(void) {
    const int8_t small[4] = {1};
    const int64_t extremes[] = {INT64_MIN, -1, 0, INT64_MAX};
    an_ctx *c = an_create(rng); assert(c);
    for (size_t i = 0; i < sizeof extremes / sizeof extremes[0]; i++) {
        const int64_t k = extremes[i], n = 1;
        assert(an_add_weight(c, small, k, n) == AN_ERR_PARAM);
        assert(an_add_weight(c, small, n, k) == AN_ERR_PARAM);
        assert(an_footprint(1, &k, &n) == 0 && an_footprint(1, &n, &k) == 0);
    }
    assert(an_footprint(-1, NULL, NULL) == 0);
    assert(an_footprint(AN_MAX_NODES + 1, NULL, NULL) == 0);
    assert(an_footprint(1, NULL, NULL) == 0);
    const int64_t ks[2] = {32, 64}, ns[2] = {1, 1};
    assert(an_footprint(2, ks, ns) == 0);
    // A wide, sparse row is safe; geometry alone must not impose a small K
    // limit that would reject ordinary large-model FFN dimensions.
    enum { WIDE = 32768 };
    int8_t *wide = calloc(WIDE, 1); assert(wide);
    wide[WIDE - 1] = 1;
    assert(an_add_weight(c, wide, WIDE, 1) == 0);
    an_destroy(c); c = an_create(rng); assert(c);
    memset(wide, SH_WEIGHT_BYTE_LIMIT, WIDE);
    assert(an_add_weight(c, wide, WIDE, 1) == AN_ERR_PARAM);
    memset(wide, -SH_WEIGHT_BYTE_LIMIT, WIDE);
    assert(an_add_weight(c, wide, WIDE, 1) == AN_ERR_PARAM);
    wide[0] = INT8_MIN;
    assert(an_add_weight(c, wide, WIDE, 1) == AN_ERR_PARAM);
    // Invalid registration must leave the group usable.
    assert(an_add_weight(c, small, 4, 1) == 0);
    assert(an_prepare(c) == AN_OK);
    an_destroy(c); free(wide);
}
int main(void) {
    for (int width = 3; width <= 4; width++) for (int align = 0; align < 4; align++) valid(width, align);
    failures();
    setup_failures(); geometry();
    puts("anchor lifecycle, numeric/geometry bounds, allocation/RNG failures and secret cleanup: ok");
}
