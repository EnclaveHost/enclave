#define _GNU_SOURCE
#include "../../wasm/ggml-shielded/shielded-tee.h"
#include "../../wasm/ggml-shielded/shielded-pads.h"
#include "../../wasm/ggml-shielded/shielded-field.h"
#include "../../wasm/ggml-shielded/tweetnacl.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail_threads, attempts;
int __real_pthread_create(pthread_t *, const pthread_attr_t *, void *(*)(void *), void *);
int __wrap_pthread_create(pthread_t *p, const pthread_attr_t *a, void *(*fn)(void *), void *ctx) {
    ++attempts;
    if (fail_threads == 2 || (fail_threads == 1 && attempts % 2 == 0)) return EAGAIN;
    return __real_pthread_create(p, a, fn, ctx);
}
enum { GROUPS = 7, COUNT = 37, INDEX = 5 };
int main(int argc, char **argv) {
    assert(argc == 2);
    const int widths[GROUPS] = {64, 256, 16, 128, 96, 32, 320};
    int8_t *weights[GROUPS], extra[32 * 16];
    uint8_t seed[32], sid[16], digest[32], sk[32], pk[32];
    for (int i = 0; i < 32; i++) { seed[i] = (uint8_t)(i * 7); digest[i] = (uint8_t)(i * 11); sk[i] = (uint8_t)(i * 13); }
    for (int i = 0; i < 16; i++) sid[i] = (uint8_t)i;
    assert(crypto_scalarmult_base(pk, sk) == 0);
    int err = 0; sh_link *link = sh_link_open("127.0.0.1", 1, false, &err); assert(link);
    for (int g = 0; g < GROUPS; g++) {
        const int k = 32 * (g + 1); weights[g] = malloc((size_t)k * widths[g]); assert(weights[g]);
        for (int i = 0; i < k * widths[g]; i++) weights[g][i] = (int8_t)((i * 17 + g * 31) % 239 - 119);
        char name[64]; snprintf(name, sizeof name, "group.%d.weight", g);
        assert(sh_link_add_weight(link, name, weights[g], k, widths[g], 8, -1) == g);
    }
    for (unsigned i = 0; i < sizeof extra; i++) extra[i] = (int8_t)((i * 19) % 239 - 119);
    assert(sh_link_add_weight(link, "group.0.shared.weight", extra, 32, 16, 8, 0) == GROUPS);
    sh_pads_group groups[GROUPS]; assert(sh_link_group_table(link, groups, GROUPS) == GROUPS);
    sh_pads_reader *readers[4]; char dirs[4][1024], paths[4][1100];
    for (int mode = 0; mode < 4; mode++) {
        snprintf(dirs[mode], sizeof dirs[mode], "%s/bank-%d", argv[1], mode); assert(!mkdir(dirs[mode], 0700));
        snprintf(paths[mode], sizeof paths[mode], "%s/fixture.pads", dirs[mode]);
        setenv("SHIELDED_MINT_THREADS", mode ? "3" : "1", 1);
        setenv("SHIELDED_MINT_BALANCE", mode ? "1" : "0", 1);
        fail_threads = mode >= 2 ? mode - 1 : 0; attempts = 0;
        assert(sh_link_mint_shipment(link, seed, sid, digest, INDEX, COUNT, pk, paths[mode]) == SH_OK);
        assert(attempts == (mode ? 3 : 0)); fail_threads = 0;
        readers[mode] = sh_pads_reader_open(dirs[mode], sid, sk, &err);
        assert(readers[mode] && err == SH_OK && sh_pads_reader_bind(readers[mode], groups, GROUPS) == SH_OK);
    }
    int32_t r[32 * GROUPS], actual[320], expected[320];
    for (int g = 0; g < GROUPS; g++) for (uint64_t row = INDEX; row < INDEX + COUNT; row++) {
        const int k = 32 * (g + 1), n = widths[g] + (g == 0 ? 16 : 0);
        sh_pad_r(seed, (uint32_t)g, row, k, r);
        for (int j = 0; j < n; j++) {
            const int8_t *w = j < widths[g] ? weights[g] + j * k : extra + (j - widths[g]) * k;
            int64_t product = 0;
            for (int c = 0; c < k; c++) product += (int64_t)r[c] * w[c];
            expected[j] = sh_balanced(product);
        }
        for (int mode = 0; mode < 4; mode++) {
            assert(sh_pads_reader_cell(readers[mode], (uint32_t)g, row, actual) == SH_OK);
            assert(!memcmp(actual, expected, (size_t)n * sizeof *actual));
        }
    }
    for (int mode = 0; mode < 4; mode++) {
        sh_pads_reader_close(readers[mode]); assert(!unlink(paths[mode]) && !rmdir(dirs[mode]));
    }
    sh_link_close(link);
    for (int g = 0; g < GROUPS; g++) free(weights[g]);
    puts("balanced-files: all cells match scalar oracle with normal, partial and total thread-creation failure");
}
