/* pack24-bench -- what the packed pad ring costs per row, on public synthetic
 * data. NOT a production measurement: no worker, no model, one thread.
 *
 * For each shape (m rows taken per exchange, K, u_len) over a ring of `depth`
 * slots walked round-robin (so rows come in cold, as ring slots do):
 *   copy32   memcpy of the int32 rows (a reference pass over the same values;
 *            the int32 ring itself does no copy on either side)
 *   pack     sh_p24_pack_r + sh_p24_pack_u of m staged rows into ring slots
 *            (what a packed refill adds before publication)
 *   unpack   sh_p24_unpack_r + sh_p24_unpack_u of m slots into scratch
 *   cycle    unpack + poison (the packed request path) then pack again (the
 *            refill): the whole per-pad overhead over the int32 ring
 * Each prints ns per value and GB/s of int32-equivalent bytes, best and
 * median of `trials`. A checksum over every output is printed so no pass can
 * be optimised away, and every shape is round-trip checked before timing.
 *
 *   cc -std=c11 -O3 -march=native -I. pack24-bench.c -o pack24-bench
 *   ./pack24-bench [depth=32] [trials=7] [K u_len m ...]   (no shape args: the built-in list) */
#define _POSIX_C_SOURCE 200809L
#include "shielded-pack24.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static uint64_t rs = 0x9e3779b97f4a7c15ull;
static uint64_t rnd(void) { rs ^= rs << 13; rs ^= rs >> 7; rs ^= rs << 17; return rs; }
static double now_ns(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e9 + t.tv_nsec; }
static int cmp_d(const void *a, const void *b) { const double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : x > y; }

static uint64_t checksum;   /* printed; every timed pass folds its output in */
static uint64_t fold(const void *p, size_t bytes) {
    const uint8_t *b = (const uint8_t *)p;
    uint64_t h = 0;
    for (size_t i = 0; i < bytes; i += 61) h = h * 1099511628211ull + b[i];   /* sparse: cheap, but data-dependent */
    if (bytes) h = h * 1099511628211ull + b[bytes - 1];
    return h;
}

typedef struct { int64_t K, U; int m; } shape;

static void *xmalloc(size_t n) { void *p = malloc(n ? n : 1); if (!p) { fprintf(stderr, "out of memory (%zu bytes)\n", n); exit(2); } return p; }

static void report(const char *what, const shape *s, double *ns, int trials, size_t values) {
    qsort(ns, (size_t)trials, sizeof *ns, cmp_d);
    const double best = ns[0], med = ns[trials / 2];
    printf("  %-7s best %8.3f ns/value %7.2f GB/s   median %8.3f ns/value %7.2f GB/s\n", what,
           best / (double)values, (double)values * 4.0 / best, med / (double)values, (double)values * 4.0 / med);
    (void)s;
}

