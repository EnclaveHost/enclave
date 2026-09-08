#ifndef SHIELDED_PAD_SPARSE_TABLE_H
#define SHIELDED_PAD_SPARSE_TABLE_H

#include "shielded-pad-manifest.h"
#include <stdlib.h>

/* Descriptor-only v3 codec, not a shipment reader or authorization API.
 * Every canonical group occupies 96 bytes, including empty spans:
 *   0: group LE32, 4: K LE32, 8: u_len LE64, 16: name[64],
 *  80: index0 LE64, 88: count LE64.
 * The enclosing authenticated header/manifest pin, canonical file padding,
 * exact file length, key wrapping and cell AEAD are separate responsibilities.
 * No runtime currently admits this format.
 *
 * Inputs are stable private snapshots and all outputs are disjoint from inputs
 * and each other. The expected full manifest and reservation bounds must have
 * been admitted by the trusted caller; well-formed metadata is not provenance.
 * All outputs remain unchanged on any refusal, including allocation failure.
 */

static inline uint64_t sh_pads_table_le(const uint8_t *p, unsigned n) {
    uint64_t value = 0;
    for (unsigned i = 0; i < n; i++) value |= (uint64_t)p[i] << (8 * i);
    return value;
}

static inline void sh_pads_table_put(uint8_t *p, uint64_t value, unsigned n) {
    for (unsigned i = 0; i < n; i++) p[i] = (uint8_t)(value >> (8 * i));
}

/* Storage is bounded by the admitted manifest count, never a serialized count.
 * Heap scratch avoids putting a maximum-sized metadata table on a VM thread's
 * stack. Each region below has a size/alignment divisible by eight. */
typedef struct {
    sh_pads_group *expected, *incoming;
    sh_pads_span *spans;
    uint64_t *offsets;
    sh_pads_sparse_extent extent;
} sh_pads_table_work;

static inline int sh_pads_table_work_open(const sh_pads_manifest *expected,
        size_t table_bytes, size_t capacity, sh_pads_table_work *w) {
    int rc = sh_pads_manifest_validate(expected);
    if (rc != SH_OK) return rc;
    const size_t n = expected->group_count;
    if (table_bytes != n * SH_PADS_SPARSE_GROUP_BYTES || capacity < n)
        return SH_ERR_RANGE;
    const size_t unit = 2 * sizeof(sh_pads_group) + sizeof(sh_pads_span) + sizeof(uint64_t);
    if (n > SIZE_MAX / unit) return SH_ERR_RANGE;
    w->expected = (sh_pads_group *)calloc(n, unit);
    if (!w->expected) return SH_ERR_NOMEM;
    w->incoming = w->expected + n;
    w->spans = (sh_pads_span *)(w->incoming + n);
    w->offsets = (uint64_t *)(w->spans + n);
    for (size_t i = 0; i < n; i++) w->expected[i] = expected->groups[i].identity;
    return SH_OK;
}

static inline int sh_pads_sparse_table_decode(const sh_pads_manifest *expected,
        const uint8_t *table, size_t table_bytes,
        uint64_t reserved_lo, uint64_t reserved_hi, uint64_t max_file_bytes,
        sh_pads_span *spans, uint64_t *offsets, size_t capacity,
        sh_pads_sparse_extent *extent) {
    if (!table || !spans || !offsets || !extent) return SH_ERR_RANGE;
    sh_pads_table_work w;
    int rc = sh_pads_table_work_open(expected, table_bytes, capacity, &w);
    if (rc != SH_OK) return rc;
    const uint32_t n = expected->group_count;
    for (uint32_t i = 0; i < n; i++) {
        const uint8_t *p = table + (size_t)i * SH_PADS_SPARSE_GROUP_BYTES;
        w.incoming[i].group = (uint32_t)sh_pads_table_le(p, 4);
        w.incoming[i].K = (uint32_t)sh_pads_table_le(p + 4, 4);
        w.incoming[i].u_len = sh_pads_table_le(p + 8, 8);
        memcpy(w.incoming[i].name, p + 16, SH_PADS_NAME_MAX);
        w.spans[i].index0 = sh_pads_table_le(p + 80, 8);
        w.spans[i].count = sh_pads_table_le(p + 88, 8);
    }
    rc = sh_pads_sparse_layout(w.expected, n, w.incoming, w.spans, n,
            reserved_lo, reserved_hi, max_file_bytes, w.offsets, n, &w.extent);
    if (rc == SH_OK) {
        memcpy(spans, w.spans, n * sizeof *spans);
        memcpy(offsets, w.offsets, n * sizeof *offsets);
        *extent = w.extent;
    }
    free(w.expected);
    return rc;
}

static inline int sh_pads_sparse_table_encode(const sh_pads_manifest *expected,
        const sh_pads_span *spans,
        uint64_t reserved_lo, uint64_t reserved_hi, uint64_t max_file_bytes,
        uint8_t *table, size_t table_bytes, uint64_t *offsets, size_t capacity,
        sh_pads_sparse_extent *extent) {
    if (!spans || !table || !offsets || !extent) return SH_ERR_RANGE;
    sh_pads_table_work w;
    int rc = sh_pads_table_work_open(expected, table_bytes, capacity, &w);
    if (rc != SH_OK) return rc;
    const uint32_t n = expected->group_count;
    rc = sh_pads_sparse_layout(w.expected, n, w.expected, spans, n,
            reserved_lo, reserved_hi, max_file_bytes, w.offsets, n, &w.extent);
    if (rc == SH_OK) {
        for (uint32_t i = 0; i < n; i++) {
            uint8_t *p = table + (size_t)i * SH_PADS_SPARSE_GROUP_BYTES;
            sh_pads_table_put(p, w.expected[i].group, 4);
            sh_pads_table_put(p + 4, w.expected[i].K, 4);
            sh_pads_table_put(p + 8, w.expected[i].u_len, 8);
            memcpy(p + 16, w.expected[i].name, SH_PADS_NAME_MAX);
            sh_pads_table_put(p + 80, spans[i].index0, 8);
            sh_pads_table_put(p + 88, spans[i].count, 8);
        }
        memcpy(offsets, w.offsets, n * sizeof *offsets);
        *extent = w.extent;
    }
    free(w.expected);
    return rc;
}
#endif
