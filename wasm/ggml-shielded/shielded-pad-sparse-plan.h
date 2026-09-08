#ifndef SHIELDED_PAD_SPARSE_PLAN_H
#define SHIELDED_PAD_SPARSE_PLAN_H

#include "shielded-pad-manifest.h"
#include <stdlib.h>

/* Missing-delivery planner only; no runtime enables sparse shipments yet.
 * Inputs are stable, disjoint private snapshots. The caller must authenticate
 * demand/reservation and admit coverage under the SAME seed and immutable full
 * manifest before calling. Arbitrary interval metadata is not delivery proof.
 * Already minted/published coverage can avoid duplicate minting, but is not
 * evidence of VM delivery; those are separate caller-owned coverage sets.
 * This function never authorizes consumption or updates any ledger/cursor.
 *
 * One desired span per canonical group. Coverage may be unsorted, duplicated,
 * overlapping or outside current demand, but must contain valid nonempty
 * intervals in the PRF namespace. Empty demand is canonical (0,0). Missing
 * intervals are sorted by (group,index0), disjoint and maximally coalesced.
 * All outputs remain unchanged on refusal. Outputs must not alias any input.
 */
#define SH_PADS_SPARSE_MAX_COVERAGE 4096u

typedef struct {
    uint32_t group;
    uint64_t index0, count;
} sh_pads_interval;

typedef struct {
    size_t intervals;
    uint64_t cells, payload_bytes; // AEAD tag + packed u; excludes file metadata
} sh_pads_missing_totals;

static inline int sh_pads_interval_compare(const void *av, const void *bv) {
    const sh_pads_interval *a = (const sh_pads_interval *)av, *b = (const sh_pads_interval *)bv;
    if (a->group != b->group) return a->group < b->group ? -1 : 1;
    if (a->index0 != b->index0) return a->index0 < b->index0 ? -1 : 1;
    return a->count == b->count ? 0 : a->count < b->count ? -1 : 1;
}

static inline int sh_pads_missing_append(sh_pads_interval *out, sh_pads_missing_totals *t,
        uint32_t group, uint64_t lo, uint64_t hi, uint64_t cell_bytes,
        uint64_t max_cells, uint64_t max_payload_bytes) {
    if (lo >= hi) return SH_OK;
    const uint64_t count = hi - lo;
    if (count > max_cells - t->cells || count > (max_payload_bytes - t->payload_bytes) / cell_bytes)
        return SH_ERR_RANGE;
    const sh_pads_interval item = {group, lo, count};
    out[t->intervals++] = item; t->cells += count; t->payload_bytes += count * cell_bytes;
    return SH_OK;
}

static inline int sh_pads_sparse_missing(const sh_pads_manifest *expected,
        const sh_pads_span *demand, size_t demand_count,
        uint64_t reserved_lo, uint64_t reserved_hi,
        const sh_pads_interval *coverage, size_t coverage_count,
        uint64_t max_cells, uint64_t max_payload_bytes,
        sh_pads_interval *missing, size_t capacity, sh_pads_missing_totals *totals) {
    if (!demand || (!coverage && coverage_count) || (!missing && capacity) || !totals ||
        coverage_count > SH_PADS_SPARSE_MAX_COVERAGE ||
        reserved_lo >= reserved_hi || reserved_hi > SH_PADS_INDEX_LIMIT ||
        !max_cells || !max_payload_bytes || max_payload_bytes > INT64_MAX)
        return SH_ERR_RANGE;
    int rc = sh_pads_manifest_validate(expected);
    if (rc != SH_OK) return rc;
    if (demand_count != expected->group_count) return SH_ERR_VERIFY;
    for (size_t g = 0; g < demand_count; g++) {
        const sh_pads_span *s = &demand[g];
        if (!s->count) { if (s->index0) return SH_ERR_RANGE; continue; }
        if (s->index0 < reserved_lo || s->index0 >= reserved_hi || s->count > reserved_hi - s->index0)
            return SH_ERR_RANGE;
    }
    for (size_t i = 0; i < coverage_count; i++) {
        const sh_pads_interval *s = &coverage[i];
        if (s->group >= expected->group_count || !s->count || s->index0 >= SH_PADS_INDEX_LIMIT ||
            s->count > SH_PADS_INDEX_LIMIT - s->index0) return SH_ERR_RANGE;
    }
    /* A group's c coverage intervals cut its demand into at most c+1 gaps.
     * Both counts are already bounded; no allocation uses output capacity or
     * an unchecked serialized count. Scratch remains below 256 KiB at caps. */
    const size_t gap_cap = demand_count + coverage_count;
    const size_t slots = gap_cap + coverage_count;
    if (slots > SIZE_MAX / sizeof(sh_pads_interval)) return SH_ERR_RANGE;
    sh_pads_interval *scratch = (sh_pads_interval *)calloc(slots, sizeof *scratch);
    if (!scratch) return SH_ERR_NOMEM;
    sh_pads_interval *sorted = scratch + gap_cap;
    if (coverage_count) {
        memcpy(sorted, coverage, coverage_count * sizeof *sorted);
        qsort(sorted, coverage_count, sizeof *sorted, sh_pads_interval_compare);
    }
    sh_pads_missing_totals t = {0,0,0};
    size_t at = 0;
    for (uint32_t g = 0; g < expected->group_count && rc == SH_OK; g++) {
        const uint64_t hi = demand[g].index0 + demand[g].count;
        uint64_t cursor = demand[g].index0;
        const uint64_t bytes = SH_PADS_CELL_TAG + 3 * expected->groups[g].identity.u_len;
        while (at < coverage_count && sorted[at].group == g) {
            const sh_pads_interval *s = &sorted[at++];
            const uint64_t end = s->index0 + s->count;
            if (cursor >= hi || end <= cursor || s->index0 >= hi) continue;
            const uint64_t begin = s->index0 > cursor ? s->index0 : cursor;
            rc = sh_pads_missing_append(scratch, &t, g, cursor, begin, bytes, max_cells, max_payload_bytes);
            if (rc != SH_OK) break;
            cursor = end < hi ? end : hi;
        }
        if (rc == SH_OK)
            rc = sh_pads_missing_append(scratch, &t, g, cursor, hi, bytes, max_cells, max_payload_bytes);
    }
    if (rc == SH_OK && t.intervals > capacity) rc = SH_ERR_RANGE;
    if (rc == SH_OK) {
        if (t.intervals) memcpy(missing, scratch, t.intervals * sizeof *missing);
        *totals = t;
    }
    free(scratch);
    return rc;
}
#endif
