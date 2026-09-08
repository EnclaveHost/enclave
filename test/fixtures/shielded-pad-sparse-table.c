#include "../../wasm/ggml-shielded/shielded-pad-manifest.h"
#include <assert.h>
#include <stdlib.h>

static int fail_alloc;
static void *table_calloc(size_t n, size_t size) {
    return fail_alloc ? NULL : calloc(n, size);
}
#define calloc table_calloc
#include "../../wasm/ggml-shielded/shielded-pad-sparse-table.h"
#undef calloc

static sh_pads_manifest make(sh_pads_manifest_group *g, sh_pads_member *m, uint32_t n) {
    memset(g, 0, n * sizeof *g); memset(m, 0, n * sizeof *m);
    for (uint32_t i = 0; i < n; i++) {
        snprintf(m[i].name, sizeof m[i].name, "group.%u", i); m[i].N = 3 + i;
        strcpy(g[i].identity.name, m[i].name);
        g[i].identity.group = i; g[i].identity.K = 16 + i;
        g[i].identity.u_len = m[i].N; g[i].member0 = i; g[i].member_count = 1;
    }
    sh_pads_manifest result; memset(&result, 0, sizeof result);
    result.groups = g; result.members = m; result.group_count = n; result.member_count = n;
    memset(result.model_digest, 1, 32); memset(result.calib_digest, 2, 32);
    memset(result.encoding_digest, 3, 32);
    return result;
}

static void refuses(const sh_pads_manifest *m, const uint8_t *table, size_t bytes,
        uint64_t lo, uint64_t hi, uint64_t cap, size_t capacity) {
    sh_pads_span spans[3], before[3]; uint64_t offsets[3], old_offsets[3];
    sh_pads_sparse_extent extent, old_extent;
    memset(spans, 0xa5, sizeof spans); memcpy(before, spans, sizeof spans);
    memset(offsets, 0x7e, sizeof offsets); memcpy(old_offsets, offsets, sizeof offsets);
    memset(&extent, 0xb9, sizeof extent); old_extent = extent;
    assert(sh_pads_sparse_table_decode(m, table, bytes, lo, hi, cap,
                spans, offsets, capacity, &extent) != SH_OK);
    assert(!memcmp(spans, before, sizeof spans));
    assert(!memcmp(offsets, old_offsets, sizeof offsets));
    assert(!memcmp(&extent, &old_extent, sizeof extent));
}

