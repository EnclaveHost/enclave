#include "../../wasm/ggml-shielded/shielded-tee.c"
#include "../../wasm/ggml-shielded/tweetnacl.h"
#include <assert.h>
#include <fcntl.h>
#include <sys/stat.h>

enum { K = 32, COUNT = 2, FIRST = 7, GROUPS = 3 };
static const char *names[GROUPS] = {"a.weight", "b.weight", "c.weight"};
static int8_t weights[GROUPS][K * 8];
static const int widths[GROUPS] = {3, 8, 5};
static uint8_t seed[32], seed_id[16], digest[32], sk[32], pk[32];

static int window_calls;
static int first_window(void *ctx, uint64_t want, uint64_t *lo, uint64_t *hi) {
    (void)ctx; (void)want;
    window_calls++; *lo = FIRST; *hi = FIRST + COUNT; return SH_OK;
}

static void retired(sh_link *l) {
    uint64_t verify = 0, before_pads = 0, after_pads = 0, exchanges = 0;
    sh_link_stats(l, &exchanges, NULL, &verify); assert(verify == 1 && exchanges == 0);
    sh_link_pool_stats(l, &before_pads, NULL);
    const int windows = window_calls;
    int64_t x[K] = {0}, y[8], *out = y; int node = 0;
    for (int i = 0; i < 8; i++) y[i] = 9191;
    assert(sh_link_gemm(l, &node, 1, x, 1, &out) == SH_ERR_VERIFY);
    assert(sh_link_gemm_local(l, &node, 1, x, 1, &out) == SH_ERR_VERIFY);
    assert(sh_link_start(l) == SH_ERR_VERIFY);
    assert(sh_link_add_weight(l, "later", weights[0], K, 3, 1, -1) == SH_ERR_VERIFY);
    int32_t r[K] = {0}, u[8] = {0};
    assert(sh_link_dealt_selftest(l, 1, r, u) == SH_ERR_VERIFY);
    assert(start_pools(l) == SH_ERR_VERIFY); // stop/join does not clear retirement
    uint32_t ng = 99, nm = 98;
    assert(sh_link_manifest_geometry(l, NULL, 0, NULL, 0, &ng, &nm) == SH_ERR_VERIFY);
    assert(ng == 99 && nm == 98);
    assert(window_calls == windows);
    sh_link_stats(l, &exchanges, NULL, &verify); assert(verify == 1 && exchanges == 0);
    sh_link_pool_stats(l, &after_pads, NULL); assert(after_pads == before_pads);
    for (int i = 0; i < 8; i++) assert(y[i] == 9191);
}

static void write_shipment(const char *path, const int *order, uint64_t first) {
    sh_pads_group table[GROUPS] = {0};
    for (int g = 0; g < GROUPS; g++) {
        int id = order[g];
        snprintf(table[g].name, sizeof table[g].name, "%s", names[id]);
        table[g].K = K; table[g].u_len = widths[id];
    }
    int err = 0;
    sh_pads_writer *w = sh_pads_writer_open(path, digest, seed_id, table, GROUPS,
                                          first, COUNT, pk, &err);
    assert(w && err == SH_OK);
    for (uint64_t index = first; index < first + COUNT; index++) {
        for (int g = 0; g < GROUPS; g++) {
            int32_t r[K], u[8]; int id = order[g];
            sh_pad_r(seed, g, index, K, r);
            for (int j = 0; j < widths[id]; j++) {
                int64_t acc = 0;
                for (int k = 0; k < K; k++) acc += (int64_t)r[k] * weights[id][j*K+k];
                u[j] = sh_balanced(acc);
            }
            assert(sh_pads_writer_cell(w, index, g, u) == SH_OK);
        }
    }
    assert(sh_pads_writer_close(w) == SH_OK);
}

