#ifndef SHIELDED_PAD_LAYOUT_H
#define SHIELDED_PAD_LAYOUT_H

#include "shielded-tee.h"
#include "shielded-pads.h"
#include <limits.h>
#include <string.h>

/* Proposed sparse-v3 layout primitive ONLY. This does not enable a codec,
 * authenticate a manifest, issue a reservation, or authorize a pad use.
 *
 * The future codec uses a 256-byte fixed header and canonical little-endian
 * 96-byte descriptors: the existing 80-byte group identity plus start/count.
 * All canonical groups remain in every table; an empty span is (0,0).
 * Payload is group-major, one AEAD tag + packed int24 u vector per cell.
 */
#define SH_PADS_SPARSE_GROUP_BYTES UINT64_C(96)
#define SH_PADS_SPARSE_ALIGNMENT UINT64_C(4096)

typedef struct {
    uint64_t index0, count;
} sh_pads_span;

typedef struct {
    uint64_t data_off, file_bytes, cells;
} sh_pads_sparse_extent;

/* All inputs must be stable PRIVATE snapshots for this call. The expected
 * table must already be admitted as this seed's immutable canonical manifest,
 * including unique names and ordered member geometry. Reservation bounds must
 * come from the trusted signed-window state; passing numbers is not proof of
 * ownership. The incoming table must have exactly the same canonical identity.
 *
 * Offsets are absolute file positions. Zero spans occupy no bytes and can share
 * an offset. Outputs must not alias inputs, and remain unchanged on failure.
 * max_file_bytes is a mandatory caller policy cap, not an attacker-chosen cap.
 * The codec separately validates exact encoded header/table/padding/file bytes.
 */
static inline int sh_pads_sparse_layout(
        const sh_pads_group *expected, uint32_t expected_count,
        const sh_pads_group *incoming, const sh_pads_span *spans, uint32_t count,
        uint64_t reserved_lo, uint64_t reserved_hi, uint64_t max_file_bytes,
        uint64_t *offsets, size_t offset_capacity, sh_pads_sparse_extent *extent) {
    if (!expected || !incoming || !spans || !offsets || !extent ||
        !expected_count || expected_count >= SH_PADS_GROUP_LIMIT ||
        reserved_lo >= reserved_hi || reserved_hi > SH_PADS_INDEX_LIMIT ||
        !max_file_bytes || max_file_bytes > INT64_MAX || offset_capacity < count)
        return SH_ERR_RANGE;
    if (count != expected_count) return SH_ERR_VERIFY;

    const uint64_t metadata = SH_PADS_HDR_BYTES + (uint64_t)count * SH_PADS_SPARSE_GROUP_BYTES;
    const uint64_t start = (metadata + SH_PADS_SPARSE_ALIGNMENT - 1) & ~(SH_PADS_SPARSE_ALIGNMENT - 1);
    if (start > max_file_bytes) return SH_ERR_RANGE;
    uint64_t end = start, cells = 0;
    for (uint32_t g = 0; g < count; g++) {
        const sh_pads_group *e = &expected[g], *in = &incoming[g];
        if (e->group != g || !e->K || e->K > SH_PADS_K_LIMIT || !e->u_len ||
            e->u_len > (UINT64_C(64) * UINT32_MAX) / 3 ||
            e->u_len > (SIZE_MAX - SH_PADS_CELL_TAG) / 3 ||
            e->u_len > (INT64_MAX - SH_PADS_CELL_TAG) / 3)
            return SH_ERR_RANGE;
        const char *nul = (const char *)memchr(e->name, 0, sizeof e->name);
        if (!nul || nul == e->name) return SH_ERR_RANGE;
        for (const char *p = nul; p != e->name + sizeof e->name; p++)
            if (*p) return SH_ERR_RANGE;  /* canonical zero padding */
        if (in->group != e->group || in->K != e->K || in->u_len != e->u_len ||
            memcmp(in->name, e->name, sizeof e->name)) return SH_ERR_VERIFY;
        const uint64_t lo = spans[g].index0, n = spans[g].count;
        if (!n) {
            if (lo) return SH_ERR_RANGE;
            continue;
        }
        if (lo < reserved_lo || lo >= reserved_hi || n > reserved_hi - lo)
            return SH_ERR_RANGE;
        const uint64_t bytes = SH_PADS_CELL_TAG + 3 * e->u_len;
        if (n > (max_file_bytes - end) / bytes || cells > UINT64_MAX - n)
            return SH_ERR_RANGE;
        end += n * bytes;
        cells += n;
    }
    if (!cells) return SH_ERR_RANGE;  /* never publish a metadata-only shipment */

    /* Commit only after the complete private table passed all checks. */
    uint64_t at = start;
    for (uint32_t g = 0; g < count; g++) {
        offsets[g] = at;
        at += spans[g].count * (SH_PADS_CELL_TAG + 3 * expected[g].u_len);
    }
    const sh_pads_sparse_extent result = {start, end, cells};
    *extent = result;
    return SH_OK;
}
#endif
