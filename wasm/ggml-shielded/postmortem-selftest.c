/* sh_fv_postmortem: the log line a failed Freivalds check writes.
 *
 * Two properties, on synthetic data with the reply corrupted in known ways:
 *
 * 1. It names the corruption pattern (value, block, every column, none).
 * 2. It says NOTHING about the activations. The log is host-visible and a
 *    worker can trigger this path at will, so for the same worker error d the
 *    default line must be byte-identical across different activations --
 *    including activations large enough that the true product leaves the
 *    field. No product or activation value may appear in it at all.
 *
 * Pure host code, no card. */
#include "shielded-tee.h"
#include "shielded-field.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { K = 256, N = 128, M = 2, STR = 160 };
static int8_t w[N * K];
static int64_t x[M * K], y[M * STR];
static uint64_t rng = 88172645463325252ull;
static uint64_t next(void) { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return rng; }

static void activations(int64_t span) {
    for (int i = 0; i < M * K; i++) x[i] = (int64_t)(next() % (uint64_t)(2 * span + 1)) - span;
}
/* y = balanced(W.x + d), the unmasked form of a reply carrying error d */
typedef int64_t (*err_fn)(int r, int j);
static void reply(err_fn d) {
    for (int r = 0; r < M; r++)
        for (int j = 0; j < N; j++) {
            int64_t s = 0;
            for (int k = 0; k < K; k++) s += (int64_t)w[j * K + k] * x[r * K + k];
            y[r * STR + j] = sh_balanced(s + (d ? d(r, j) : 0));
        }
    for (int r = 0; r < M; r++) for (int j = N; j < STR; j++) y[r * STR + j] = 777777;   /* stride padding */
}
static int64_t d_none(int r, int j) { (void)r; (void)j; return 0; }
static int64_t d_one(int r, int j) { return (r == 1 && j == 37) ? 5 : 0; }
static int64_t d_block(int r, int j) { return (r == 0 && j >= 64 && j < 96) ? 256 : 0; }
static int64_t d_all(int r, int j) { (void)r; return 12345 + j; }

static void line(int plain, char *out, size_t cap) { sh_fv_postmortem(w, K, N, x, M, y, STR, plain, out, cap); }

/* no digit run that could be a product or activation value: every number the
 * line may carry is a count or an index bounded by m*N */
static int has_value(const char *s) {
    for (const char *p = s; *p; p++) {
        if (*p == '-' && p[1] >= '0' && p[1] <= '9' && (p == s || p[-1] == ' ' || p[-1] == '=')) {
            /* a negative number is never a count or an index ("cols -1..-1" is the no-difference form) */
            if (strncmp(p, "-1..-1", 6) && strncmp(p, "-1", 2)) return 1;
        }
        if (*p >= '0' && *p <= '9') {
            long v = strtol(p, NULL, 10);
            if (v > (long)M * N) return 1;
            while (*p >= '0' && *p <= '9') p++;
            if (!*p) break;
        }
    }
    return strstr(s, "got=") || strstr(s, "want=");
}

int main(void) {
    for (int i = 0; i < N * K; i++) w[i] = (int8_t)((int)(next() % 239) - 119);
    int ok = 1;
    struct { const char *what; err_fn d; const char *expect; } cases[] = {
        {"exact reply", d_none, "0 of 256 values differ, in 0 row(s), 0 32-col block run(s), cols -1..-1 (the reply matches"},
        {"one value", d_one, "1 of 256 values differ, in 1 row(s), 1 32-col block run(s), cols 37..37"},
        {"one 32-col block", d_block, "32 of 256 values differ, in 1 row(s), 1 32-col block run(s), cols 64..95"},
        {"every column (pad-like)", d_all, "256 of 256 values differ, in 2 row(s), 8 32-col block run(s), cols 0..127"},
    };
    for (size_t c = 0; c < sizeof cases / sizeof cases[0]; c++) {
        /* the same error under three activation sets: small, large, and large
         * enough that most true products wrap the field */
        char out[3][512];
        const int64_t spans[3] = {1000, 400000, 60000000};
        for (int a = 0; a < 3; a++) { activations(spans[a]); reply(cases[c].d); line(0, out[a], sizeof out[a]); }
        const int right = strstr(out[0], cases[c].expect) != NULL;
        const int same = !strcmp(out[0], out[1]) && !strcmp(out[0], out[2]);
        const int clean = !has_value(out[0]) && !has_value(out[1]) && !has_value(out[2]);
        printf("%s %s: pattern=%s activation-independent=%s value-free=%s\n  %s\n",
               right && same && clean ? "PASS" : "FAIL", cases[c].what, right ? "ok" : "WRONG",
               same ? "yes" : "NO", clean ? "yes" : "NO", out[0]);
        if (!same) printf("  differs: %s\n  vs      %s\n", out[1], out[2]);
        ok &= right && same && clean;
    }
    {   /* the development opt-in adds the one x-dependent count, and only it */
        char o[512];
        activations(60000000); reply(d_none); line(1, o, sizeof o);
        const int has = strstr(o, "[plaintext opt-in:") != NULL;
        activations(1000); reply(d_none); char o2[512]; line(0, o2, sizeof o2);
        const int absent = strstr(o2, "opt-in") == NULL;
        printf("%s plaintext opt-in marked and off by default\n  %s\n", has && absent ? "PASS" : "FAIL", o);
        ok &= has && absent;
    }
    {   char o[64];
        sh_fv_postmortem(NULL, K, N, x, M, y, STR, 0, o, sizeof o);
        const int r = strstr(o, "no local weights") != NULL;
        printf("%s null weights: %s\n", r ? "PASS" : "FAIL", o); ok &= r;
    }
    printf(ok ? "ALL PASS\n" : "SOME FAILED\n");
    return ok ? 0 : 1;
}