static sh_link *consumer(const char *dir, const int *order, int n) {
    int err = 0;
    sh_link *l = sh_link_open("127.0.0.1", 1, true, &err);
    assert(l && err == SH_OK);
    for (int g = 0; g < n; g++) {
        int id = order[g];
        // B is a real shared-input group with two members in dealer order.
        int node = sh_link_add_weight(l, names[id], weights[id], K, id == 1 ? 3 : widths[id], COUNT, -1);
        assert(node >= 0);
        if (id == 1) assert(sh_link_add_weight(l, "b.up.weight", weights[id] + 3*K, K, 5, COUNT, node) >= 0);
    }
    l->dealt = true; memcpy(l->pad_seed, seed, 32);
    l->pads = sh_pads_reader_open(dir, seed_id, sk, &err);
    assert(l->pads && err == SH_OK);
    sh_pads_reader_require_digest(l->pads, digest);
    sh_pads_group table[GROUPS] = {0};
    assert(sh_link_group_table(l, table, GROUPS) == n);
    assert(sh_pads_reader_bind(l->pads, table, n) == SH_OK);
    return l;
}

static void verify_import(sh_link *l, const int *local_order, int n, const int *shipment_order, uint64_t first) {
    for (int g = 0; g < n; g++) {
        int ordinal = 0;
        while (shipment_order[ordinal] != local_order[g]) ordinal++;
        int32_t r[COUNT*K], u[COUNT*8], expected[K];
        assert(dealt_import(l, &l->groups[g], g, first, COUNT, r, u) == SH_OK);
        for (int i = 0; i < COUNT; i++) {
            sh_pad_r(seed, ordinal, first+i, K, expected);
            assert(!memcmp(r+i*K, expected, sizeof expected));
            uint32_t selected = UINT32_MAX; int32_t again[8];
            assert(sh_pads_reader_cell_ordinal(l->pads, g, first+i, again, &selected) == SH_OK);
            assert(selected == (uint32_t)ordinal);
            assert(!memcmp(again, u+i*widths[local_order[g]], widths[local_order[g]]*sizeof *again));
            assert(sh_pads_reader_cell(l->pads, g, first+i, again) == SH_OK);
        }
    }
}

static void verify_manifest_export(sh_link *full, sh_link *subset) {
    sh_pads_manifest_group groups[3], subgroups[3], saved_groups[3];
    sh_pads_member members[4], submembers[4], saved_members[4];
    uint32_t ng = 99, nm = 98;
    assert(sh_link_manifest_geometry(full, NULL, 0, NULL, 0, &ng, &nm) == SH_OK);
    assert(ng == 3 && nm == 4);
    memset(groups, 0xa5, sizeof groups); memset(members, 0xa5, sizeof members);
    memcpy(saved_groups, groups, sizeof groups); memcpy(saved_members, members, sizeof members);
    ng = 99; nm = 98;
    assert(sh_link_manifest_geometry(full, groups, 2, members, 4, &ng, &nm) == SH_ERR_RANGE);
    assert(ng == 99 && nm == 98);
    assert(!memcmp(groups, saved_groups, sizeof groups) && !memcmp(members, saved_members, sizeof members));
    assert(sh_link_manifest_geometry(full, groups, 3, members, 4, &ng, &nm) == SH_OK);
    assert(ng == 3 && nm == 4);
    // full was registered in order c, b, a; b has two output segments.
    assert(!strcmp(groups[0].identity.name, "c.weight"));
    assert(groups[1].member0 == 1 && groups[1].member_count == 2);
    assert(!strcmp(members[1].name, "b.weight") && members[1].N == 3);
    assert(!strcmp(members[2].name, "b.up.weight") && members[2].N == 5);
    sh_pads_manifest canonical = {0}, local = {0};
    canonical.groups = groups; canonical.members = members; canonical.group_count = ng; canonical.member_count = nm;
    assert(sh_link_manifest_geometry(subset, subgroups, 3, submembers, 4, &ng, &nm) == SH_OK);
    local.groups = subgroups; local.members = submembers; local.group_count = ng; local.member_count = nm;
    uint32_t ordinal = 99;
    assert(sh_pads_manifest_bind(&canonical, &local, &ordinal, 1) == SH_OK && ordinal == 1);

    // Faults in actual registration must refuse, never truncate names or
    // serialize a member layout inconsistent with the u offsets used at run time.
    memcpy(saved_groups, groups, sizeof groups); memcpy(saved_members, members, sizeof members);
    ng = 99; nm = 98;
    full->nodes[2].u_off++;
    assert(sh_link_manifest_geometry(full, groups, 3, members, 4, &ng, &nm) == SH_ERR_RANGE);
    full->nodes[2].u_off--;
    char saved_name[sizeof full->nodes[2].name]; memcpy(saved_name, full->nodes[2].name, sizeof saved_name);
    memset(full->nodes[2].name, 'x', sizeof full->nodes[2].name);
    assert(sh_link_manifest_geometry(full, groups, 3, members, 4, &ng, &nm) == SH_ERR_RANGE);
    strcpy(full->nodes[2].name, full->nodes[0].name);
    assert(sh_link_manifest_geometry(full, groups, 3, members, 4, &ng, &nm) == SH_ERR_VERIFY);
    memcpy(full->nodes[2].name, saved_name, sizeof saved_name);
    assert(ng == 99 && nm == 98);
    assert(!memcmp(groups, saved_groups, sizeof groups) && !memcmp(members, saved_members, sizeof members));
}

