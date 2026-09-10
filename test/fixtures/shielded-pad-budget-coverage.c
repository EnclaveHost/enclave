/* Coverage-union fixture for the pad-budget diagnostic.
 *
 * It compiles the CANDIDATE shielded-pads.c into this translation unit, so every
 * assertion below runs the ACTUAL sh_pads_reader_coverage and sh_iv_insert, not
 * a re-implementation. The unity include is what makes the private
 * sh_pads_reader visible; it is the only way to reach the uint64 overflow and
 * capacity branches, which no real shipment can produce (a minted file cannot
 * have index0 near 2^64), and to hold the reader mutex for the BUSY case.
 *
 * Only header EXTENTS are fabricated. No key, no cell, no fd and no path is
 * touched, and coverage reads nothing else, so nothing here exercises or
 * weakens any crypto path.
 *
 *   node --test test/shielded-pad-budget.test.mjs
 */
#include "../../wasm/ggml-shielded/shielded-pads.c"   /* the implementation under test */

#include <assert.h>
#include <pthread.h>
#include <stdio.h>

#define IVCAP 8u
static int failures = 0;

/* `bound` is the number of groups the reader claims, `table` whether the group
 * table itself is present. A real bind sets both together; the pair is split
 * here because sh_pads_reader_bind frees the old table BEFORE allocating the new
 * one and returns SH_ERR_NOMEM without resetting n_bound, so (bound>0, no table)
 * is a state this source can leave behind. Nothing below asserts that it has
 * ever happened on a device. */
static sh_pads_reader *mk(size_t n_files, uint32_t bound, int table) {
    sh_pads_reader *r = (sh_pads_reader *)calloc(1, sizeof *r);
    assert(r);
    pthread_mutex_init(&r->mu, NULL);
    r->files = (sh_pads_file *)calloc(n_files ? n_files : 1, sizeof *r->files);
    assert(r->files);
    for (size_t i = 0; i < n_files; i++) r->files[i].fd = -1;
    r->n_files = n_files; r->cap_files = n_files ? n_files : 1;
    r->n_bound = bound;
    if (table) {
        /* A real group table, sized as sh_pads_reader_bind would size it. Its
         * CONTENTS are never read by coverage; its presence is. */
        const uint32_t n = bound ? bound : 1;
        r->bound = (sh_pads_group *)calloc(n, sizeof *r->bound);
        assert(r->bound);
    }
    return r;
}
static void put(sh_pads_reader *r, size_t i, uint64_t lo, uint64_t count) {
    r->files[i].hdr.index0 = lo; r->files[i].hdr.index_count = count;
}
static void del(sh_pads_reader *r) { free(r->files); free(r->bound); pthread_mutex_destroy(&r->mu); free(r); }

static void expect_true(const char *what, int cond) {
    if (!cond) { failures++; fprintf(stderr, "FAIL %s\n", what); } else printf("ok   %s\n", what);
}
static void check(const char *what, int got, int want) {
    if (got != want) { failures++; fprintf(stderr, "FAIL %s: status %d, want %d\n", what, got, want); }
}
static void check_ivs(const char *what, const sh_pad_interval *iv, uint32_t n,
                      const uint64_t *want, uint32_t want_n) {
    if (n != want_n) { failures++; fprintf(stderr, "FAIL %s: %u intervals, want %u\n", what, n, want_n); return; }
    for (uint32_t i = 0; i < n; i++)
        if (iv[i].lo != want[2 * i] || iv[i].hi != want[2 * i + 1]) {
            failures++;
            fprintf(stderr, "FAIL %s: interval %u is [%llu,%llu), want [%llu,%llu)\n", what, i,
                    (unsigned long long)iv[i].lo, (unsigned long long)iv[i].hi,
                    (unsigned long long)want[2 * i], (unsigned long long)want[2 * i + 1]);
            return;
        }
    printf("ok   %s\n", what);
}

