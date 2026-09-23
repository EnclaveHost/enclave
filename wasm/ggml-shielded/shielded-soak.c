/*
 * shielded-soak -- millions of real masked exchanges against one live worker,
 * to reproduce a rare Freivalds rejection on demand instead of waiting for one.
 *
 * It drives the production link path (sh_link_open -> configure -> shm ring ->
 * add_weight -> start -> sh_link_gemm with verification on) with the per-card
 * exchange shapes of the 27B under the two-card column split:
 *
 *   A  K=5120  qkv|gate|alpha|beta  N = 5120, 3072, 32, 32   (one grouped exchange)
 *   B  K=6144  ssm_out               N = 2560
 *   C  K=5120  gate|up               N = 8704, 8704
 *   D  K=17408 down                  N = 2560
 *   E  K=5120  lm_head               N = 124160               (--lm-head)
 *
 * A pass is A B C D for each of --layers layers (each layer its own random
 * weights, so 64 layers put ~12.8 GB on the card and give the worker hundreds
 * of distinct graphs, as production does), then E. Each pass runs at m=1 or
 * m=2 (random); every --prefill-every-th pass runs at m=17, as a prefill does
 * (its large replies overflow the ring and take the socket, as in production,
 * and its pads mostly come from minting on the calling thread). With
 * --restart-every S the link is closed and reopened every S seconds, which is
 * the restart window of the first production rejection.
 *
 * Fresh random activations every exchange and fresh pads from the link's own
 * refill threads, exactly as a tenant gets them. Weights are random int8 in the
 * encoding's lane; activations are small enough that no true product leaves
 * the field, so any rejection is a transport, worker or link fault, never a
 * wrap. Every exchange is Freivalds-checked by the link (the check the engine
 * relies on). The exact check (value by value against a local int64 product)
 * is STRATIFIED BY INSTANCE: each (instance, m) pair -- one weight of one
 * layer at one row count -- keeps its own counter and is checked on every
 * --exact-every-th exchange OF THAT PAIR, so every layer of every shape at
 * every m is sampled at the same rate, whatever the period. Two earlier
 * versions aliased: a global count over the A B C D cycle put every check on D
 * (period 256 is a multiple of 4), and a per-(shape, m) count put every check
 * on the last layer (the count advances once per layer per pass, and 256 is a
 * multiple of 64). Each pair is also checked on its FIRST visit, so a rare
 * cell (an m=17 pair sees one visit per --prefill-every passes) has exact
 * evidence before its periodic sample comes due, and a short run is not
 * exact-blind. Per-(shape, m) totals and per-layer coverage are printed,
 * and --schedule-selftest runs the same pass generator and selection with no
 * worker and fails unless every (instance, m) pair the configuration produces
 * is checked.
 *
 * A rejection retires the link as in production; the soak logs it (the link's
 * post-mortem line classifies the corruption), reopens a fresh link and
 * continues, so one run can count several.
 *
 * A clean soak is evidence about the paths it exercised, for as long as it
 * ran. It does not show a fault is unreachable.
 *
 *   shielded-soak --port 9601 --shm /dev/shm/enclave-shielded-shm/card-0 --seconds 1800
 *   shielded-soak ... --layers 64 --lm-head --prefill-every 50 --restart-every 300 --reserve 15500000000
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
#include <pthread.h>
#include <stdatomic.h>

static uint64_t rng = 0x9e3779b97f4a7c15ull;
static uint64_t nxt(void) { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return rng; }
static double now_s(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec * 1e-9; }

enum { KINDS = 5, MCLS = 3, MAXN = 4, PREFILL_M = 17 };
typedef struct { int K; int n; int N[MAXN]; const char *name; } kind_t;
static const kind_t kinds[KINDS] = {
    {5120, 4, {5120, 3072, 32, 32}, "qkv|gate|a|b"},
    {6144, 1, {2560}, "ssm_out"},
    {5120, 2, {8704, 8704}, "gate|up"},
    {17408, 1, {2560}, "down"},
    {5120, 1, {124160}, "lm_head"},
};
typedef struct { int kind, layer; int node[MAXN]; int8_t *w[MAXN]; } inst_t;
static inst_t *inst; static int n_inst;

static int mcls(int m) { return m == 1 ? 0 : m == 2 ? 1 : 2; }
static const char *mname[MCLS] = {"m1", "m2", "m17"};

/* The pass generator: the ONE definition of what a pass is, used by the soak
 * and by its scheduling selftest. */
