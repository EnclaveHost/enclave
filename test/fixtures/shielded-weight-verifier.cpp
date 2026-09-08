#include <unistd.h>
static bool corrupt_cache_reads = false;
static ssize_t fault_pread(int fd, void *buffer, size_t bytes, off_t offset) {
    const ssize_t got = pread(fd, buffer, bytes, offset);
    if (corrupt_cache_reads && got > 0) static_cast<unsigned char *>(buffer)[0] ^= 1;
    return got;
}
#define pread fault_pread
#include "../../wasm/ggml-shielded/ggml-shielded.cpp"
#undef pread
#include "ggml-cpu.h"
#include <cassert>
#include <sys/mman.h>

struct source_record { void *mapping; std::vector<uint8_t> bytes; };
struct verifier_state { std::map<std::string, source_record> expected; int calls = 0, reads = 0; bool tamper = false, read_fail = false; };
static int test_window(void *ctx, uint64_t want, uint64_t *lo, uint64_t *hi) {
    (void)ctx; (void)want; *lo = 0; *hi = 8; return SH_OK;
}

static void reject_pad_between_graphs(sh_link *link, const char *dir) {
    sh_pads_group groups[2] = {};
    assert(sh_link_group_table(link, groups, 2) == 1);
    assert(groups[0].K == 32 && groups[0].u_len == 16);
    uint8_t zero[32] = {}, pk[32]; crypto_scalarmult_base(pk, zero);
    const std::string path = std::string(dir) + "/background-integrity.pads";
    int err = 0;
    auto *w = sh_pads_writer_open(path.c_str(), zero, zero, groups, 1, 0, 1, pk, &err);
    assert(w && err == SH_OK);
    int32_t u[16] = {};
    assert(sh_pads_writer_cell(w, 0, 0, u) == SH_OK && sh_pads_writer_close(w) == SH_OK);
    // Alter ciphertext without touching the authenticated header: import must
    // reject deterministically before the mathematical pad check.
    int fd = open(path.c_str(), O_RDWR); assert(fd >= 0);
    const off_t pos = lseek(fd, -1, SEEK_END); assert(pos > 0);
    uint8_t byte; assert(pread(fd, &byte, 1, pos) == 1); byte ^= 1;
    assert(pwrite(fd, &byte, 1, pos) == 1); close(fd);
    sh_link_set_window_provider(link, test_window, nullptr);
    int32_t r[32];
    assert(sh_link_dealt_selftest(link, 1, r, u) == SH_ERR_VERIFY);
    uint64_t failures = 0; sh_link_stats(link, nullptr, nullptr, &failures); assert(failures == 1);
    assert(unlink(path.c_str()) == 0); // deleting the bad file does not undo retirement
}
static void source_stats_check(const verifier_state &state) {
    uint64_t calls = UINT64_MAX, bytes = UINT64_MAX;
    ggml_backend_shielded_weight_source_stats(&calls, &bytes);
    assert(calls == (uint64_t)state.reads);
    assert(bytes == (state.read_fail ? 0 : calls * 8 * 34));
    ggml_backend_shielded_weight_source_stats(nullptr, nullptr);
}
static int read_source(void *opaque, const char *name, uint32_t type, const int64_t ne[4], void *bytes, size_t n) {
    auto &state = *static_cast<verifier_state *>(opaque); state.reads++;
    if (state.read_fail) return SH_ERR_IO;
    auto it = state.expected.find(name);
    if (it == state.expected.end() || type != GGML_TYPE_Q8_0 || ne[0] != 32 || ne[1] != 8 || n != it->second.bytes.size()) return SH_ERR_RANGE;
    memcpy(bytes, it->second.bytes.data(), n);
    if (state.tamper) ((uint8_t *)bytes)[20] ^= 1;
    return SH_OK;
}
static int verify(void *opaque, const char *name, uint32_t type, const int64_t ne[4], const void *bytes, size_t n) {
    auto &state = *static_cast<verifier_state *>(opaque); state.calls++;
    auto it = state.expected.find(name);
    if (it == state.expected.end() || type != GGML_TYPE_Q8_0 || ne[0] != 32 || ne[1] != 8 || ne[2] != 1 || ne[3] != 1)
        return SH_ERR_VERIFY;
    auto &record = it->second;
    assert(bytes != record.mapping);
    if (n != record.bytes.size() || memcmp(bytes, record.bytes.data(), n)) return SH_ERR_VERIFY;
    // Revoke the source during verification: subsequent encoding or CPU
    // fallback must not touch it. Only the verified private copy is usable.
    if (record.mapping) assert(mprotect(record.mapping, 4096, PROT_NONE) == 0);
    return SH_OK;
}