int main(void) {
    sh_pads_manifest_group groups[3]; sh_pads_member members[3];
    sh_pads_manifest manifest = make(groups, members, 3);
    sh_pads_span spans[3] = {{7, 2}, {0, 0}, {9, 3}}, decoded[3];
    uint64_t offsets[3], recovered[3]; sh_pads_sparse_extent extent, found;
    /* Deliberately unaligned byte storage; no native-struct loads are legal. */
    uint8_t storage[290], original[288]; uint8_t *table = storage + 1;
    storage[0] = 0x5a; storage[289] = 0xa5;
    assert(sh_pads_sparse_table_encode(&manifest, spans, 7, 20, 4239,
                table, 288, offsets, 3, &extent) == SH_OK);
    assert(extent.data_off == 4096 && extent.file_bytes == 4239 && extent.cells == 5);
    assert(offsets[0] == 4096 && offsets[1] == 4146 && offsets[2] == 4146);
    assert(storage[0] == 0x5a && storage[289] == 0xa5);
    memcpy(original, table, sizeof original);
    printf("table "); for (size_t i = 0; i < 288; i++) printf("%02x", table[i]); puts("");
    assert(sh_pads_sparse_table_decode(&manifest, table, 288, 7, 20, 4239,
                decoded, recovered, 3, &found) == SH_OK);
    assert(!memcmp(spans, decoded, sizeof spans) && !memcmp(offsets, recovered, sizeof offsets));
    assert(!memcmp(&extent, &found, sizeof extent));

    /* Exact length precedes any table read, including near-SIZE_MAX lengths. */
    for (size_t size = 0; size < 288; size++) refuses(&manifest, table, size, 7, 20, 4239, 3);
    refuses(&manifest, table, 289, 7, 20, 4239, 3);
    refuses(&manifest, table, SIZE_MAX, 7, 20, 4239, 3);
    refuses(&manifest, table, 288, 7, 20, 4238, 3);
    refuses(&manifest, table, 288, 8, 20, 4239, 3);
    refuses(&manifest, table, 288, 7, 11, 4239, 3);
    refuses(&manifest, table, 288, 7, SH_PADS_INDEX_LIMIT + 1, 4239, 3);
    refuses(&manifest, table, 288, 7, 20, 4239, 2);
    refuses(NULL, table, 288, 7, 20, 4239, 3);
    refuses(&manifest, NULL, 288, 7, 20, 4239, 3);

    /* Every identity byte is pinned, including zero padding and empty groups. */
    for (unsigned group = 0; group < 3; group++) for (unsigned i = 0; i < 80; i++) {
        table[group * 96 + i] ^= 0x80;
        refuses(&manifest, table, 288, 7, 20, 4239, 3);
        table[group * 96 + i] ^= 0x80;
    }
    memcpy(table, original + 96, 96); memcpy(table + 96, original, 96);
    refuses(&manifest, table, 288, 7, 20, 4239, 3); memcpy(table, original, 288);
    memset(table + 88, 0xff, 8); refuses(&manifest, table, 288, 7, 20, UINT64_MAX, 3);
    refuses(&manifest, table, 288, 7, 20, INT64_MAX, 3); memcpy(table, original, 288);
    table[96 + 80] = 1; refuses(&manifest, table, 288, 7, 20, 4239, 3); memcpy(table, original, 288);
    groups[2].identity.group = 1; refuses(&manifest, table, 288, 7, 20, 4239, 3);
    groups[2].identity.group = 2;
    manifest.group_count = SH_PADS_MANIFEST_MAX_GROUPS + 1;
    refuses(&manifest, table, 288, 7, 20, 4239, 3); manifest.group_count = 3;
    fail_alloc = 1; refuses(&manifest, table, 288, 7, 20, 4239, 3);
    assert(sh_pads_sparse_table_encode(&manifest, spans, 7, 20, 4239,
                table, 288, recovered, 3, &found) == SH_ERR_NOMEM);
    fail_alloc = 0;
    assert(!memcmp(table, original, 288) && !memcmp(recovered, offsets, sizeof offsets));
    assert(!memcmp(&extent, &found, sizeof extent));
    spans[2].count = UINT64_MAX;
    assert(sh_pads_sparse_table_encode(&manifest, spans, 7, 20, 4239,
                table, 288, recovered, 3, &found) != SH_OK);
    assert(!memcmp(table, original, 288) && !memcmp(recovered, offsets, sizeof offsets));
    assert(!memcmp(&extent, &found, sizeof extent));
    memset(spans, 0, sizeof spans);
    assert(sh_pads_sparse_table_encode(&manifest, spans, 7, 20, 4239,
                table, 288, recovered, 3, &found) != SH_OK);
    assert(!memcmp(table, original, 288));

    /* Bounded maximum table, with holes, distinct starts and byte-exact roundtrip. */
    const uint32_t n = SH_PADS_MANIFEST_MAX_GROUPS;
    sh_pads_manifest_group *g = (sh_pads_manifest_group *)calloc(n, sizeof *g);
    sh_pads_member *m = (sh_pads_member *)calloc(n, sizeof *m);
    sh_pads_span *s = (sh_pads_span *)calloc(n, sizeof *s), *d = (sh_pads_span *)calloc(n, sizeof *d);
    uint64_t *o = (uint64_t *)calloc(n, sizeof *o), *r = (uint64_t *)calloc(n, sizeof *r);
    uint8_t *bytes = (uint8_t *)malloc(n * 96), *copy = (uint8_t *)malloc(n * 96);
    assert(g && m && s && d && o && r && bytes && copy);
    sh_pads_manifest large = make(g, m, n);
    for (uint32_t i = 0; i < n; i++) if (i % 3) {s[i].index0 = 50 + i; s[i].count = 1 + i % 7;}
    assert(sh_pads_sparse_table_encode(&large, s, 50, 2048, UINT64_C(1) << 30,
                bytes, n * 96, o, n, &extent) == SH_OK);
    assert(sh_pads_sparse_table_decode(&large, bytes, n * 96, 50, 2048, UINT64_C(1) << 30,
                d, r, n, &found) == SH_OK);
    assert(!memcmp(s, d, n * sizeof *s) && !memcmp(o, r, n * sizeof *o));
    assert(!memcmp(&extent, &found, sizeof extent));
    assert(sh_pads_sparse_table_encode(&large, d, 50, 2048, extent.file_bytes,
                copy, n * 96, r, n, &found) == SH_OK);
    assert(!memcmp(bytes, copy, n * 96));
    free(g); free(m); free(s); free(d); free(o); free(r); free(bytes); free(copy);
    puts("pad-sparse-table: PASS");
    return 0;
}