typedef struct { int prefill_every; } sched_t;
static int pass_m(const sched_t *s, uint64_t pass) {
    if (s->prefill_every > 0 && pass % (uint64_t)s->prefill_every == (uint64_t)s->prefill_every - 1) return PREFILL_M;
    return 1 + (int)(nxt() & 1);
}

/* Exact-check selection, per (instance, m): inst_n[i][c] counts exchanges of
 * instance i at m-class c; the exchange is checked when that count (after
 * incrementing) is a multiple of every. The (shape, m) totals below are sums
 * over instances, for the report only. */
typedef uint64_t cnt_t[MCLS];
static cnt_t *inst_n, *inst_checked;           /* card 0's link (and the only link without --split) */
static cnt_t *inst1_n, *inst1_checked;         /* card 1's link under --split */
static int exact_due_in(cnt_t *cn, cnt_t *cc, int i, int m, int every) {
    const int c = mcls(m);
    const uint64_t n = ++cn[i][c];
    const int due = every > 0 && (n == 1 || n % (uint64_t)every == 0);   /* first visit, then periodic */
    if (due) cc[i][c]++;
    return due;
}
static int exact_due(int i, int m, int every) { return exact_due_in(inst_n, inst_checked, i, m, every); }
/* Per (shape, m): checked of total exchanges, and how many of the shape's
 * instances (layers) got at least one exact check at that m. */
static void print_cells_in(FILE *f, const char *label, cnt_t *cn, cnt_t *cc) {
    fprintf(f, "soak: %sexact checks per (shape x m), with layers covered:", label);
    for (int k = 0; k < KINDS; k++) for (int c = 0; c < MCLS; c++) {
        uint64_t n = 0, chk = 0; int have = 0, covered = 0;
        for (int i = 0; i < n_inst; i++) {
            if (inst[i].kind != k || !cn[i][c]) continue;
            have++; n += cn[i][c]; chk += cc[i][c];
            if (cc[i][c]) covered++;
        }
        if (have) fprintf(f, " %s/%s=%llu of %llu [%d of %d layers]", kinds[k].name, mname[c],
                          (unsigned long long)chk, (unsigned long long)n, covered, have);
    }
    fprintf(f, "\n");
}
static void print_cells(FILE *f) { print_cells_in(f, "", inst_n, inst_checked); }

/* The soak's scheduling with no worker: same pass generator, same selection.
 * Fails unless every cell the configuration produces is checked. */
static int schedule_selftest(const sched_t *s, int every, uint64_t passes) {
    for (uint64_t p = 0; p < passes; p++) {
        const int m = pass_m(s, p);
        for (int i = 0; i < n_inst; i++) (void)exact_due(i, m, every);
    }
    print_cells(stdout);
    /* Two properties, checked separately so first-visit sampling cannot hide
     * an aliased periodic sampler: every pair is checked at least once, and
     * every pair visited at least `every` times has a periodic check too
     * (checked >= 2: its first visit plus one more). */
    int ok = 1, pairs = 0, missed = 0, periodic_due = 0, periodic_missed = 0;
    for (int i = 0; i < n_inst; i++) for (int c = 0; c < MCLS; c++) {
        if (!inst_n[i][c]) continue;
        pairs++;
        if (!inst_checked[i][c]) { ok = 0; missed++; }
        if (every > 1 && inst_n[i][c] >= (uint64_t)every) {
            periodic_due++;
            if (inst_checked[i][c] < 2) { ok = 0; periodic_missed++; }
        }
    }
    if (ok) printf("schedule-selftest: PASS -- all %d (instance, m) pairs are exact-checked; all %d pairs visited at least %d times have a periodic check\n",
                   pairs, periodic_due, every);
    else printf("schedule-selftest: FAIL -- %d of %d (instance, m) pairs never exact-checked; %d of %d pairs past the period have no periodic check\n",
                missed, pairs, periodic_missed, periodic_due);
    return ok ? 0 : 1;
}

