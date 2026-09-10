/* Pad-budget diagnostic (SHIELDED_PAD_BUDGET): a bounded, versioned, read-only
 * snapshot of one link's pad supply at one instant.
 *
 * WHAT IT IS. Point-in-time METADATA. It answers "which shipment indices does
 * the bound reader currently cover, how far has each group SCHEDULED imports,
 * and what is in each ring" without decrypting a cell, reserving a window,
 * scanning a directory, binding a reader or pruning a file. It initialises
 * nothing: a process that never brought a backend up reports no cards.
 *
 * WHAT IT IS NOT. Not a certificate and not a feasibility proof. Every field
 * MAY change as soon as the locks are released - refill threads run again the
 * moment a link's pool_mu is dropped, so a multi-card reading is a sequence of
 * per-card observations, never one globally atomic inventory. `cursor` is the
 * next index a group will SCHEDULE for import and advances BEFORE the import
 * succeeds, so it never evidences a completed read; `generating` is visible
 * pending work, not stock; only `ready` is stock; and no field counts
 * successful cell reads. An observed state is not proof of future supply.
 *
 * WHICH HALF WAS OBSERVED. A per-card BUSY can come from the pool mutex, the
 * backend state mutex or the backend pool mutex; all three leave the link
 * fields unread. link_observed says explicitly whether the link half
 * was read; reader_status says the same for the coverage half. A parser must use
 * those two rather than inferring anything from a zero.
 *
 * BUSY IS MISSING EVIDENCE. Every lock is taken with a try-lock, because a
 * link's pool_mu can be held by a refill across a window reserve, an fsync or
 * an HTTP round trip, and a reader mutex can be held across a directory scan
 * and header authentication. A diagnostic must never wait behind those. On
 * contention the status is SH_PAD_BUDGET_BUSY, which means "not observed" and
 * must NEVER be read as an empty bank, an empty ring or absent coverage.
 *
 * A BINDING THAT IS NOT THERE IS NOT A BINDING. sh_pads_reader_bind frees the
 * old group table before allocating the new one and returns SH_ERR_NOMEM if
 * that allocation fails, WITHOUT resetting n_bound, so a reader can be left with
 * a positive n_bound and no table. n_bound alone therefore does not establish
 * that a group set is bound, and this diagnostic checks the table pointer too:
 * that state is reported as SH_PAD_BUDGET_BIND_INVALID and claims no coverage.
 * This is a conservative check on a state that is reachable in the source; it is
 * NOT a report that any such state has ever occurred in production, and it
 * changes no binding behaviour. Like every other field here it is only
 * meaningful under the caller's exclusion of sh_pads_reader_bind, so it detects
 * what a PREVIOUS failed bind left behind, never a concurrent one.
 *
 * UNSTARTED AND UNBOUND ARE NOT EMPTY. A dealt link whose refill threads are
 * not running, and a reader with no bound group set, both still carry real
 * metadata; the status says which, and the metadata is kept rather than blanked.
 * Neither may be read as an empty ring or an empty bank.
 *
 * COVERAGE IS A UNION, NOT A MAXIMUM. `sh_pad_interval`s are the union of the
 * extents of the files the reader holds: half-open [lo,hi), ascending,
 * disjoint and non-adjacent (touching extents merge). A maximum over extents
 * cannot witness membership of an interior index. If the caller's capacity is
 * too small, or a held header's index0+index_count would overflow uint64, the
 * status says so and NOTHING about coverage is claimed; a partial list must
 * never be read as coverage.
 *
 * CALLER OBLIGATIONS. The request path writes pads_used/pads_missed/pads_waited
 * WITHOUT pool_mu, so those are read only when the caller passes
 * SH_PAD_BUDGET_F_REQUEST_PATH_EXCLUDED to assert it holds whatever excludes
 * the request path; otherwise they are left zero with counters_valid false,
 * rather than being read in a data race. The reader pointer and the group array
 * are replaced by start_pools without pool_mu, so the caller must also exclude
 * sh_link_start. In the backend both obligations are sh_state::mu, which
 * sh_card_compute already holds around sh_link_start and around the gemm that
 * writes the counters. A mutex cannot protect against destruction: a caller
 * using the low-level entry point directly must externally exclude every
 * non-refill link API, including close.
 */
#ifndef SHIELDED_PAD_BUDGET_H
#define SHIELDED_PAD_BUDGET_H
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SH_PAD_BUDGET_VERSION      1
#define SH_PAD_BUDGET_NAME_MAX     64

/* Status. Only OK licenses reading the intervals and group records as a
 * complete description of the snapshot instant. */