int main(int argc, char **argv) {
    assert(argc == 2);
    setenv("SHIELDED_NO_SIMD", "1", 1); setenv("SHIELDED_PAD_CHECK", "1", 1);
    setenv("SHIELDED_PREP_THREADS", "1", 1);
    setenv("SHIELDED_PAD_WAIT_MS", "100", 1);
    for (int i = 0; i < 32; i++) { seed[i] = i+11; sk[i] = i+53; digest[i] = i+97; }
    for (int i = 0; i < 16; i++) seed_id[i] = i+5;
    crypto_scalarmult_base(pk, sk);
    for (int g = 0; g < GROUPS; g++) for (int i = 0; i < K*widths[g]; i++)
        weights[g][i] = (int8_t)((i*7+g*11)%31-15);
    char first[1024], second[1024];
    snprintf(first, sizeof first, "%s/first.pads", argv[1]);
    snprintf(second, sizeof second, "%s/second.pads", argv[1]);
    int a[GROUPS] = {0, 1, 2}, b[GROUPS] = {2, 0, 1}, reverse[GROUPS] = {2, 1, 0};
    write_shipment(first, a, FIRST); write_shipment(second, b, FIRST+COUNT);
    // Reproduce the 27B dealer/consumer mismatch: all target files exist and
    // their headers open, but the consumer also registered an MTP head group.
    // Fail before connecting/uploading/reserving, name the binding failure,
    // preserve delivered files, and retire this registration rather than retry.
    sh_link *missing_head = consumer(argv[1], a, GROUPS);
    assert(sh_link_add_weight(missing_head, "blk.64.nextn.eh_proj.weight", weights[0], K, 3, COUNT, -1) >= 0);
    sh_link_set_window_provider(missing_head, first_window, NULL);
    assert(sh_link_start(missing_head) == SH_ERR_VERIFY);
    assert(!missing_head->pipe && window_calls == 0);
    assert(strstr(sh_link_last_error(missing_head), "complete registered groups"));
    assert(access(first, F_OK) == 0 && access(second, F_OK) == 0);
    retired(missing_head); sh_link_close(missing_head);

    // An empty initial bank remains allowed. A file delivered later is judged
    // on the next bind (e.g. after upload), including its missing head group.
    char late_dir[512], late_path[600];
    snprintf(late_dir, sizeof late_dir, "%s/late", argv[1]); assert(mkdir(late_dir, 0700) == 0);
    int late_err = 0;
    sh_pads_reader *late = sh_pads_reader_open(late_dir, seed_id, sk, &late_err);
    assert(late && late_err == SH_OK);
    sh_pads_group head_group = {0}; head_group.K = K; head_group.u_len = 3;
    strcpy(head_group.name, "blk.64.nextn.eh_proj.weight");
    assert(sh_pads_reader_bind(late, &head_group, 1) == SH_OK);
    snprintf(late_path, sizeof late_path, "%s/late.pads", late_dir); write_shipment(late_path, a, FIRST);
    assert(sh_pads_reader_bind(late, &head_group, 1) == SH_ERR_VERIFY);
    assert(access(late_path, F_OK) == 0);
    sh_pads_reader_close(late); assert(unlink(late_path) == 0 && rmdir(late_dir) == 0);

    sh_link *l = consumer(argv[1], reverse, GROUPS);
    verify_import(l, reverse, GROUPS, a, FIRST);
    verify_import(l, reverse, GROUPS, b, FIRST+COUNT);
    // A different registration order and subset must work with the SAME files.
    int subset[1] = {1}; sh_link *s = consumer(argv[1], subset, 1);
    verify_manifest_export(l, s);
    verify_import(s, subset, 1, a, FIRST);
    verify_import(s, subset, 1, b, FIRST+COUNT);
    int32_t r[COUNT*K], u[COUNT*8]; uint32_t selected = 19;
    assert(sh_pads_reader_cell_ordinal(l->pads, GROUPS, FIRST, u, &selected) == SH_ERR_RANGE && selected == UINT32_MAX);
    selected = 19;
    assert(sh_pads_reader_cell_ordinal(l->pads, 0, FIRST+2*COUNT, u, &selected) == SH_ERR_EXHAUST && selected == UINT32_MAX);
    // An ordinary missing range does not create an integrity retirement.
    assert(dealt_import(l, &l->groups[0], 0, FIRST+2*COUNT, 1, r, u) == SH_ERR_EXHAUST);
    assert(!sh_integrity_failed(l));
    // The ordinal fix does not relax the private r.W check.
    s->pad_seed[0] ^= 1;
    assert(dealt_import(s, &s->groups[0], 0, FIRST, COUNT, r, u) == SH_ERR_VERIFY);
    s->pad_seed[0] ^= 1; // repairing the source cannot revive the same challenges
    retired(s);
    sh_link_close(s);

    // Exercise the REAL background importer and condition-variable wakeup.
    // The authenticated file is valid, but its u fails the private r.W check.
    sh_link *async = consumer(argv[1], subset, 1);
    async->pad_seed[0] ^= 1;
    async->pool_depth = async->refill_batch = COUNT;
    async->threads_env = 1; async->warm_ms = 1000;
    sh_link_set_window_provider(async, first_window, NULL);
    assert(start_pools(async) == SH_ERR_VERIFY);
    assert(window_calls == 1);
    stop_threads(async);
    assert(!async->stop && !async->threads_running);
    async->pad_seed[0] ^= 1;
    retired(async); sh_link_close(async);
    // Tamper a cell after its header was admitted: no usable ordinal is returned.
    int fd = open(first, O_RDWR); assert(fd >= 0);
    off_t last = lseek(fd, -1, SEEK_END); assert(last > 0);
    uint8_t byte; assert(pread(fd, &byte, 1, last) == 1); byte ^= 1;
    assert(pwrite(fd, &byte, 1, last) == 1); close(fd);
    selected = 19;
    assert(sh_pads_reader_cell_ordinal(l->pads, 0, FIRST+COUNT-1, u, &selected) == SH_ERR_VERIFY && selected == UINT32_MAX);
    assert(dealt_import(l, &l->groups[0], 0, FIRST+COUNT-1, 1, r, u) == SH_ERR_VERIFY);
    retired(l);
    sh_link_close(l); unlink(first); unlink(second);
    puts("pad-ordinal: reordered/subset/shared groups, per-shipment mapping, wrong seed and tampering passed");
}
