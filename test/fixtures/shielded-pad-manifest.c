#include "../../wasm/ggml-shielded/shielded-pad-manifest.h"
#include <assert.h>

static sh_pads_manifest make(sh_pads_manifest_group groups[3], sh_pads_member members[5]) {
    memset(groups, 0, 3 * sizeof *groups);
    memset(members, 0, 5 * sizeof *members);
    const char *names[] = {"a.weight", "a.aux", "b.weight", "c.weight", "c.aux"};
    const unsigned widths[] = {3, 5, 7, 11, 13};
    for (unsigned i = 0; i < 5; i++) {
        strcpy(members[i].name, names[i]); members[i].N = widths[i];
    }
    const unsigned first[] = {0, 2, 3}, count[] = {2, 1, 2}, total[] = {8, 7, 24};
    for (unsigned i = 0; i < 3; i++) {
        groups[i].identity.group = i; groups[i].identity.K = 2 + i;
        groups[i].identity.u_len = total[i];
        strcpy(groups[i].identity.name, names[first[i]]);
        groups[i].member0 = first[i]; groups[i].member_count = count[i];
    }
    sh_pads_manifest m; memset(&m, 0, sizeof m);
    memset(m.model_digest, 1, 32); memset(m.calib_digest, 2, 32); memset(m.encoding_digest, 3, 32);
    m.groups = groups; m.members = members; m.group_count = 3; m.member_count = 5;
    return m;
}

static void invalid(const sh_pads_manifest *m) {
    uint8_t out[32], saved[32]; memset(out, 0xa5, sizeof out); memcpy(saved, out, sizeof out);
    assert(sh_pads_manifest_digest(m, out) != SH_OK);
    assert(!memcmp(out, saved, sizeof out));
}
static void mismatch(const sh_pads_manifest *e, const sh_pads_manifest *l) {
    uint32_t out[3] = {91, 92, 93}, saved[3]; memcpy(saved, out, sizeof out);
    assert(sh_pads_manifest_bind(e, l, out, 3) != SH_OK);
    assert(!memcmp(out, saved, sizeof out));
}

