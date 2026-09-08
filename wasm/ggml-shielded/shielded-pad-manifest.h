#ifndef SHIELDED_PAD_MANIFEST_H
#define SHIELDED_PAD_MANIFEST_H

#include "shielded-pad-layout.h"
#include "shielded-sha256.h"

/* Preparatory v3 primitive; no runtime reader/dealer uses this yet.
 * These admission caps bound metadata and quadratic duplicate-name checks.
 * They are deliberately smaller than the PRF namespace, not new PRF limits. */
#define SH_PADS_MANIFEST_MAX_GROUPS 1024u
#define SH_PADS_MANIFEST_MAX_MEMBERS 4096u

typedef struct {
    char name[SH_PADS_NAME_MAX];
    uint64_t N;
} sh_pads_member;

typedef struct {
    sh_pads_group identity;
    uint32_t member0, member_count;
} sh_pads_manifest_group;

typedef struct {
    uint8_t model_digest[32], calib_digest[32], encoding_digest[32];
    const sh_pads_manifest_group *groups;
    const sh_pads_member *members;
    uint32_t group_count, member_count;
} sh_pads_manifest;

static inline int sh_pads_manifest_name(const char name[SH_PADS_NAME_MAX]) {
    const char *end = (const char *)memchr(name, 0, SH_PADS_NAME_MAX);
    if (!end || end == name) return 0;
    for (const char *p = end; p != name + SH_PADS_NAME_MAX; p++)
        if (*p) return 0;
    return 1;
}

/* Inputs are stable private snapshots with arrays of the stated lengths.
 * A valid structure or digest is NOT proof of model identity or provenance.
 * The caller admits the expected full manifest from a trusted source and
 * pins its digest, including the exact integer-encoding profile, to the seed
 * before mint/reserve/use. Digest/signature admission is separate from this
 * function. Names are byte identities with canonical zero padding.
 * Every member occurs once; shared weights must share one canonical group.
 * Partial groups are unsupported and refused, even if their summed N agrees. */
static inline int sh_pads_manifest_validate(const sh_pads_manifest *m) {
    if (!m || !m->groups || !m->members || !m->group_count ||
        m->group_count > SH_PADS_MANIFEST_MAX_GROUPS || !m->member_count ||
        m->member_count > SH_PADS_MANIFEST_MAX_MEMBERS) return SH_ERR_RANGE;
    uint32_t next = 0;
    for (uint32_t i = 0; i < m->group_count; i++) {
        const sh_pads_manifest_group *g = &m->groups[i];
        const sh_pads_group *id = &g->identity;
        if (id->group != i || !id->K || id->K > SH_PADS_K_LIMIT || !id->u_len ||
            id->u_len > (UINT64_C(64) * UINT32_MAX) / 3 ||
            id->u_len > (SIZE_MAX - SH_PADS_CELL_TAG) / 3 ||
            id->u_len > (INT64_MAX - SH_PADS_CELL_TAG) / 3 ||
            !sh_pads_manifest_name(id->name) || g->member0 != next ||
            !g->member_count || g->member_count > m->member_count - next)
            return SH_ERR_RANGE;
        uint64_t sum = 0;
        for (uint32_t j = 0; j < g->member_count; j++) {
            const sh_pads_member *member = &m->members[next + j];
            if (!sh_pads_manifest_name(member->name) || !member->N ||
                member->N > id->u_len - sum) return SH_ERR_RANGE;
            sum += member->N;
            for (uint32_t k = 0; k < next + j; k++)
                if (!memcmp(member->name, m->members[k].name, SH_PADS_NAME_MAX))
                    return SH_ERR_VERIFY;
        }
        if (sum != id->u_len || memcmp(id->name, m->members[next].name, SH_PADS_NAME_MAX))
            return SH_ERR_VERIFY;
        next += g->member_count;
    }
    return next == m->member_count ? SH_OK : SH_ERR_RANGE;
}

static inline void sh_pads_manifest_u64(sha256_ctx *h, uint64_t n) {
    uint8_t le[8];
    for (unsigned i = 0; i < 8; i++) le[i] = (uint8_t)(n >> (8 * i));
    sha_update(h, le, sizeof le);
}

