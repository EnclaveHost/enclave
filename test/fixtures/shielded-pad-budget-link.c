/* Link-level fixture for the pad-budget diagnostic.
 *
 * It compiles the CANDIDATE shielded-pads.c AND shielded-tee.c into this
 * translation unit, so every assertion runs the ACTUAL sh_link_pad_budget and
 * sh_pads_reader_coverage rather than a mirror, and so the fixture can hold the
 * real pool_mu and reader mutex to produce genuine BUSY. The two files share no
 * static function name, static object or macro definition other than an
 * identical _GNU_SOURCE, so the unity include introduces no collision.
 *
 * NOTHING IS STARTED. No refill thread runs, no socket is opened, no window is
 * reserved, no directory is scanned, no shipment exists and no cell is read.
 * The "started" states below are FABRICATED IN THE FIXTURE on objects the
 * fixture owns, which is legitimate precisely because the accessor's documented
 * contract is that the caller externally excludes sh_link_start and the request
 * path: here the fixture is the only thread that ever touches these objects
 * except where it deliberately hands a mutex to a helper. No production code is
 * added or altered to make this possible.
 *
 * threads_running is written by start_pools and stop_threads, NEITHER under
 * pool_mu, so it is exactly one of the fields covered by that external
 * exclusion rather than by the mutex the accessor takes. The fabrication below
 * sets it under the same sole ownership.
 *
 *   node --test test/shielded-pad-budget.test.mjs
 */
#include "../../wasm/ggml-shielded/shielded-pads.c"   /* implementation under test */
#include "../../wasm/ggml-shielded/shielded-tee.c"    /* implementation under test */

#include <assert.h>
#include <pthread.h>
#include <stdio.h>

#define GCAP 8u
#define IVCAP 8u
static int failures = 0;

static void check(const char *what, int got, int want) {
    if (got != want) { failures++; fprintf(stderr, "FAIL %s: status %d, want %d\n", what, got, want); }
    else printf("ok   %s\n", what);
}
static void expect(const char *what, int cond) {
    if (!cond) { failures++; fprintf(stderr, "FAIL %s\n", what); } else printf("ok   %s\n", what);
}

/* K must be a multiple of 32; sh_link_add_weight refuses K=8. */
#define FIX_K 32
#define FIX_N 8
static int8_t W[FIX_K * FIX_N];

static sh_link *open_link(int dealt) {
    if (dealt) {
        setenv("SHIELDED_PAD_SOURCE", "/nonexistent-pad-dir", 1);
        setenv("SHIELDED_PAD_SEED",
               "0000000000000000000000000000000000000000000000000000000000000000", 1);
        setenv("SHIELDED_PAD_SEED_ID", "00000000000000000000000000000000", 1);
        setenv("SHIELDED_PAD_SK",
               "0000000000000000000000000000000000000000000000000000000000000000", 1);
        setenv("SHIELDED_PAD_LEDGER", "/nonexistent-pad-dir/ledger", 1);
    } else {
        unsetenv("SHIELDED_PAD_SOURCE");
    }
    int err = 0;
    sh_link *l = sh_link_open("127.0.0.1", 1, false, &err);
    assert(l);
    assert(sh_link_add_weight(l, "blk.0.attn_q.weight", W, FIX_K, FIX_N, 4, -1) >= 0);
    assert(sh_link_add_weight(l, "blk.0.ffn_down.weight", W, FIX_K, FIX_N, 4, -1) >= 0);
    return l;
}

/* A reader the fixture owns outright: real mutex, real file array, fabricated
 * header extents only. No key, cell, fd or path is touched. `table` splits the
 * group-table pointer from n_bound so the failed-rebind state is reachable. */
static sh_pads_reader *mk_reader(size_t n_files, uint32_t bound, int table) {
    sh_pads_reader *r = (sh_pads_reader *)calloc(1, sizeof *r);
    assert(r);
    pthread_mutex_init(&r->mu, NULL);
    r->files = (sh_pads_file *)calloc(n_files ? n_files : 1, sizeof *r->files);
    assert(r->files);
    for (size_t i = 0; i < n_files; i++) r->files[i].fd = -1;
    r->n_files = n_files; r->cap_files = n_files ? n_files : 1;
    r->n_bound = bound;
    if (table) { r->bound = (sh_pads_group *)calloc(bound ? bound : 1, sizeof *r->bound); assert(r->bound); }
    return r;
}
static void put(sh_pads_reader *r, size_t i, uint64_t lo, uint64_t count) {
    r->files[i].hdr.index0 = lo; r->files[i].hdr.index_count = count;
}