int main(void) {
    sh_pads_manifest_group groups[3], local_groups[3]; sh_pads_member members[5], local_members[5];
    sh_pads_manifest m = make(groups, members), local = make(local_groups, local_members);
    uint8_t digest[32], changed[32]; uint32_t map[3] = {99, 99, 99};
    assert(sh_pads_manifest_digest(&m, digest) == SH_OK);
    printf("digest "); for (unsigned i = 0; i < 32; i++) printf("%02x", digest[i]); puts("");
    assert(sh_pads_manifest_bind(&m, &local, map, 3) == SH_OK);
    for (unsigned i = 0; i < 3; i++) assert(map[i] == i);

    /* Refusing/omitting b and registering c before a does NOT renumber the
     * canonical PRF domains: local indices 0/1 map to canonical ordinals 2/0. */
    local.group_count = 2; local.member_count = 4;
    local_groups[0] = groups[2]; local_groups[0].identity.group = 0; local_groups[0].member0 = 0;
    local_groups[1] = groups[0]; local_groups[1].identity.group = 1; local_groups[1].member0 = 2;
    local_members[0] = members[3]; local_members[1] = members[4];
    local_members[2] = members[0]; local_members[3] = members[1];
    map[2] = 77;
    assert(sh_pads_manifest_bind(&m, &local, map, 3) == SH_OK);
    assert(map[0] == 2 && map[1] == 0 && map[2] == 77);
    assert(sh_pads_manifest_bind(&m, &local, map, 1) == SH_ERR_RANGE);
    assert(map[0] == 2 && map[1] == 0 && map[2] == 77);

    /* Same first name/K/u_len, different ordered members or split of N. */
    strcpy(local_members[1].name, "c.other"); mismatch(&m, &local);
    local_members[1] = members[4]; local_members[0].N++; local_members[1].N--;
    assert(sh_pads_manifest_validate(&local) == SH_OK); mismatch(&m, &local);
    local_members[0] = members[3]; local_members[1] = members[4];
    local_groups[0].identity.K++; mismatch(&m, &local); local_groups[0].identity.K--;
    for (unsigned i = 0; i < 3; i++) {
        uint8_t *id = i == 0 ? local.model_digest : i == 1 ? local.calib_digest : local.encoding_digest;
        id[17] ^= 1; mismatch(&m, &local); id[17] ^= 1;
    }

    /* Every valid identity/geometry change changes the transcript digest. */
    for (unsigned i = 0; i < 3; i++) {
        uint8_t *id = i == 0 ? m.model_digest : i == 1 ? m.calib_digest : m.encoding_digest;
        id[31] ^= 1; assert(sh_pads_manifest_digest(&m, changed) == SH_OK);
        assert(memcmp(changed, digest, 32)); id[31] ^= 1;
    }
    groups[0].identity.K++;
    assert(sh_pads_manifest_digest(&m, changed) == SH_OK && memcmp(changed, digest, 32));
    groups[0].identity.K--;
    members[0].N++; members[1].N--;
    assert(sh_pads_manifest_digest(&m, changed) == SH_OK && memcmp(changed, digest, 32));
    members[0].N--; members[1].N++;
    strcpy(members[1].name, "other.aux");
    assert(sh_pads_manifest_digest(&m, changed) == SH_OK && memcmp(changed, digest, 32));
    memset(members[1].name, 0, sizeof members[1].name); strcpy(members[1].name, "a.aux");

    /* Canonical ordinals, name padding, member coverage and bounded sizes. */
    groups[2].identity.group = 0; invalid(&m); groups[2].identity.group = 2;
    groups[0].member0 = 1; invalid(&m); groups[0].member0 = 0;
    groups[1].member_count = UINT32_MAX; invalid(&m); groups[1].member_count = 1;
    groups[1].member_count = 0; invalid(&m); groups[1].member_count = 1;
    groups[0].identity.K = 0; invalid(&m); groups[0].identity.K = 2;
    groups[0].identity.u_len = UINT64_MAX; invalid(&m); groups[0].identity.u_len = 8;
    groups[0].identity.name[63] = 1; invalid(&m); groups[0].identity.name[63] = 0;
    members[1].name[63] = 1; invalid(&m); members[1].name[63] = 0;
    members[1].N = UINT64_MAX; invalid(&m); members[1].N = 5;
    members[1].N = 0; invalid(&m); members[1].N = 5;
    members[1].N = 4; invalid(&m); members[1].N = 5;
    strcpy(members[4].name, members[1].name); invalid(&m); strcpy(members[4].name, "c.aux");
    strcpy(groups[2].identity.name, "unknown"); invalid(&m); strcpy(groups[2].identity.name, "c.weight");
    m.group_count = 2; invalid(&m); m.group_count = 3;
    m.group_count = SH_PADS_MANIFEST_MAX_GROUPS + 1; invalid(&m); m.group_count = 3;
    m.member_count = SH_PADS_MANIFEST_MAX_MEMBERS + 1; invalid(&m); m.member_count = 5;
    invalid(NULL);
    assert(sh_pads_manifest_digest(&m, NULL) == SH_ERR_RANGE);
    assert(sh_pads_manifest_digest(&m, changed) == SH_OK && !memcmp(changed, digest, 32));

    /* Maximum supported metadata; no unchecked size-driven allocation. */
    sh_pads_manifest_group *large_g = (sh_pads_manifest_group *)calloc(SH_PADS_MANIFEST_MAX_GROUPS, sizeof *large_g);
    sh_pads_member *large_m = (sh_pads_member *)calloc(SH_PADS_MANIFEST_MAX_MEMBERS, sizeof *large_m);
    assert(large_g && large_m);
    sh_pads_manifest large = m; large.groups = large_g; large.members = large_m;
    large.group_count = SH_PADS_MANIFEST_MAX_GROUPS; large.member_count = SH_PADS_MANIFEST_MAX_MEMBERS;
    for (uint32_t i = 0; i < large.member_count; i++) {
        snprintf(large_m[i].name, sizeof large_m[i].name, "member.%u", i); large_m[i].N = 1;
    }
    for (uint32_t i = 0; i < large.group_count; i++) {
        large_g[i].identity.group = i; large_g[i].identity.K = 1; large_g[i].identity.u_len = 4;
        strcpy(large_g[i].identity.name, large_m[4*i].name);
        large_g[i].member0 = 4*i; large_g[i].member_count = 4;
    }
    assert(sh_pads_manifest_digest(&large, changed) == SH_OK);
    strcpy(large_m[large.member_count-1].name, large_m[0].name); invalid(&large);
    free(large_g); free(large_m);
    puts("pad-manifest: PASS");
    return 0;
}
