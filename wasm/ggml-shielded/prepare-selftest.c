/* Reads "K N" then K/32*N raw fp16 scale bits then K*N int8 quants from stdin;
 * prints the chosen f_w and the encoded weights. Compared against tee.PublicWeight. */
#include "shielded-field.h"
#include <stdio.h>
#include <stdlib.h>
int main(void) {
    long long K, N;
    if (scanf("%lld %lld", &K, &N) != 2) return 2;
    const long long nb = K / SH_QK;
    uint16_t *wd = malloc((size_t)nb * N * 2), *sc = malloc((size_t)nb * N * 2);
    int8_t *wq = malloc((size_t)K * N);
    if (!wd || !sc || !wq) return 2;
    for (long long i = 0; i < nb * N; i++) { unsigned u; if (scanf("%u", &u) != 1) return 2; wd[i] = (uint16_t)u; }
    for (long long i = 0; i < K * N; i++) { int v; if (scanf("%d", &v) != 1) return 2; wq[i] = (int8_t)v; }
    int *fw = malloc((size_t)N * sizeof(int));
    if (!fw) return 2;
    int rc = sh_prepare_weight(wd, wq, K, N, sc, fw);
    if (rc < 0) { printf("-1\n"); return 0; }
    /* Exponents only: N of them, one per output column. The caller re-derives the
     * encoded weights from field.py's own routine and checks the byte lane there,
     * so printing them here would only let the two drift while agreeing. */
    for (long long j = 0; j < N; j++) printf("%d\n", fw[j]);
    return 0;
}
