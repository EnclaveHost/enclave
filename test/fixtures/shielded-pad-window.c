#include "shielded-pad-grant.h"
#include <assert.h>
#include <stdlib.h>

void randombytes(unsigned char *p, unsigned long long n) { (void)p; (void)n; abort(); }
static void unhex(const char *s, uint8_t *out, size_t n) {
    assert(strlen(s) == 2*n);
    for (size_t i = 0; i < n; i++) { unsigned v; assert(sscanf(s+2*i, "%2x", &v) == 1); out[i] = (uint8_t)v; }
}
int main(int argc, char **argv) {
    assert(argc == 8);
    uint8_t pk[32], sig[64]; unhex(argv[1], pk, 32); unhex(argv[7], sig, 64);
    const uint64_t lo = strtoull(argv[3], NULL, 10), hi = strtoull(argv[4], NULL, 10), iat = strtoull(argv[5], NULL, 10);
    if (!sh_pad_window_v2_verify(pk, argv[2], lo, hi, iat, argv[6], sig)) { puts("rejected"); return 1; }
    assert(!sh_pad_window_v2_verify(NULL, argv[2], lo, hi, iat, argv[6], sig));
    assert(!sh_pad_window_v2_verify(pk, NULL, lo, hi, iat, argv[6], sig));
    assert(!sh_pad_window_v2_verify(pk, argv[2], lo, hi, iat, NULL, sig));
    assert(!sh_pad_window_v2_verify(pk, argv[2], lo, hi, iat, argv[6], NULL));
    puts("ok"); return 0;
}