static sh_link *open_link(const char *host, int port, const char *shm, uint64_t reserve, int refill, int max_m, inst_t *arr) {
    int err = SH_OK;
    sh_link *l = sh_link_open(host, port, true, &err);
    if (!l) { fprintf(stderr, "soak: open failed (%d)\n", err); return NULL; }
    sh_link_configure(l, 0, reserve, refill);
    sh_link_configure_shm(l, shm ? shm : "", shm ? 67108864u : 0);
    for (int i = 0; i < n_inst; i++) {
        const kind_t *k = &kinds[arr[i].kind];
        int first = -1;
        for (int j = 0; j < k->n; j++) {
            char nm[64]; snprintf(nm, sizeof nm, "soak.L%d.%d.%d", arr[i].layer, arr[i].kind, j);
            const int nd = sh_link_add_weight(l, nm, arr[i].w[j], k->K, k->N[j], max_m, first);
            if (nd < 0) { fprintf(stderr, "soak: add_weight %s: %s\n", nm, sh_link_last_error(l)); sh_link_close(l); return NULL; }
            if (first < 0) first = nd;
            arr[i].node[j] = nd;
        }
    }
    const double t0 = now_s();
    if (sh_link_start(l) != SH_OK) { fprintf(stderr, "soak: start: %s\n", sh_link_last_error(l)); sh_link_close(l); return NULL; }
    fprintf(stderr, "soak: link live (%.1f s to start)\n", now_s() - t0);
    return l;
}

static int exact_check(const inst_t *in, const int64_t *x, int m, int64_t *const *y, uint64_t n_ex) {
    const kind_t *k = &kinds[in->kind];
    for (int j = 0; j < k->n; j++)
        for (int r = 0; r < m; r++)
            for (int c = 0; c < k->N[j]; c++) {
                const int8_t *wr = in->w[j] + (size_t)c * k->K;
                int64_t s = 0;
                for (int q = 0; q < k->K; q++) s += (int64_t)wr[q] * x[(size_t)r * k->K + q];
                if (y[j][(size_t)r * k->N[j] + c] != sh_balanced(s)) {
                    fprintf(stderr, "soak: EXACT MISMATCH that passed the check: exchange %llu layer %d %s node %d row %d col %d\n",
                            (unsigned long long)n_ex, in->layer, k->name, j, r, c);
                    return 0;
                }
            }
    return 1;
}

/* --split: card 1's exchange runs on a helper thread that SPINS for work, as
 * the backend's split worker does, concurrently with card 0's on the main
 * thread, on the same activations. Both links live in this one process. */
typedef struct {
    atomic_ulong gen, done; atomic_int quit;
    sh_link *l; const int *nodes; size_t n; const int64_t *x; int m; int64_t **y; int rc;
} helper_t;
static void *helper_main(void *arg) {
    helper_t *h = (helper_t *)arg;
    unsigned long seen = 0;
    for (;;) {
        unsigned long g;
        while ((g = atomic_load_explicit(&h->gen, memory_order_acquire)) == seen)
            if (atomic_load_explicit(&h->quit, memory_order_relaxed)) return NULL;
        seen = g;
        h->rc = sh_link_gemm(h->l, h->nodes, h->n, h->x, h->m, h->y);
        atomic_store_explicit(&h->done, g, memory_order_release);
    }
}