int main(int argc, char **argv) {
    assert(argc == 3); const std::string scenario = argv[2];
    setenv("SHIELDED_WEIGHT_CACHE_DIR", argv[1], 1); setenv("SHIELDED_PAD_SOURCE", argv[1], 1);
    setenv("SHIELDED_PAD_SEED", std::string(64, '0').c_str(), 1);
    setenv("SHIELDED_PAD_SEED_ID", std::string(32, '0').c_str(), 1);
    setenv("SHIELDED_PAD_SK", std::string(64, '0').c_str(), 1);
    setenv("SHIELDED_PAD_CHECK", "1", 1); setenv("SHIELDED_NO_SIMD", "1", 1);
    setenv("SHIELDED_MIN_MACS", "0", 1); setenv("SHIELDED_MAX_M", "16", 1);
    auto *cpu = ggml_backend_cpu_init(); assert(cpu); ggml_backend_cpu_set_n_threads(cpu, 1);
    verifier_state state;
    source_stats_check(state);
    assert(ggml_backend_shielded_set_weight_verifier(nullptr, &state) == SH_ERR_RANGE);
    assert(ggml_backend_shielded_set_weight_verifier(verify, &state) == SH_OK);
    assert(ggml_backend_shielded_set_weight_verifier(verify, &state) == SH_ERR_RANGE);
    sh_pool &p = sh_pool_get(); sh_state &s = *p.cards[0];
    s.configured = s.calib_loaded = true; s.calib_version = 2;
    s.calib["blk.0.ffn_gate.weight"] = {8, {}};
    auto *ctx = ggml_init({1u << 20, nullptr, false}); assert(ctx);
    std::vector<ggml_tensor *> weights;
    std::vector<ggml_backend_buffer_t> source_buffers;
    const bool streamed = scenario.rfind("source", 0) == 0;
    state.tamper = scenario == "source_tamper" || scenario == "source_cpu_tamper";
    state.read_fail = scenario == "source_readfail";
    for (const char *name : {"blk.0.ffn_gate.weight", "blk.0.ffn_up.weight"}) {
        auto *w = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, 32, 8); ggml_set_name(w, name);
        void *mapping = mmap(nullptr, 4096, PROT_READ|PROT_WRITE, MAP_ANONYMOUS|MAP_PRIVATE, -1, 0);
        assert(mapping != MAP_FAILED); w->data = mapping;
        std::vector<float> raw(256);
        for (size_t i = 0; i < raw.size(); i++) raw[i] = (int(i % 11) - 5) / 64.0f;
        ggml_quantize_chunk(GGML_TYPE_Q8_0, raw.data(), mapping, 0, 8, 32, nullptr);
        auto &record = state.expected[name]; record.mapping = mapping;
        record.bytes.assign((uint8_t *)mapping, (uint8_t *)mapping + ggml_nbytes(w));
        if (scenario == "tamper") ((uint8_t *)mapping)[20] ^= 1;
        if (scenario == "shape") { w->ne[0] = 64; w->ne[1] = 4; w->nb[1] *= 2; }
        if (streamed) {
            assert(munmap(mapping, 4096) == 0); record.mapping = nullptr; w->data = nullptr;
            auto *buf = ggml_backend_shielded_weight_source(w, read_source, &state); assert(buf);
            assert(!ggml_backend_buffer_is_host(buf) && !ggml_backend_supports_buft(cpu, buf->buft));
            assert(sh_dev_supports_buft(nullptr, buf->buft)); source_buffers.push_back(buf);
        }
        if (scenario.rfind("source_cpu", 0) != 0) p.pending[name] = *w;
        weights.push_back(w);
    }
    if (scenario.rfind("source_cpu", 0) == 0) {
        // GET_ROWS is unsupported by Shielded. The scheduler must transfer the
        // source via its authenticated get_tensor before the CPU sees it.
        auto *meta = ggml_init({ggml_graph_overhead_custom(64, false) + 65536, nullptr, true}); assert(meta);
        auto *index = ggml_new_tensor_1d(meta, GGML_TYPE_I32, 1); ggml_set_input(index);
        auto *out = ggml_get_rows(meta, weights[0], index); ggml_set_output(out);
        auto *graph = ggml_new_graph_custom(meta, 64, false); ggml_build_forward_expand(graph, out);
        auto *shielded = ggml_backend_shielded_init(); assert(shielded);
        ggml_backend_t backends[] = {shielded, cpu};
        auto *sched = ggml_backend_sched_new(backends, nullptr, 2, 64, false, false); assert(sched);
        assert(ggml_backend_sched_alloc_graph(sched, graph));
        int32_t row = 3; ggml_backend_tensor_set(index, &row, 0, sizeof row);
        assert(ggml_backend_sched_graph_compute(sched, graph) == GGML_STATUS_SUCCESS);
        assert(state.reads > 0 && state.calls == state.reads && s.weights.empty());
        float got[32], expected[32]; ggml_backend_tensor_get(out, got, 0, sizeof got);
        const auto &raw = state.expected.at("blk.0.ffn_gate.weight").bytes;
        ggml_get_type_traits(GGML_TYPE_Q8_0)->to_float(raw.data() + row*34, expected, 32);
        assert(!memcmp(got, expected, sizeof got));
        // Authenticated partial/view reads use the original tensor's digest.
        auto *view = ggml_view_1d(meta, weights[0], 32, 3*34);
        uint8_t part[17]; ggml_backend_tensor_get(view, part, 4, sizeof part);
        assert(!memcmp(part, raw.data() + 3*34 + 4, sizeof part));
        source_stats_check(state); // view copy reads the whole source, not only 17 bytes
        ggml_backend_sched_free(sched); ggml_free(meta); ggml_backend_free(shielded);
        for (auto *buf : source_buffers) ggml_backend_buffer_free(buf);
        ggml_free(ctx); ggml_backend_free(cpu);
        puts("weight-verifier: private-copy encoding and authenticated CPU fallback passed"); return 0;
    }
    sh_plan(p);
    ggml_cgraph empty = {};
    if (scenario != "honest" && scenario != "source" && scenario != "background_integrity") {
        assert(s.source_verification_failed && s.weights.empty() && state.calls == (state.read_fail ? 0 : 1));
        assert(ggml_backend_shielded_graph_compute(nullptr, &empty) == GGML_STATUS_FAILED);
    } else {
        assert(state.calls == 2 && s.weights.size() == 2 && !s.source_verification_failed);
        for (const auto &kv : s.weights) assert(kv.second.source_verified && kv.second.w.empty() && kv.second.w_cache);
        uint64_t cache_calls = 99, cache_bytes = 99;
        ggml_backend_shielded_weight_cache_stats(&cache_calls, &cache_bytes);
        assert(cache_calls == 0 && cache_bytes == 0); // creation does not count as reading
        assert(ggml_backend_shielded_set_weight_verifier(verify, &state) == SH_ERR_RANGE);
        s.link_failed = true; s.link_retry_at = DBL_MAX; s.dirty = false;
        // A CPU backend is present, but the source pages are inaccessible.
        // Both link-down and contended-card fallbacks must use the cache.
        s.contention.contended = true; s.probe_group = "different.group";
        for (int rows : {1, 19}) {
            auto *a = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, 32, rows);
            for (int i = 0; i < 32*rows; i++) ((float *)a->data)[i] = (i%13-6)/256.0f;
            auto *gate = ggml_mul_mat(ctx, weights[0], a), *up = ggml_mul_mat(ctx, weights[1], a);
            assert(sh_claimable(gate, true) && sh_claimable(up, true));
            ggml_tensor *nodes[] = {gate, up}; ggml_cgraph graph = {};
            graph.n_nodes = graph.size = 2; graph.nodes = nodes;
            assert(ggml_backend_shielded_graph_compute(nullptr, &graph) == GGML_STATUS_SUCCESS);
            for (auto *node : nodes) {
                const auto &e = s.weights.at(ggml_get_name(node->src[0]));
                const auto &raw = state.expected.at(e.name).bytes;
                int8_t encoded[256]; int frac[8]; assert(sh_prepare_weight_rows(raw.data(), 32, 8, encoded, frac) == SH_OK);
                for (int r = 0; r < rows; r++) for (int j = 0; j < 8; j++) {
                    int64_t acc = 0;
                    for (int k = 0; k < 32; k++) acc += (int64_t)((r*32+k)%13-6) * encoded[j*32+k];
                    const float expected = (float)sh_balanced(acc) * e.inv[j];
                    assert(((float *)node->data)[r*8+j] == expected);
                }
            }
        }
        assert(state.calls == 2); // no reread/reverification of the revoked source
        assert(state.reads == (streamed ? 2 : 0));
        ggml_backend_shielded_weight_cache_stats(&cache_calls, &cache_bytes);
        assert(cache_calls > 0 && cache_bytes == cache_calls * 256); // each small cached matrix is one full authenticated block

        // A real authenticated-cache read failure must reach the backend's
        // integrity counter and stop subsequent graphs even after the storage
        // fault disappears. No direct writes to the failure latch in this test.
        auto *a = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, 32, 1);
        for (int i = 0; i < 32; i++) ((float *)a->data)[i] = (i%13-6)/256.0f;
        auto *out = ggml_mul_mat(ctx, weights[0], a);
        std::fill_n((float *)out->data, 8, -9876.0f);
        ggml_tensor *nodes[] = {out}; ggml_cgraph graph = {};
        graph.n_nodes = graph.size = 1; graph.nodes = nodes;
        sh_state healthy;
        if (scenario == "background_integrity") {
            reject_pad_between_graphs(s.link, argv[1]);
            // No start or remote GEMM will run on this cached local path.
            // Put the healthy card first BEFORE backend retirement is copied.
            assert(s.verify_fail == 0 && !s.dirty && s.link_failed);
            p.cards.insert(p.cards.begin(), &healthy);
            p.pending["pending-must-not-be-planned"] = *weights[0];
        } else corrupt_cache_reads = true;
        assert(ggml_backend_shielded_graph_compute(nullptr, &graph) == GGML_STATUS_FAILED);
        assert(s.verify_fail == 1);
        if (scenario == "background_integrity") {
            assert(p.pending.size() == 1 && p.pending.count("pending-must-not-be-planned"));
            p.pending.clear(); p.cards.erase(p.cards.begin());
            uint64_t now_calls = 0;
            ggml_backend_shielded_weight_cache_stats(&now_calls, nullptr);
            assert(now_calls == cache_calls); // no cache reads even on the first retired graph
        }
        corrupt_cache_reads = false;
        ggml_backend_shielded_weight_cache_stats(&cache_calls, &cache_bytes);
        const auto reads_after_failure = cache_calls;
        // Put a healthy card first: the process-wide gate must still notice
        // the failed card before planning or local execution on either card.
        p.cards.insert(p.cards.begin(), &healthy);
        assert(ggml_backend_shielded_graph_compute(nullptr, &graph) == GGML_STATUS_FAILED);
        assert(ggml_backend_shielded_graph_compute(nullptr, &empty) == GGML_STATUS_FAILED);
        p.cards.erase(p.cards.begin());
        assert(sh_card_compute(s, &graph) == GGML_STATUS_FAILED);
        assert(s.verify_fail == 1);
        ggml_backend_shielded_weight_cache_stats(&cache_calls, &cache_bytes);
        assert(cache_calls == reads_after_failure);
        for (int i = 0; i < 8; i++) assert(((float *)out->data)[i] == -9876.0f);
    }
    source_stats_check(state);
    for (auto &kv : state.expected) if (kv.second.mapping) assert(munmap(kv.second.mapping, 4096) == 0);
    for (auto *buf : source_buffers) ggml_backend_buffer_free(buf);
    ggml_free(ctx); ggml_backend_free(cpu);
    puts("weight-verifier: private-copy encoding, metadata/tamper rejection, revoked-source and wide fallback passed");
}
