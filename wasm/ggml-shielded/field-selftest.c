/*
 * field-selftest -- prints this implementation's constants, and recomputes the
 * weight encoding for (fp16 bits, int8 quant) pairs read from stdin.
 *
 * The point is that shielded/field.py generates the vectors and this reproduces
 * them, so the C is policed by the same tripwire that already polices the JS.
 * Driven by test/shielded-tee.test.mjs.
 */
#include "shielded-field.h"
#include <stdio.h>

int main(int argc, char **argv) {
    if (argc > 1 && argv[1][0] == '-') {   /* --constants */
        printf("{\"M_MOD\":%lld,\"HALF_M\":%lld,\"primes\":[%d,%d,%d],"
               "\"QK\":%d,\"FRAC\":%d,\"WEIGHT_BYTE_LIMIT\":%d}\n",
               (long long)SH_M_MOD, (long long)SH_HALF_M,
               sh_primes[0], sh_primes[1], sh_primes[2],
               SH_QK, SH_FRAC, SH_WEIGHT_BYTE_LIMIT);
        return 0;
    }
    unsigned int half; int quant;
    while (scanf("%u %d", &half, &quant) == 2)
        printf("%lld\n", (long long)sh_encode_weight_fixed((uint16_t)half, (int8_t)quant));
    return 0;
}
