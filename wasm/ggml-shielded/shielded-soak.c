/*
 * shielded-soak -- millions of real masked exchanges against one live worker,
 * to reproduce a rare Freivalds rejection on demand instead of waiting for one.
 *
 * It drives the production link path (sh_link_open -> configure -> shm ring ->
 * add_weight -> start -> sh_link_gemm with verification on) with the per-card
 * exchange shapes of one 27B decode layer under the two-card column split:
 *
 *   A  K=5120  qkv|gate|alpha|beta  N = 5120, 3072, 32, 32   (one grouped exchange)
 *   B  K=6144  ssm_out               N = 2560
 *   C  K=5120  gate|up               N = 8704, 8704
 *   D  K=17408 down                  N = 2560
 *
 * cycling A B C D like a decode pass, each pass at m=1 or m=2 (random), fresh
 * random activations every exchange and fresh pads from the link's own refill
 * threads, exactly as a tenant gets them. Weights are random int8 in the
 * encoding's lane; activations are small enough that no true product leaves
 * the field, so any rejection is a transport, worker or link fault, never a
 * wrap. Every exchange is Freivalds-checked by the link (the check the engine
 * relies on); one in --exact-every is also compared value by value against a
 * local int64 product. A rejection retires the link as in production; the
 * soak logs it (the link's post-mortem line classifies the corruption),
 * reopens a fresh link and continues, so one run can count several.
 *
 *   shielded-soak --port 9601 --shm /dev/shm/enclave-shielded-shm/card-0 --seconds 1800
 *
 * SHIELDED_OVERLAP_VERIFY=1 in the environment takes the overlapped-RHS path
 * the benchmark uses. Nothing here is secret: the fixture is synthetic.
 */
#include "shielded-field.h"
#include "shielded-tee.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static uint64_t rng = 0x9e3779b97f4a7c15ull;
static uint64_t nxt(void) { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return rng; }
static double now_s(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec * 1e-9; }

typedef struct { int K; int n; int N[4]; const char *name; int node[4]; int8_t *w[4]; } ex_t;
static ex_t ex[4] = {
    {5120, 4, {5120, 3072, 32, 32}, "qkv|gate|a|b"},
    {6144, 1, {2560}, "ssm_out"},
    {5120, 2, {8704, 8704}, "gate|up"},
    {17408, 1, {2560}, "down"},
};

static sh_link *open_link(const char *host, int port, const char *shm, uint64_t reserve, int refill) {
    int err = SH_OK;
    sh_link *l = sh_link_open(host, port, true, &err);
    if (!l) { fprintf(stderr, "soak: open failed (%d)\n", err); return NULL; }
    sh_link_configure(l, 0, reserve, refill);
    sh_link_configure_shm(l, shm ? shm : "", shm ? 67108864u : 0);
    for (int e = 0; e < 4; e++) {
        int first = -1;
        for (int i = 0; i < ex[e].n; i++) {
            char nm[64]; snprintf(nm, sizeof nm, "soak.%d.%d", e, i);
            const int nd = sh_link_add_weight(l, nm, ex[e].w[i], ex[e].K, ex[e].N[i], 2, first);
            if (nd < 0) { fprintf(stderr, "soak: add_weight %s: %s\n", nm, sh_link_last_error(l)); sh_link_close(l); return NULL; }
            if (first < 0) first = nd;
            ex[e].node[i] = nd;
        }
    }
    const double t0 = now_s();
    if (sh_link_start(l) != SH_OK) { fprintf(stderr, "soak: start: %s\n", sh_link_last_error(l)); sh_link_close(l); return NULL; }
    fprintf(stderr, "soak: link live (%.1f s to start)\n", now_s() - t0);
    return l;
}