/* The ring shape start_pools would have produced, built here instead. The
 * fixture, not the runtime, owns every byte; sh_link_close frees them through
 * the ordinary free_pools/sh_pads_reader_close paths, so nothing leaks and the
 * teardown under sanitizers is the real one. stop_threads is safe with
 * n_threads 0 and threads NULL: its join loop runs zero times. */
static void fabricate_started(sh_link *l, sh_pads_reader *r,
                              int depth, int ready, int generating, int held, uint64_t cursor) {
    for (size_t i = 0; i < l->n_groups; i++) {
        sh_group *g = &l->groups[i];
        g->depth = depth;
        g->r_store = (int32_t *)calloc((size_t)depth * (size_t)g->K, sizeof *g->r_store);
        g->u_store = (int32_t *)calloc((size_t)depth * (size_t)g->u_len, sizeof *g->u_store);
        g->ready   = (uint8_t *)calloc((size_t)depth, 1);
        assert(g->r_store && g->u_store && g->ready);
        g->count = ready; g->generating = generating; g->held = held;
        g->cursor = cursor + i;              /* distinct per group, so a mix-up is visible */
        g->pads_used = 100 + i; g->pads_missed = i;
    }
    l->threads_running = true; l->n_threads = 0; l->threads = NULL;
    l->win_lo = 64; l->win_hi = 192;
    l->pads_used = 201; l->pads_missed = 1; l->pads_waited = 2;
    l->pads = r;
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
/* Run `body` while `mu` is held by another thread. */
#define WITH_HELD(mu, body) do {                                                   \
    pthread_barrier_t _lk, _rl;                                                    \
    pthread_barrier_init(&_lk, NULL, 2); pthread_barrier_init(&_rl, NULL, 2);      \
    struct hold _h = { (mu), &_lk, &_rl };                                         \
    pthread_t _t; assert(pthread_create(&_t, NULL, holder, &_h) == 0);             \
    pthread_barrier_wait(&_lk);                                                    \
    body;                                                                          \
    pthread_barrier_wait(&_rl); pthread_join(_t, NULL);                            \
    pthread_barrier_destroy(&_lk); pthread_barrier_destroy(&_rl);                  \
} while (0)