struct hold { pthread_mutex_t *mu; pthread_barrier_t *locked, *release; };
static void *holder(void *p) {
    struct hold *h = (struct hold *)p;
    pthread_mutex_lock(h->mu);
    pthread_barrier_wait(h->locked);
    pthread_barrier_wait(h->release);
    pthread_mutex_unlock(h->mu);
    return NULL;
}

int main(void) {
    sh_pad_interval iv[IVCAP];
    uint32_t n = 0, nb = 0;
    uint64_t nf = 0;
    bool bt = false;

    /* null reader: unavailable, and every out-parameter is cleared. */
    n = 7; nf = 7; nb = 7; bt = true;
    check("null reader", sh_pads_reader_coverage(NULL, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_UNAVAILABLE);
    assert(n == 0 && nf == 0 && nb == 0 && !bt);
    printf("ok   null reader clears out-parameters\n");

    /* empty bound reader: OK with no intervals. Not the same as UNBOUND. */
    { sh_pads_reader *r = mk(0, 3, 1);
      check("empty bound reader", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_OK);
      assert(n == 0 && nf == 0 && nb == 3 && bt);
      printf("ok   valid empty coverage is OK, not unbound\n"); del(r); }

    /* holes: three disjoint extents stay three intervals, ascending. */
    { sh_pads_reader *r = mk(3, 1, 1);
      put(r, 0, 32, 16); put(r, 1, 0, 16); put(r, 2, 96, 16);       /* deliberately out of order */
      const uint64_t want[] = {0,16, 32,48, 96,112};
      check("holes", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_OK);
      check_ivs("holes", iv, n, want, 3);
      assert(nf == 3); del(r); }

    /* adjacency: touching extents merge, in both directions. */
    { sh_pads_reader *r = mk(3, 1, 1);
      put(r, 0, 16, 16); put(r, 1, 0, 16); put(r, 2, 32, 16);
      const uint64_t want[] = {0,48};
      check("adjacency", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_OK);
      check_ivs("adjacency", iv, n, want, 1); del(r); }

    /* nesting and duplicates collapse into the containing interval. */
    { sh_pads_reader *r = mk(4, 1, 1);
      put(r, 0, 0, 100); put(r, 1, 10, 5); put(r, 2, 0, 100); put(r, 3, 99, 1);
      const uint64_t want[] = {0,100};
      check("nesting", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_OK);
      check_ivs("nesting", iv, n, want, 1); del(r); }

    /* a bridging extent joins two islands into one. */
    { sh_pads_reader *r = mk(3, 1, 1);
      put(r, 0, 0, 10); put(r, 1, 20, 10); put(r, 2, 10, 10);
      const uint64_t want[] = {0,30};
      check("bridge", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_OK);
      check_ivs("bridge", iv, n, want, 1); del(r); }

    /* a zero-count extent covers nothing and must not create an interval. */
    { sh_pads_reader *r = mk(2, 1, 1);
      put(r, 0, 50, 0); put(r, 1, 0, 8);
      const uint64_t want[] = {0,8};
      check("zero count", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_OK);
      check_ivs("zero count", iv, n, want, 1); del(r); }

    /* uint64 overflow: refuse, claim nothing, never wrap. */
    { sh_pads_reader *r = mk(2, 1, 1);
      put(r, 0, 0, 8); put(r, 1, UINT64_MAX - 4, 10);
      check("overflow", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_INVALID);
      assert(n == 0); printf("ok   overflow claims nothing\n");
      /* the largest representable extent is still fine */
      put(r, 1, UINT64_MAX - 4, 4);
      check("max extent", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_OK);
      assert(n == 2 && iv[1].hi == UINT64_MAX); printf("ok   maximum extent representable\n"); del(r); }

    /* interval capacity: more disjoint islands than the caller can hold. */
    { sh_pads_reader *r = mk(IVCAP + 1, 1, 1);
      for (size_t i = 0; i < IVCAP + 1; i++) put(r, i, i * 100, 8);   /* every one disjoint */
      check("interval capacity", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_INCOMPLETE);
      assert(n == 0); printf("ok   interval capacity claims nothing\n"); del(r); }

    /* file capacity: refused BEFORE scanning, even though the union would fit. */
    { const size_t many = (size_t)SH_PAD_BUDGET_MAX_FILES + 1;
      sh_pads_reader *r = mk(many, 1, 1);
      for (size_t i = 0; i < many; i++) put(r, i, 0, 8);              /* one interval if scanned */
      check("file capacity", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_INCOMPLETE);
      assert(n == 0 && nf == many); printf("ok   file capacity refuses conservatively\n");
      /* exactly at the cap is scanned */
      r->n_files = (size_t)SH_PAD_BUDGET_MAX_FILES;
      check("file capacity boundary", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_OK);
      assert(n == 1); printf("ok   file capacity boundary is inclusive\n"); del(r); }

    /* Absent binding: no table and no count. Intervals are still returned and
     * are explicitly NOT coverage; this is distinct from the OK case above,
     * which is a real binding that happens to cover nothing. */
    { sh_pads_reader *r = mk(1, 0, 0);
      put(r, 0, 0, 16);
      const uint64_t want[] = {0,16};
      check("unbound", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_UNBOUND);
      check_ivs("unbound keeps its metadata", iv, n, want, 1);
      assert(nb == 0 && !bt); del(r); }

    /* A group table without a count is not a binding either. */
    { sh_pads_reader *r = mk(1, 0, 1); put(r, 0, 0, 16);
      check("table without count", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_UNBOUND);
      assert(bt && nb == 0); del(r); }

    /* FAILED REBIND, the state sh_pads_reader_bind can leave behind: it frees
     * the old table, its calloc fails, and it returns SH_ERR_NOMEM with n_bound
     * still positive. A count with no table must never be treated as bound.
     * This is a reachable-in-source state; nothing here says it has occurred. */
    { sh_pads_reader *r = mk(2, 7, 0);
      put(r, 0, 0, 16); put(r, 1, 16, 16);
      const uint64_t want[] = {0,32};
      check("failed rebind", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_BIND_INVALID);
      expect_true("failed rebind reports no table", !bt);
      expect_true("failed rebind still reports the stale count", nb == 7);
      check_ivs("failed rebind keeps its extents", iv, n, want, 1);
      del(r); }

    /* BUSY: the mutex is held elsewhere. Nothing may be reported as observed. */
    { sh_pads_reader *r = mk(2, 4, 1);
      put(r, 0, 0, 16); put(r, 1, 16, 16);
      pthread_barrier_t locked, release;
      pthread_barrier_init(&locked, NULL, 2); pthread_barrier_init(&release, NULL, 2);
      struct hold h = { &r->mu, &locked, &release };
      pthread_t t; assert(pthread_create(&t, NULL, holder, &h) == 0);
      pthread_barrier_wait(&locked);
      n = 5; nf = 5; nb = 5; bt = true;
      check("busy", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_BUSY);
      if (n != 0 || nf != 0 || nb != 0 || bt) {
          failures++; fprintf(stderr, "FAIL busy: out-parameters were published as observations\n");
      } else printf("ok   busy reports nothing as observed\n");
      pthread_barrier_wait(&release);
      pthread_join(t, NULL);
      pthread_barrier_destroy(&locked); pthread_barrier_destroy(&release);
      /* and the same reader answers normally once the holder is gone */
      check("busy then free", sh_pads_reader_coverage(r, iv, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_OK);
      assert(n == 1 && iv[0].lo == 0 && iv[0].hi == 32);
      printf("ok   busy is transient, not sticky\n"); del(r); }

    /* a caller that passes no array at all with a non-zero capacity is refused. */
    { sh_pads_reader *r = mk(1, 1, 1); put(r, 0, 0, 4);
      check("null array", sh_pads_reader_coverage(r, NULL, IVCAP, &n, &nf, &nb, &bt), SH_PAD_BUDGET_UNAVAILABLE);
      del(r); }

    if (failures) { fprintf(stderr, "\n%d FAILURE(S)\n", failures); return 1; }
    printf("\npad_budget_coverage_fixture: all checks passed\n");
    return 0;
}