int main(int argc, char **argv) {
    const char *host = "127.0.0.1", *shm = NULL;
    int port = 9601, refill = 8, exact_every = 256;
    double seconds = 600;
    uint64_t reserve = 2000000000ull;
    for (int i = 1; i < argc - 1; i++) {
        if (!strcmp(argv[i], "--host")) host = argv[++i];
        else if (!strcmp(argv[i], "--port")) port = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--shm")) shm = argv[++i];
        else if (!strcmp(argv[i], "--seconds")) seconds = atof(argv[++i]);
        else if (!strcmp(argv[i], "--refill")) refill = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--exact-every")) exact_every = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--seed")) rng = strtoull(argv[++i], NULL, 0) | 1;
    }
    int Kmax = 0, Nmax = 0;
    for (int e = 0; e < 4; e++) {
        if (ex[e].K > Kmax) Kmax = ex[e].K;
        for (int i = 0; i < ex[e].n; i++) {
            if (ex[e].N[i] > Nmax) Nmax = ex[e].N[i];
            const size_t n = (size_t)ex[e].N[i] * ex[e].K;
            ex[e].w[i] = malloc(n);
            if (!ex[e].w[i]) { fprintf(stderr, "oom\n"); return 2; }
            for (size_t k = 0; k < n; k++) ex[e].w[i][k] = (int8_t)((int)(nxt() % 239) - 119);
        }
    }
    int64_t *x = malloc(sizeof(int64_t) * 2 * Kmax);
    int64_t *y[4]; for (int i = 0; i < 4; i++) y[i] = malloc(sizeof(int64_t) * 2 * Nmax);

    sh_link *l = open_link(host, port, shm, reserve, refill);
    if (!l) return 2;
    uint64_t n_ex = 0, n_exact = 0, n_exact_bad = 0, n_rej = 0, n_other = 0, n_by_m[3] = {0, 0, 0};
    const double t_start = now_s();
    double t_report = t_start;
    int m = 1;
    for (uint64_t pass = 0; now_s() - t_start < seconds; pass++) {
        m = 1 + (int)(nxt() & 1);
        for (int e = 0; e < 4; e++) {
            const int K = ex[e].K;
            for (int i = 0; i < m * K; i++) x[i] = (int64_t)(nxt() % 7) - 3;   /* |y| far inside the field */
            const int rc = sh_link_gemm(l, ex[e].node, (size_t)ex[e].n, x, m, y);
            n_ex++; n_by_m[m]++;
            if (rc != SH_OK) {
                const char *why = sh_link_last_error(l);
                if (rc == SH_ERR_VERIFY) n_rej++; else n_other++;
                fprintf(stderr, "soak: REJECTION #%llu at exchange %llu (pass %llu, %s, m=%d) rc=%d: %s\n",
                        (unsigned long long)(n_rej + n_other), (unsigned long long)n_ex, (unsigned long long)pass,
                        ex[e].name, m, rc, why);
                sh_link_close(l);
                l = open_link(host, port, shm, reserve, refill);
                if (!l) return 3;
                continue;
            }
            if (exact_every > 0 && n_ex % (uint64_t)exact_every == 0) {
                n_exact++;
                for (int i = 0; i < ex[e].n; i++)
                    for (int r = 0; r < m; r++)
                        for (int j = 0; j < ex[e].N[i]; j++) {
                            const int8_t *wr = ex[e].w[i] + (size_t)j * K;
                            int64_t s = 0;
                            for (int k = 0; k < K; k++) s += (int64_t)wr[k] * x[(size_t)r * K + k];
                            if (y[i][(size_t)r * ex[e].N[i] + j] != sh_balanced(s)) {
                                n_exact_bad++;
                                fprintf(stderr, "soak: EXACT MISMATCH that passed the check: exchange %llu %s node %d row %d col %d\n",
                                        (unsigned long long)n_ex, ex[e].name, i, r, j);
                                goto exact_done;
                            }
                        }
            exact_done:;
            }
        }
        const double t = now_s();
        if (t - t_report >= 30) {
            t_report = t;
            fprintf(stderr, "soak: %.0f s  %llu exchanges (%.0f/s; m1 %llu m2 %llu)  rejections %llu other %llu  exact checks %llu bad %llu\n",
                    t - t_start, (unsigned long long)n_ex, n_ex / (t - t_start), (unsigned long long)n_by_m[1],
                    (unsigned long long)n_by_m[2], (unsigned long long)n_rej, (unsigned long long)n_other,
                    (unsigned long long)n_exact, (unsigned long long)n_exact_bad);
        }
    }
    const double dt = now_s() - t_start;
    printf("{\"seconds\":%.0f,\"exchanges\":%llu,\"m1\":%llu,\"m2\":%llu,\"rejections\":%llu,\"other_errors\":%llu,"
           "\"exact_checks\":%llu,\"exact_bad\":%llu,\"port\":%d}\n",
           dt, (unsigned long long)n_ex, (unsigned long long)n_by_m[1], (unsigned long long)n_by_m[2],
           (unsigned long long)n_rej, (unsigned long long)n_other, (unsigned long long)n_exact,
           (unsigned long long)n_exact_bad, port);
    sh_link_close(l);
    return (n_rej || n_other || n_exact_bad) ? 1 : 0;
}