int main(int argc, char **argv) {
    const char *host = "127.0.0.1", *shm = NULL, *shm1 = NULL;
    int port1 = 0;
    int port = 9601, refill = 8, exact_every = 256, layers = 1, lm_head = 0, selftest = 0;
    double seconds = 600, restart_every = 0;
    uint64_t reserve = 2000000000ull;
    sched_t sc = {0};
    for (int i = 1; i < argc; i++) {
        const int more = i + 1 < argc;
        if (!strcmp(argv[i], "--host") && more) host = argv[++i];
        else if (!strcmp(argv[i], "--port") && more) port = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--shm") && more) shm = argv[++i];
        else if (!strcmp(argv[i], "--seconds") && more) seconds = atof(argv[++i]);
        else if (!strcmp(argv[i], "--refill") && more) refill = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--exact-every") && more) exact_every = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--seed") && more) rng = strtoull(argv[++i], NULL, 0) | 1;
        else if (!strcmp(argv[i], "--layers") && more) layers = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--prefill-every") && more) sc.prefill_every = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--restart-every") && more) restart_every = atof(argv[++i]);
        else if (!strcmp(argv[i], "--reserve") && more) reserve = strtoull(argv[++i], NULL, 0);
        else if (!strcmp(argv[i], "--lm-head")) lm_head = 1;
        else if (!strcmp(argv[i], "--split") && i + 2 < argc) { port1 = atoi(argv[++i]); shm1 = argv[++i]; }
        else if (!strcmp(argv[i], "--schedule-selftest")) selftest = 1;
        else { fprintf(stderr, "soak: unknown or incomplete argument %s\n", argv[i]); return 2; }
    }
    if (layers < 1 || layers > 128) { fprintf(stderr, "soak: --layers 1..128\n"); return 2; }
    n_inst = layers * 4 + (lm_head ? 1 : 0);
    inst = calloc((size_t)n_inst, sizeof *inst);
    for (int L = 0; L < layers; L++) for (int k = 0; k < 4; k++) { inst[L * 4 + k].kind = k; inst[L * 4 + k].layer = L; }
    if (lm_head) { inst[n_inst - 1].kind = 4; inst[n_inst - 1].layer = -1; }
    inst_n = calloc((size_t)n_inst, sizeof *inst_n);
    inst_checked = calloc((size_t)n_inst, sizeof *inst_checked);
    inst1_n = calloc((size_t)n_inst, sizeof *inst1_n);
    inst1_checked = calloc((size_t)n_inst, sizeof *inst1_checked);
    if (selftest) return schedule_selftest(&sc, exact_every, 20000);

    const int max_m = sc.prefill_every > 0 ? PREFILL_M : 2;
    int Kmax = 0, Nmax = 0;
    double wbytes = 0;
    for (int i = 0; i < n_inst; i++) {
        const kind_t *k = &kinds[inst[i].kind];
        if (k->K > Kmax) Kmax = k->K;
        for (int j = 0; j < k->n; j++) {
            if (k->N[j] > Nmax) Nmax = k->N[j];
            const size_t n = (size_t)k->N[j] * k->K;
            inst[i].w[j] = malloc(n);
            if (!inst[i].w[j]) { fprintf(stderr, "oom\n"); return 2; }
            for (size_t q = 0; q < n; q++) inst[i].w[j][q] = (int8_t)((int)(nxt() % 239) - 119);
            wbytes += (double)n;
        }
    }
    inst_t *inst1 = NULL;
    if (port1) {   /* card 1: the same shapes, its own random weights */
        inst1 = calloc((size_t)n_inst, sizeof *inst1);
        for (int i = 0; i < n_inst; i++) {
            inst1[i].kind = inst[i].kind; inst1[i].layer = inst[i].layer;
            const kind_t *k = &kinds[inst1[i].kind];
            for (int j = 0; j < k->n; j++) {
                const size_t n = (size_t)k->N[j] * k->K;
                inst1[i].w[j] = malloc(n);
                if (!inst1[i].w[j]) { fprintf(stderr, "oom\n"); return 2; }
                for (size_t q = 0; q < n; q++) inst1[i].w[j][q] = (int8_t)((int)(nxt() % 239) - 119);
            }
        }
    }
    fprintf(stderr, "soak: %s, %d exchanges per pass, %.2f GB of weights, max m %d, prefill every %d, restart every %.0f s\n",
            port1 ? "two links in one process (--split)" : "one link", n_inst, wbytes / 1e9 * (port1 ? 2 : 1), max_m, sc.prefill_every, restart_every);
    int64_t *x = malloc(sizeof(int64_t) * (size_t)max_m * Kmax);
    int64_t *y[MAXN]; for (int i = 0; i < MAXN; i++) y[i] = malloc(sizeof(int64_t) * (size_t)max_m * Nmax);
    int64_t *y1[MAXN]; for (int i = 0; i < MAXN; i++) y1[i] = malloc(sizeof(int64_t) * (size_t)max_m * Nmax);

    sh_link *l = open_link(host, port, shm, reserve, refill, max_m, inst);
    if (!l) return 2;
    helper_t hp; memset(&hp, 0, sizeof hp);
    pthread_t hth;
    uint64_t n_rej1 = 0, n_other1 = 0, n_exact1 = 0, n_exact_bad1 = 0;
    if (port1) {
        hp.l = open_link(host, port1, shm1, reserve, refill, max_m, inst1);
        if (!hp.l) return 2;
        if (pthread_create(&hth, NULL, helper_main, &hp) != 0) { fprintf(stderr, "soak: helper thread\n"); return 2; }
    }
    double t_open = now_s();
    uint64_t n_ex = 0, n_exact = 0, n_exact_bad = 0, n_rej = 0, n_other = 0, n_restart = 0, n_by_m[MCLS] = {0, 0, 0};
    const double t_start = now_s();
    double t_report = t_start;
    for (uint64_t pass = 0; now_s() - t_start < seconds; pass++) {
        if (restart_every > 0 && now_s() - t_open >= restart_every) {
            sh_link_close(l);
            l = open_link(host, port, shm, reserve, refill, max_m, inst);
            if (!l) return 3;
            if (port1) { sh_link_close(hp.l); hp.l = open_link(host, port1, shm1, reserve, refill, max_m, inst1); if (!hp.l) return 3; }
            t_open = now_s(); n_restart++;
        }
        const int m = pass_m(&sc, pass);
        for (int i = 0; i < n_inst; i++) {
            const inst_t *in = &inst[i];
            const kind_t *k = &kinds[in->kind];
            for (int q = 0; q < m * k->K; q++) x[q] = (int64_t)(nxt() % 7) - 3;   /* |y| far inside the field */
            unsigned long g = 0;
            if (port1) {
                hp.nodes = inst1[i].node; hp.n = (size_t)k->n; hp.x = x; hp.m = m; hp.y = y1;
                g = atomic_load_explicit(&hp.gen, memory_order_relaxed) + 1;
                atomic_store_explicit(&hp.gen, g, memory_order_release);
            }
            const int rc = sh_link_gemm(l, in->node, (size_t)k->n, x, m, y);
            if (port1) {
                while (atomic_load_explicit(&hp.done, memory_order_acquire) != g) ;
                if (hp.rc != SH_OK) {
                    if (hp.rc == SH_ERR_VERIFY) n_rej1++; else n_other1++;
                    fprintf(stderr, "soak: CARD 1 REJECTION #%llu at exchange %llu (pass %llu, layer %d %s, m=%d, %.1f s after link open) rc=%d: %s\n",
                            (unsigned long long)(n_rej1 + n_other1), (unsigned long long)n_ex + 1, (unsigned long long)pass,
                            in->layer, k->name, m, now_s() - t_open, hp.rc, sh_link_last_error(hp.l));
                    sh_link_close(hp.l);
                    hp.l = open_link(host, port1, shm1, reserve, refill, max_m, inst1);
                    if (!hp.l) return 3;
                } else if (exact_due_in(inst1_n, inst1_checked, i, m, exact_every)) {
                    n_exact1++;
                    if (!exact_check(&inst1[i], x, m, y1, n_ex + 1)) n_exact_bad1++;
                }
            }
            n_ex++; n_by_m[mcls(m)]++;
            if (rc != SH_OK) {
                if (rc == SH_ERR_VERIFY) n_rej++; else n_other++;
                fprintf(stderr, "soak: REJECTION #%llu at exchange %llu (pass %llu, layer %d %s, m=%d, %.1f s after link open) rc=%d: %s\n",
                        (unsigned long long)(n_rej + n_other), (unsigned long long)n_ex, (unsigned long long)pass,
                        in->layer, k->name, m, now_s() - t_open, rc, sh_link_last_error(l));
                sh_link_close(l);
                l = open_link(host, port, shm, reserve, refill, max_m, inst);
                if (!l) return 3;
                t_open = now_s();
                continue;
            }
            if (exact_due(i, m, exact_every)) {
                n_exact++;
                if (!exact_check(in, x, m, y, n_ex)) n_exact_bad++;
            }
        }
        const double t = now_s();
        if (t - t_report >= 30) {
            t_report = t;
            fprintf(stderr, "soak: %.0f s  %llu exchanges (%.0f/s; m1 %llu m2 %llu m17 %llu)  restarts %llu  rejections %llu other %llu  exact checks %llu bad %llu\n",
                    t - t_start, (unsigned long long)n_ex, n_ex / (t - t_start), (unsigned long long)n_by_m[0],
                    (unsigned long long)n_by_m[1], (unsigned long long)n_by_m[2], (unsigned long long)n_restart,
                    (unsigned long long)n_rej, (unsigned long long)n_other,
                    (unsigned long long)n_exact, (unsigned long long)n_exact_bad);
            print_cells(stderr);
            if (port1) {
                fprintf(stderr, "soak: card 1: rejections %llu other %llu exact checks %llu bad %llu\n",
                        (unsigned long long)n_rej1, (unsigned long long)n_other1, (unsigned long long)n_exact1, (unsigned long long)n_exact_bad1);
                print_cells_in(stderr, "card 1 ", inst1_n, inst1_checked);
            }
        }
    }
    print_cells(stderr);
    if (port1) {
        print_cells_in(stderr, "card 1 ", inst1_n, inst1_checked);
        atomic_store(&hp.quit, 1); pthread_join(hth, NULL); sh_link_close(hp.l);
    }
    const double dt = now_s() - t_start;
    printf("{\"seconds\":%.0f,\"exchanges\":%llu,\"m1\":%llu,\"m2\":%llu,\"m17\":%llu,\"restarts\":%llu,\"rejections\":%llu,"
           "\"other_errors\":%llu,\"exact_checks\":%llu,\"exact_bad\":%llu,\"layers\":%d,\"lm_head\":%d,\"port\":%d,"
           "\"split_port\":%d,\"card1_rejections\":%llu,\"card1_other\":%llu,\"card1_exact_checks\":%llu,\"card1_exact_bad\":%llu}\n",
           dt, (unsigned long long)n_ex, (unsigned long long)n_by_m[0], (unsigned long long)n_by_m[1],
           (unsigned long long)n_by_m[2], (unsigned long long)n_restart, (unsigned long long)n_rej,
           (unsigned long long)n_other, (unsigned long long)n_exact, (unsigned long long)n_exact_bad, layers, lm_head, port,
           port1, (unsigned long long)n_rej1, (unsigned long long)n_other1, (unsigned long long)n_exact1, (unsigned long long)n_exact_bad1);
    sh_link_close(l);
    return (n_rej || n_other || n_exact_bad || n_rej1 || n_other1 || n_exact_bad1) ? 1 : 0;
}
