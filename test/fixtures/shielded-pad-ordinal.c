#include "../../wasm/ggml-shielded/shielded-tee.c"
#include "../../wasm/ggml-shielded/tweetnacl.h"
#include <assert.h>
#include <fcntl.h>

enum { K = 32, COUNT = 2, FIRST = 7, GROUPS = 3 };
static const char *names[GROUPS] = {"a.weight", "b.weight", "c.weight"};
static int8_t weights[GROUPS][K * 8];
static const int widths[GROUPS] = {3, 8, 5};
static uint8_t seed[32], seed_id[16], digest[32], sk[32], pk[32];

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

int main(int argc, char **argv) {
    assert(argc == 2);
    setenv("SHIELDED_NO_SIMD", "1", 1); setenv("SHIELDED_PAD_CHECK", "1", 1);
    setenv("SHIELDED_PREP_THREADS", "1", 1);
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
    sh_link *l = consumer(argv[1], reverse, GROUPS);
    verify_import(l, reverse, GROUPS, a, FIRST);
    verify_import(l, reverse, GROUPS, b, FIRST+COUNT);
    // A different registration order and subset must work with the SAME files.
    int subset[1] = {1}; sh_link *s = consumer(argv[1], subset, 1);
    verify_import(s, subset, 1, a, FIRST);
    verify_import(s, subset, 1, b, FIRST+COUNT);
    int32_t r[COUNT*K], u[COUNT*8]; uint32_t selected = 19;
    assert(sh_pads_reader_cell_ordinal(l->pads, GROUPS, FIRST, u, &selected) == SH_ERR_RANGE && selected == UINT32_MAX);
    selected = 19;
    assert(sh_pads_reader_cell_ordinal(l->pads, 0, FIRST+2*COUNT, u, &selected) == SH_ERR_EXHAUST && selected == UINT32_MAX);
    // The ordinal fix does not relax the private r.W check.
    s->pad_seed[0] ^= 1;
    assert(dealt_import(s, &s->groups[0], 0, FIRST, COUNT, r, u) == SH_ERR_VERIFY);
    sh_link_close(s);
    // Tamper a cell after its header was admitted: no usable ordinal is returned.
    int fd = open(first, O_RDWR); assert(fd >= 0);
    off_t last = lseek(fd, -1, SEEK_END); assert(last > 0);
    uint8_t byte; assert(pread(fd, &byte, 1, last) == 1); byte ^= 1;
    assert(pwrite(fd, &byte, 1, last) == 1); close(fd);
    selected = 19;
    assert(sh_pads_reader_cell_ordinal(l->pads, 0, FIRST+COUNT-1, u, &selected) == SH_ERR_VERIFY && selected == UINT32_MAX);
    assert(dealt_import(l, &l->groups[0], 0, FIRST+COUNT-1, 1, r, u) == SH_ERR_VERIFY);
    sh_link_close(l); unlink(first); unlink(second);
    puts("pad-ordinal: reordered/subset/shared groups, per-shipment mapping, wrong seed and tampering passed");
}