int main(void) {
    sh_pad_budget b;
    sh_pad_interval iv[IVCAP];
    sh_pad_group_budget gb[GCAP];

    /* ---- unstarted and degenerate cases ---------------------------------- */

    check("null link", sh_link_pad_budget(NULL, &b, 0, iv, IVCAP, gb, GCAP), SH_PAD_BUDGET_UNAVAILABLE);
    expect("null link is versioned", b.version == SH_PAD_BUDGET_VERSION);
    expect("null link reports no card", b.card == -1);
    expect("null link timed the attempt", b.mono_valid && b.mono_end_ns >= b.mono_start_ns);
    expect("null link writes no records", b.written_groups == 0 && b.n_intervals == 0);
    expect("null link observed no link half", !b.link_observed);
    check("null record", sh_link_pad_budget(NULL, NULL, 0, iv, IVCAP, gb, GCAP), SH_PAD_BUDGET_UNAVAILABLE);

    { sh_link *l = open_link(0);
      check("not dealt", sh_link_pad_budget(l, &b, 0, iv, IVCAP, gb, GCAP), SH_PAD_BUDGET_UNAVAILABLE);
      expect("not dealt still counts groups", b.n_groups == 2);
      expect("not dealt writes no group records", b.written_groups == 0);
      expect("not dealt says so", !b.dealt);
      sh_link_close(l); }

    { sh_link *l = open_link(1);
      check("dealt, unstarted", sh_link_pad_budget(l, &b, 0, iv, IVCAP, gb, GCAP), SH_PAD_BUDGET_UNSTARTED);
      expect("unstarted observed the link half", b.link_observed);
      expect("unstarted is dealt", b.dealt && !b.threads_running);
      expect("unstarted has no reader", b.reader_status == SH_PAD_BUDGET_NO_READER);
      expect("unstarted keeps its group records", b.written_groups == 2 && b.n_groups == 2);
      expect("unstarted group identity", gb[0].group == 0 && gb[1].group == 1);
      expect("unstarted group names", !strcmp(gb[0].name, "blk.0.attn_q.weight") &&
                                      !strcmp(gb[1].name, "blk.0.ffn_down.weight"));
      expect("unstarted group dimensions", gb[0].K == FIX_K && gb[0].u_len == FIX_N);
      expect("unstarted ring is not yet sized", gb[0].depth == 0 && gb[0].ready == 0 &&
                                                gb[0].generating == 0 && gb[0].held == 0);
      expect("unstarted window is zero", b.win_lo == 0 && b.win_hi == 0);
      expect("unstarted epoch is unknown", !b.bind_epoch_known && b.bind_epoch == 0);
      expect("unstarted intervals are not coverage", !b.intervals_are_bound_coverage);
      expect("counters withheld by default", !b.counters_valid && b.link_pads_used == 0 &&
                                             b.link_pads_missed == 0 && b.pads_waited == 0);
      expect("group counters withheld by default", gb[0].pads_used == 0 && gb[0].pads_missed == 0);
      sh_link_pad_budget(l, &b, SH_PAD_BUDGET_F_REQUEST_PATH_EXCLUDED, iv, IVCAP, gb, GCAP);
      expect("counters read when the caller asserts exclusion", b.counters_valid);
      check("zero group capacity", sh_link_pad_budget(l, &b, 0, iv, IVCAP, gb, 0), SH_PAD_BUDGET_INCOMPLETE);
      expect("zero group capacity writes nothing", b.written_groups == 0 && b.cap_groups == 0);
      check("null group array", sh_link_pad_budget(l, &b, 0, iv, IVCAP, NULL, GCAP), SH_PAD_BUDGET_INCOMPLETE);
      check("one group capacity", sh_link_pad_budget(l, &b, 0, iv, IVCAP, gb, 1), SH_PAD_BUDGET_INCOMPLETE);
      expect("one group capacity writes one", b.written_groups == 1 && b.n_groups == 2);
      sh_link_close(l); }

    /* ---- started link, fixture-owned fabricated state --------------------- */

    { sh_link *l = open_link(1);
      sh_pads_reader *r = mk_reader(2, 2, 1);
      put(r, 0, 64, 32); put(r, 1, 96, 32);            /* adjacent: one interval [64,128) */
      fabricate_started(l, r, /*depth*/64, /*ready*/40, /*generating*/3, /*held*/2, /*cursor*/128);

      check("started link", sh_link_pad_budget(l, &b, SH_PAD_BUDGET_F_REQUEST_PATH_EXCLUDED,
                                               iv, IVCAP, gb, GCAP), SH_PAD_BUDGET_OK);
      expect("started observed the link half", b.link_observed);
      expect("started is dealt and running", b.dealt && b.threads_running && !b.stop);
      expect("started window is reported", b.win_lo == 64 && b.win_hi == 192 && b.pad_window == 64);
      expect("started reader is OK", b.reader_status == SH_PAD_BUDGET_OK);
      expect("started coverage is a merged union", b.n_intervals == 1 &&
                                                   iv[0].lo == 64 && iv[0].hi == 128);
      expect("started coverage is bound coverage", b.intervals_are_bound_coverage &&
                                                   b.reader_bound_table_present &&
                                                   b.reader_bound_groups == 2 && b.reader_files == 2);
      expect("started epoch is still unknown", !b.bind_epoch_known);

      /* The ring fields must arrive separately and unmixed: ready is stock,
       * generating is pending work, held is in flight, and cursor is scheduled
       * import, not completed reads. */
      expect("started ring per group", gb[0].depth == 64 && gb[0].ready == 40 &&
                                       gb[0].generating == 3 && gb[0].held == 2);
      expect("started cursor is per group", gb[0].cursor == 128 && gb[1].cursor == 129);
      expect("started counters read under the flag", b.counters_valid &&
                                                     b.link_pads_used == 201 &&
                                                     b.link_pads_missed == 1 && b.pads_waited == 2);
      expect("started group counters", gb[0].pads_used == 100 && gb[1].pads_used == 101 &&
                                       gb[1].pads_missed == 1);
      expect("started timestamps are absolute and ordered",
             b.mono_valid && b.mono_start_ns > 0 && b.mono_end_ns >= b.mono_start_ns);

      /* Without the flag the counters are withheld even though everything else
       * is observed: the ring state does not depend on the request path. */
      check("started without the counter flag", sh_link_pad_budget(l, &b, 0, iv, IVCAP, gb, GCAP),
            SH_PAD_BUDGET_OK);
      expect("started withholds counters without the flag",
             !b.counters_valid && b.link_pads_used == 0 && gb[0].pads_used == 0);
      expect("started still reports the ring without the flag", gb[0].ready == 40 && gb[0].depth == 64);

      /* Reader busy while pool_mu is free: the LINK half is still observed and
       * only the coverage half is missing. That is the distinction from a
       * pool-busy snapshot, where nothing at all is observed. */
      WITH_HELD(&r->mu, {
          check("reader busy", sh_link_pad_budget(l, &b, SH_PAD_BUDGET_F_REQUEST_PATH_EXCLUDED,
                                                  iv, IVCAP, gb, GCAP), SH_PAD_BUDGET_BUSY);
          expect("reader busy DID observe the link half", b.link_observed);
          expect("reader busy still observed the link", b.dealt && b.threads_running &&
                                                        b.n_groups == 2 && b.written_groups == 2 &&
                                                        b.win_hi == 192);
          expect("reader busy observed no coverage", b.n_intervals == 0 && b.reader_files == 0 &&
                                                     b.reader_bound_groups == 0 &&
                                                     !b.reader_bound_table_present &&
                                                     !b.intervals_are_bound_coverage);
          expect("reader busy claims no epoch", !b.bind_epoch_known);
      });
      check("reader busy is transient", sh_link_pad_budget(l, &b, 0, iv, IVCAP, gb, GCAP), SH_PAD_BUDGET_OK);

      /* Pool busy: nothing at all, and never an empty ring. */
      WITH_HELD(&l->pool_mu, {
          check("pool busy", sh_link_pad_budget(l, &b, SH_PAD_BUDGET_F_REQUEST_PATH_EXCLUDED,
                                                iv, IVCAP, gb, GCAP), SH_PAD_BUDGET_BUSY);
          expect("pool busy did NOT observe the link half", !b.link_observed);
          expect("pool busy observed nothing", b.written_groups == 0 && b.n_intervals == 0 &&
                                               b.n_groups == 0 && b.reader_files == 0 &&
                                               !b.dealt && !b.threads_running);
          expect("pool busy is still timed", b.mono_valid && b.mono_end_ns >= b.mono_start_ns);
      });
      check("pool busy is transient", sh_link_pad_budget(l, &b, 0, iv, IVCAP, gb, GCAP), SH_PAD_BUDGET_OK);

      /* Interval capacity is refused at the link level too, and refusing
       * coverage does not blank the link or the ring. */
      check("started interval capacity", sh_link_pad_budget(l, &b, 0, iv, 0, gb, GCAP),
            SH_PAD_BUDGET_INCOMPLETE);
      expect("interval capacity keeps the link half", b.written_groups == 2 && gb[0].ready == 40);
      expect("interval capacity claims no coverage", b.n_intervals == 0 &&
                                                     !b.intervals_are_bound_coverage);
      sh_link_close(l); }          /* frees the fabricated rings and the reader */

    /* A started link whose reader is in the failed-rebind state: the link is
     * fine, the binding is not, and the diagnostic must say so rather than
     * report coverage. */
    { sh_link *l = open_link(1);
      sh_pads_reader *r = mk_reader(1, 5, 0);          /* count without a table */
      put(r, 0, 0, 16);
      fabricate_started(l, r, 32, 8, 0, 0, 16);
      check("started, failed rebind", sh_link_pad_budget(l, &b, 0, iv, IVCAP, gb, GCAP),
            SH_PAD_BUDGET_BIND_INVALID);
      expect("failed rebind keeps the link half", b.dealt && b.threads_running &&
                                                  b.written_groups == 2 && gb[0].ready == 8);
      expect("failed rebind reports no table", !b.reader_bound_table_present);
      expect("failed rebind keeps the stale count", b.reader_bound_groups == 5);
      expect("failed rebind keeps extents but not coverage",
             b.n_intervals == 1 && iv[0].lo == 0 && iv[0].hi == 16 &&
             !b.intervals_are_bound_coverage);
      sh_link_close(l); }

    /* A started link with an unbound reader: extents, no coverage claim. */
    { sh_link *l = open_link(1);
      sh_pads_reader *r = mk_reader(1, 0, 0);
      put(r, 0, 0, 8);
      fabricate_started(l, r, 16, 4, 0, 0, 0);
      check("started, unbound reader", sh_link_pad_budget(l, &b, 0, iv, IVCAP, gb, GCAP),
            SH_PAD_BUDGET_UNBOUND);
      expect("unbound reader keeps extents", b.n_intervals == 1 && !b.intervals_are_bound_coverage);
      sh_link_close(l); }

    if (failures) { fprintf(stderr, "\n%d FAILURE(S)\n", failures); return 1; }
    printf("\npad_budget_link_fixture: all checks passed\n");
    return 0;
}
