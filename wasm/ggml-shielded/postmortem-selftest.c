/* sh_fv_postmortem: the log line a failed Freivalds check writes must name the
 * corruption pattern correctly. Synthetic weights and activations; the reply
 * is corrupted in known ways. Pure host code, no card. */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "shielded-field.h"
#include "shielded-tee.h"
#if 0
#endif
enum { K = 256, N = 128, M = 2, STR = 160 };
static int8_t w[N * K]; static int64_t x[M * K], y[M * STR];
static void truth(void) {
    for (int r = 0; r < M; r++) for (int j = 0; j < N; j++) { int64_t s = 0; for (int k = 0; k < K; k++) s += (int64_t)w[j * K + k] * x[r * K + k]; y[r * STR + j] = sh_balanced(s); }
}
static int expect(const char *what, const char *needle) {
    char out[512]; sh_fv_postmortem(w, K, N, x, M, y, STR, out, sizeof out);
    const int ok = strstr(out, needle) != NULL;
    printf("%s %s\n  %s\n", ok ? "PASS" : "FAIL", what, out); return ok;
}
int main(void) {
    uint64_t s = 88172645463325252ull;
    for (int i = 0; i < N * K; i++) { s ^= s << 13; s ^= s >> 7; s ^= s << 17; w[i] = (int8_t)((int)(s % 239) - 119); }
    for (int i = 0; i < M * K; i++) { s ^= s << 13; s ^= s >> 7; s ^= s << 17; x[i] = (int64_t)(s % 2001) - 1000; }
    int ok = 1;
    truth(); ok &= expect("exact reply", "0 of 256 values wrong");
    truth(); y[1 * STR + 37] += 5; ok &= expect("one value", "1 of 256 values wrong in 1 row(s), 1 32-col block run(s), cols 37..37");
    truth(); for (int j = 64; j < 96; j++) y[0 * STR + j] ^= 0x100; ok &= expect("one 32-col block", "32 of 256 values wrong in 1 row(s), 1 32-col block run(s), cols 64..95");
    truth(); for (int r = 0; r < M; r++) for (int j = 0; j < N; j++) y[r * STR + j] = sh_balanced(y[r * STR + j] + 12345 + j); ok &= expect("pad-like offset everywhere", "256 of 256 values wrong in 2 row(s)");
    truth(); for (int j = 0; j < N; j++) y[0 * STR + j] = y[0 * STR + j]; y[0 * STR + 150] = 999; ok &= expect("stride padding is ignored", "0 of 256 values wrong");
    ok &= (sh_fv_postmortem(NULL, K, N, x, M, y, STR, (char[64]){0}, 64), 1);
    { char o[64]; sh_fv_postmortem(NULL, K, N, x, M, y, STR, o, sizeof o); printf("%s null weights: %s\n", strstr(o, "no local weights") ? "PASS" : "FAIL", o); ok &= strstr(o, "no local weights") != NULL; }
    printf(ok ? "ALL PASS\n" : "SOME FAILED\n"); return ok ? 0 : 1;
}
