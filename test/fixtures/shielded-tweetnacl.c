#include "tweetnacl.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void randombytes(unsigned char *p, unsigned long long n) { (void)p; (void)n; abort(); }
static size_t unhex(const char *s, uint8_t *out, size_t cap) {
    size_t n = strlen(s); assert(n % 2 == 0 && n/2 <= cap); n /= 2;
    for (size_t i = 0; i < n; i++) { unsigned v; assert(sscanf(s+2*i, "%2x", &v) == 1); out[i] = (uint8_t)v; }
    return n;
}
static void hex(const uint8_t *p, size_t n) { for (size_t i = 0; i < n; i++) printf("%02x", p[i]); puts(""); }
int main(int argc, char **argv) {
    assert(argc == 4 || argc == 5);
    if (!strcmp(argv[1], "sign")) {
        uint8_t sk[64], msg[4096], sm[4160], opened[4160]; unsigned long long sn = 0, on = 0;
        assert(unhex(argv[2], sk, 64) == 64);
        size_t n = unhex(argv[3], msg, sizeof msg);
        assert(crypto_sign(sm, &sn, msg, n, sk) == 0 && sn == n+64);
        assert(crypto_sign_open(opened, &on, sm, sn, sk+32) == 0 && on == n);
        assert(!memcmp(msg, opened, n)); hex(sm, 64);
        sm[0] ^= 1;
        assert(crypto_sign_open(opened, &on, sm, sn, sk+32) != 0);
    } else if (!strcmp(argv[1], "verify")) {
        uint8_t pk[32], msg[4096], sm[4160], opened[4160]; unsigned long long on = 0;
        assert(argc == 5 && unhex(argv[2], pk, 32) == 32);
        size_t n = unhex(argv[3], msg, sizeof msg);
        assert(unhex(argv[4], sm, 64) == 64); memcpy(sm+64, msg, n);
        assert(crypto_sign_open(opened, &on, sm, n+64, pk) == 0 && on == n);
        assert(!memcmp(msg, opened, n)); puts("ok");
    } else {
        assert(!strcmp(argv[1], "dh"));
        uint8_t sk[32], pk[32], shared[32];
        assert(unhex(argv[2], sk, 32) == 32 && unhex(argv[3], pk, 32) == 32);
        assert(crypto_scalarmult(shared, sk, pk) == 0); hex(shared, 32);
    }
    return 0;
}