#define SH_PAD_BUDGET_OK           0
#define SH_PAD_BUDGET_UNAVAILABLE  1   /* no pool, no such card, no link, or the link is not dealt */
#define SH_PAD_BUDGET_INCOMPLETE   2   /* caller capacity exceeded: partial, claims nothing */
#define SH_PAD_BUDGET_INVALID      3   /* a held extent would overflow uint64: claims nothing */
#define SH_PAD_BUDGET_NO_READER    4   /* dealt link that holds no reader yet */
#define SH_PAD_BUDGET_BUSY         5   /* a try-lock failed: NOT OBSERVED, never "empty" */
#define SH_PAD_BUDGET_UNSTARTED    6   /* dealt link whose refill threads are not running */
#define SH_PAD_BUDGET_UNBOUND      7   /* no group set is bound: extents are not coverage */
#define SH_PAD_BUDGET_BIND_INVALID 8   /* n_bound > 0 with no group table: refuse conservatively */

/* A reader holding more input files than this is refused CONSERVATIVELY, before
 * any of them is scanned, even when the merged union would have fitted. A
 * diagnostic gets a finite bound on the work it does under a mutex the pad path
 * needs; it never silently skips a file. */
#define SH_PAD_BUDGET_MAX_FILES 1024u

/* The most intervals one report line may carry. The engine asks for at most
 * this many, so a cover line has a compile-time bound. */
#define SH_PAD_BUDGET_MAX_INTERVALS_PER_LINE 64u

/* Caller assertions. */
#define SH_PAD_BUDGET_F_REQUEST_PATH_EXCLUDED 1u

typedef struct {
    uint64_t lo, hi;               /* half-open [lo, hi); hi > lo always */
} sh_pad_interval;

typedef struct {
    uint32_t group;                /* this link's group ordinal */
    char     name[SH_PAD_BUDGET_NAME_MAX];  /* public: the group's first registered node name */
    int64_t  K, u_len;
    int32_t  depth;                /* ring slots */
    int32_t  ready;                /* g->count: generated and waiting. THE stock */
    int32_t  generating;           /* slots a refill reserved: visible pending work, not stock */
    int32_t  held;                 /* handed to a request in flight */
    uint64_t cursor;               /* next index this group will SCHEDULE for import */
    uint64_t pads_used, pads_missed;   /* valid only when counters_valid */
} sh_pad_group_budget;

typedef struct {
    uint32_t version;              /* SH_PAD_BUDGET_VERSION */
    int32_t  status;
    int32_t  card;                 /* backend card ordinal; -1 when the caller supplied none */
    uint64_t mono_start_ns, mono_end_ns;   /* CLOCK_MONOTONIC around the snapshot */

    bool     dealt, threads_running, stop, pad_integrity_failed;
    bool     counters_valid;       /* the caller asserted the request path was excluded */
    bool     link_observed;        /* the link's pool_mu was actually acquired, so the link half of
                                    * this record was READ. False means it was not: a busy p.mu or
                                    * s.mu, a missing card, a null link or a busy pool_mu all leave
                                    * the link fields at their zero placeholders, and a status of
                                    * BUSY alone does not say which. Never read a zero here as an
                                    * observation. reader_status carries the coverage half
                                    * separately, so link_observed=1 with reader_status=busy is a
                                    * read link whose coverage was not taken. */
    bool     mono_valid;           /* false when CLOCK_MONOTONIC failed: the times mean NOTHING */
    uint64_t pad_window, win_lo, win_hi;   /* the reserved ledger window */
    uint64_t link_pads_used, link_pads_missed, pads_waited;   /* valid only when counters_valid */

    int32_t  reader_status;        /* the coverage half alone; BUSY here means coverage not observed */
    uint64_t reader_files;         /* files the reader held at the snapshot */
    uint32_t reader_bound_groups;  /* n_bound as read; see reader_bound_table_present */
    bool     reader_bound_table_present;   /* the group table pointer was non-NULL. With
                                            * reader_bound_groups this separates a real binding
                                            * with zero files (valid empty coverage, status OK)
                                            * from no binding at all (UNBOUND) and from a failed
                                            * rebind (BIND_INVALID). */
    uint64_t bind_epoch;           /* sh_pads_reader_bind entries; see bind_epoch_known */
    bool     bind_epoch_known;

    uint32_t n_intervals;          /* intervals written; 0 unless the scan completed (OK, UNBOUND or BIND_INVALID) */
    bool     intervals_are_bound_coverage;  /* false on UNBOUND: raw extents, not coverage for the
                                             * registered groups, because file_bind's guarantee that
                                             * every retained file carries every bound group only
                                             * holds once a group set is bound */
    uint32_t cap_intervals;
    uint32_t n_groups;             /* the link's group count, even when it exceeds cap_groups */
    uint32_t cap_groups;
    uint32_t written_groups;       /* group records actually written */
} sh_pad_budget;

#ifdef __cplusplus
}
#endif
#endif
