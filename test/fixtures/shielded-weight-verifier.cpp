#include "../../wasm/ggml-shielded/ggml-shielded.cpp"
#include "ggml-cpu.h"
#include <cassert>
#include <sys/mman.h>

struct source_record { void *mapping; std::vector<uint8_t> bytes; };
struct verifier_state { std::map<std::string, source_record> expected; int calls = 0; };
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
    assert(mprotect(record.mapping, 4096, PROT_NONE) == 0);
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
    assert(ggml_backend_shielded_set_weight_verifier(nullptr, &state) == SH_ERR_RANGE);
    assert(ggml_backend_shielded_set_weight_verifier(verify, &state) == SH_OK);
    assert(ggml_backend_shielded_set_weight_verifier(verify, &state) == SH_ERR_RANGE);
    sh_pool &p = sh_pool_get(); sh_state &s = *p.cards[0];
    s.configured = s.calib_loaded = true; s.calib_version = 2;
    s.calib["blk.0.ffn_gate.weight"] = {8, {}};
    auto *ctx = ggml_init({1u << 20, nullptr, false}); assert(ctx);
    std::vector<ggml_tensor *> weights;
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
        p.pending[name] = *w; weights.push_back(w);
    }
    sh_plan(p);
    ggml_cgraph empty = {};
    if (scenario != "honest") {
        assert(s.source_verification_failed && s.weights.empty() && state.calls == 1);
        assert(ggml_backend_shielded_graph_compute(nullptr, &empty) == GGML_STATUS_FAILED);
    } else {
        assert(state.calls == 2 && s.weights.size() == 2 && !s.source_verification_failed);
        for (const auto &kv : s.weights) assert(kv.second.source_verified && kv.second.w.empty() && kv.second.w_cache);
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
    }
    for (auto &kv : state.expected) assert(munmap(kv.second.mapping, 4096) == 0);
    ggml_free(ctx); ggml_backend_free(cpu);
    puts("weight-verifier: private-copy encoding, metadata/tamper rejection, revoked-source and wide fallback passed");
}