static int run(const shape *s, int depth, int trials) {
    const size_t K = (size_t)s->K, U = (size_t)s->U, m = (size_t)s->m;
    if (m > (size_t)depth) { fprintf(stderr, "m %zu > depth %d\n", m, depth); return 1; }
    size_t r32, u32, r24, u24;
    if (!sh_p24_mul3((size_t)depth, K, 4, &r32) || !sh_p24_mul3((size_t)depth, U, 4, &u32) ||
        !sh_p24_mul3((size_t)depth, K, 3, &r24) || !sh_p24_mul3((size_t)depth, U, 3, &u24)) { fprintf(stderr, "shape overflows\n"); return 1; }
    int32_t *ring_r = xmalloc(r32), *ring_u = xmalloc(u32);          /* the int32 ring */
    uint8_t *p_r = xmalloc(r24), *p_u = xmalloc(u24);                /* the packed ring */
    int32_t *sr = xmalloc(m * K * 4), *su = xmalloc(m * U * 4);      /* staging / scratch */
    for (size_t i = 0; i < (size_t)depth * K; i++) ring_r[i] = (int32_t)(rnd() % (uint64_t)SH_M_MOD);
    for (size_t i = 0; i < (size_t)depth * U; i++) ring_u[i] = (int32_t)(rnd() % (uint64_t)(2 * SH_HALF_M + 1)) - (int32_t)SH_HALF_M;
    /* Round trip once over the whole ring before anything is timed. */
    for (int d = 0; d < depth; d++) {
        if (!sh_p24_pack_r(ring_r + (size_t)d * K, K, p_r + (size_t)d * K * 3) ||
            !sh_p24_pack_u(ring_u + (size_t)d * U, U, p_u + (size_t)d * U * 3)) { fprintf(stderr, "pack refused synthetic data\n"); return 1; }
    }
    for (int d = 0; d < depth; d += (int)m) {
        const size_t n = (size_t)d + m <= (size_t)depth ? m : (size_t)depth - (size_t)d;
        for (size_t i = 0; i < n; i++) {
            if (!sh_p24_unpack_r(p_r + (size_t)(d + i) * K * 3, K, sr + i * K) ||
                !sh_p24_unpack_u(p_u + (size_t)(d + i) * U * 3, U, su + i * U) ||
                memcmp(sr + i * K, ring_r + (size_t)(d + i) * K, K * 4) ||
                memcmp(su + i * U, ring_u + (size_t)(d + i) * U, U * 4)) { fprintf(stderr, "round trip FAILED\n"); return 1; }
        }
    }
    /* Enough exchanges per trial to walk the ring several times and run ~50 ms. */
    const size_t values = m * (K + U);
    int reps = (int)(5e7 / ((double)values + 1.0));
    if (reps < 2 * depth) reps = 2 * depth;
    if (reps > 100000) reps = 100000;
    double *ns = xmalloc((size_t)trials * sizeof *ns);

    printf("shape m=%d K=%lld u_len=%lld depth=%d: ring int32 %.2f MiB, packed %.2f MiB; scratch %.2f MiB; %d exchanges/trial\n",
           s->m, (long long)s->K, (long long)s->U, depth, (double)(r32 + u32) / 1048576.0, (double)(r24 + u24) / 1048576.0,
           (double)(m * (K + U) * 4) / 1048576.0, reps);

    for (int pass = 0; pass < 4; pass++) {
        static const char *names[] = { "copy32", "pack", "unpack", "cycle" };
        for (int t = 0; t < trials; t++) {
            int slot = 0; bool ok = true;
            const double t0 = now_ns();
            for (int e = 0; e < reps; e++) {
                for (size_t i = 0; i < m; i++) {
                    const size_t sl = (size_t)slot;
                    slot = slot + 1 == depth ? 0 : slot + 1;
                    switch (pass) {
                    case 0:
                        memcpy(sr + i * K, ring_r + sl * K, K * 4);
                        memcpy(su + i * U, ring_u + sl * U, U * 4);
                        break;
                    case 1:
                        /* staged rows (sr/su hold valid values from the check above) */
                        ok &= sh_p24_pack_r(sr + i * K, K, p_r + sl * K * 3);
                        ok &= sh_p24_pack_u(su + i * U, U, p_u + sl * U * 3);
                        break;
                    case 2:
                        ok &= sh_p24_unpack_r(p_r + sl * K * 3, K, sr + i * K);
                        ok &= sh_p24_unpack_u(p_u + sl * U * 3, U, su + i * U);
                        break;
                    case 3:
                        /* One pad's whole life in the packed ring: the request
                         * unpacks and poisons, a refill packs the slot again.
                         * The int32 ring does none of this (it generates in
                         * place and is read in place), so this is the overhead. */
                        ok &= sh_p24_unpack_r(p_r + sl * K * 3, K, sr + i * K);
                        ok &= sh_p24_unpack_u(p_u + sl * U * 3, U, su + i * U);
                        sh_p24_poison_r(p_r + sl * K * 3, K);
                        sh_p24_poison_u(p_u + sl * U * 3, U);
                        checksum += p_r[sl * K * 3 + K * 3 - 1] + p_u[sl * U * 3 + U * 3 - 1];   /* the poison is observed */
                        ok &= sh_p24_pack_r(sr + i * K, K, p_r + sl * K * 3);
                        ok &= sh_p24_pack_u(su + i * U, U, p_u + sl * U * 3);
                        break;
                    }
                }
                checksum ^= fold(sr, m * K * 4) + fold(su, m * U * 4);
            }
            ns[t] = (now_ns() - t0) / (double)reps;
            if (!ok) { fprintf(stderr, "%s refused a value during timing\n", names[pass]); return 1; }
        }
        checksum ^= fold(p_r, r24) ^ fold(p_u, u24);
        report(names[pass], s, ns, trials, values);
    }
    free(ring_r); free(ring_u); free(p_r); free(p_u); free(sr); free(su); free(ns);
    return 0;
}

int main(int argc, char **argv) {
    const int depth = argc > 1 ? atoi(argv[1]) : 32;
    const int trials = argc > 2 ? atoi(argv[2]) : 7;
    if (depth < 1 || depth > 4096 || trials < 1 || trials > 1000) { fprintf(stderr, "usage: %s [depth] [trials] [K u_len m ...]\n", argv[0]); return 2; }
    /* Synthetic shapes: small/mid/wide K and u_len, decode (m=1), batched and prefill-wide. */
    static const shape builtin[] = {
        { 1024, 1024, 1 }, { 2048, 6144, 1 }, { 5120, 27648, 1 }, { 17408, 5120, 1 }, { 5120, 248320, 1 },
        { 5120, 27648, 4 }, { 5120, 248320, 4 }, { 5120, 27648, 16 }, { 2048, 6144, 32 },
    };
    shape custom[64]; size_t nc = 0;
    for (int i = 3; i + 2 < argc && nc < 64; i += 3) {
        custom[nc].K = atoll(argv[i]); custom[nc].U = atoll(argv[i + 1]); custom[nc].m = atoi(argv[i + 2]);
        if (custom[nc].K < 1 || custom[nc].U < 1 || custom[nc].m < 1) { fprintf(stderr, "bad shape\n"); return 2; }
        nc++;
    }
    const shape *list = nc ? custom : builtin;
    const size_t n = nc ? nc : sizeof builtin / sizeof builtin[0];
    for (size_t i = 0; i < n; i++) {
        const int d = list[i].m > depth ? list[i].m : depth;
        if (run(&list[i], d, trials)) return 1;
    }
    printf("checksum %016llx\n", (unsigned long long)checksum);
    return 0;
}
