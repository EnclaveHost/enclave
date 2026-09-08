#include "../../wasm/ggml-shielded/shielded-pads.h"
#include "../../wasm/ggml-shielded/shielded-wire.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* Fixture-only private keys, never a production invocation. Compare every
 * opened field element, not ciphertext or a non-cryptographic fingerprint. */
int main(int argc, char **argv) {
    assert(argc == 5);
    uint8_t sk[32], sid[16];
    assert(sh_pads_hex2bin(argv[1], sk, 32) && sh_pads_hex2bin(argv[2], sid, 16));
    int err = 0;
    sh_pads_reader *a = sh_pads_reader_open(argv[3], sid, sk, &err); assert(a && err == SH_OK);
    sh_pads_reader *b = sh_pads_reader_open(argv[4], sid, sk, &err); assert(b && err == SH_OK);
    sh_pads_group groups[1024] = {0};
    const uint32_t n = sh_pads_reader_groups(a, groups, 1024); assert(n && n <= 1024);
    assert(sh_pads_reader_bind(a, groups, n) == SH_OK && sh_pads_reader_bind(b, groups, n) == SH_OK);
    for (uint32_t g = 0; g < n; g++) {
        assert(groups[g].u_len && groups[g].u_len <= SIZE_MAX / sizeof(int32_t));
        const size_t bytes = (size_t)groups[g].u_len * sizeof(int32_t);
        int32_t *x = malloc(bytes), *y = malloc(bytes); assert(x && y);
        for (uint64_t i = 0; i < 2; i++) {
            assert(sh_pads_reader_cell(a, g, i, x) == SH_OK && sh_pads_reader_cell(b, g, i, y) == SH_OK);
            assert(!memcmp(x, y, bytes));
        }
        free(x); free(y);
    }
    sh_pads_reader_close(a); sh_pads_reader_close(b);
    printf("%u opened cells exactly equal\n", n * 2);
}