/* Canonical transcript, independent of C padding/endianness:
 * literal domain including final LF (no NUL), three 32-byte identities,
 * group_count/member_count as LE64; then each group: ordinal/K/u_len/
 * member_count as LE64, name[64], then ordered members: name[64], N as LE64.
 * member0 is uniquely implied by contiguous member lists and is not hashed.
 * No seed/ranges here: the grant binds this digest to a fresh seed separately.
 * Output is committed only on success and must not alias any input. */
static inline int sh_pads_manifest_digest(const sh_pads_manifest *m, uint8_t out[32]) {
    if (!out) return SH_ERR_RANGE;
    const int rc = sh_pads_manifest_validate(m);
    if (rc != SH_OK) return rc;
    static const uint8_t domain[] = "enclave-pads-manifest-v3\n";
    sha256_ctx h; sha_init(&h);
    sha_update(&h, domain, sizeof domain - 1);
    sha_update(&h, m->model_digest, 32);
    sha_update(&h, m->calib_digest, 32);
    sha_update(&h, m->encoding_digest, 32);
    sh_pads_manifest_u64(&h, m->group_count);
    sh_pads_manifest_u64(&h, m->member_count);
    for (uint32_t i = 0; i < m->group_count; i++) {
        const sh_pads_manifest_group *g = &m->groups[i];
        sh_pads_manifest_u64(&h, g->identity.group);
        sh_pads_manifest_u64(&h, g->identity.K);
        sh_pads_manifest_u64(&h, g->identity.u_len);
        sh_pads_manifest_u64(&h, g->member_count);
        sha_update(&h, (const uint8_t *)g->identity.name, SH_PADS_NAME_MAX);
        for (uint32_t j = 0; j < g->member_count; j++) {
            const sh_pads_member *member = &m->members[g->member0 + j];
            sha_update(&h, (const uint8_t *)member->name, SH_PADS_NAME_MAX);
            sh_pads_manifest_u64(&h, member->N);
        }
    }
    uint8_t digest[32]; sha_final(&h, digest); memcpy(out, digest, sizeof digest);
    return SH_OK;
}

/* Map complete local groups (in any order, including a proper subset) to
 * immutable full-manifest ordinals. local identity.group is just its local
 * array position. Model/calib/encoding identities and ALL ordered members
 * must agree. Outputs stay unchanged on any failure. Inputs/output must not
 * alias and must remain private/stable through validation and commit. */
static inline int sh_pads_manifest_bind(const sh_pads_manifest *expected,
        const sh_pads_manifest *local, uint32_t *ordinals, size_t capacity) {
    if (!ordinals) return SH_ERR_RANGE;
    int rc = sh_pads_manifest_validate(expected);
    if (rc != SH_OK) return rc;
    rc = sh_pads_manifest_validate(local);
    if (rc != SH_OK) return rc;
    if (capacity < local->group_count) return SH_ERR_RANGE;
    if (local->group_count > expected->group_count ||
        memcmp(expected->model_digest, local->model_digest, 32) ||
        memcmp(expected->calib_digest, local->calib_digest, 32) ||
        memcmp(expected->encoding_digest, local->encoding_digest, 32)) return SH_ERR_VERIFY;
    uint32_t map[SH_PADS_MANIFEST_MAX_GROUPS];
    for (uint32_t i = 0; i < local->group_count; i++) {
        const sh_pads_manifest_group *l = &local->groups[i];
        uint32_t j = 0;
        for (; j < expected->group_count; j++)
            if (!memcmp(l->identity.name, expected->groups[j].identity.name, SH_PADS_NAME_MAX)) break;
        if (j == expected->group_count) return SH_ERR_VERIFY;
        const sh_pads_manifest_group *e = &expected->groups[j];
        if (l->identity.K != e->identity.K || l->identity.u_len != e->identity.u_len ||
            l->member_count != e->member_count) return SH_ERR_VERIFY;
        for (uint32_t k = 0; k < l->member_count; k++) {
            const sh_pads_member *lm = &local->members[l->member0 + k];
            const sh_pads_member *em = &expected->members[e->member0 + k];
            if (lm->N != em->N || memcmp(lm->name, em->name, SH_PADS_NAME_MAX)) return SH_ERR_VERIFY;
        }
        map[i] = j;
    }
    memcpy(ordinals, map, local->group_count * sizeof *ordinals);
    return SH_OK;
}
#endif
