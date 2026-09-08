#include <unistd.h>
#include <cerrno>
static int cache_writes = 0;
static ssize_t full_disk_pwrite(int fd, const void *p, size_t n, off_t off) {
    if (++cache_writes > 1) { errno = ENOSPC; return -1; }
    return pwrite(fd, p, n, off);
}
#define pwrite full_disk_pwrite
#include "../../wasm/ggml-shielded/ggml-shielded.cpp"
#undef pwrite
#include "ggml-cpu.h"
#include <cassert>

int main(int argc, char **argv) {
    assert(argc == 2);
    setenv("SHIELDED_WEIGHT_CACHE_DIR", argv[1], 1);
    setenv("SHIELDED_PAD_SOURCE", argv[1], 1);
    setenv("SHIELDED_PAD_SEED", "0000000000000000000000000000000000000000000000000000000000000000", 1);
    setenv("SHIELDED_PAD_SEED_ID", "00000000000000000000000000000000", 1);
    setenv("SHIELDED_PAD_SK", "0000000000000000000000000000000000000000000000000000000000000000", 1);
    setenv("SHIELDED_PAD_CHECK", "1", 1); setenv("SHIELDED_NO_SIMD", "1", 1);
    sh_pool &p = sh_pool_get(); sh_pool_init(p);
    sh_state &s = *p.cards[0]; s.configured = s.calib_loaded = true; s.calib_version = 2;
    s.calib["blk.0.ffn_gate.weight"] = {8, {}};
    s.calib["blk.1.ffn_gate.weight"] = {8, {}};
    auto *ctx = ggml_init({1u << 20, nullptr, false}); assert(ctx);
    auto *gate = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, 32, 8);
    auto *up = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, 32, 8);
    auto *later = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, 32, 8);
    ggml_set_name(gate, "blk.0.ffn_gate.weight"); ggml_set_name(up, "blk.0.ffn_up.weight");
    ggml_set_name(later, "blk.1.ffn_gate.weight");
    for (auto *w : {gate, up, later}) {
        std::vector<float> raw(256);
        for (size_t i = 0; i < raw.size(); i++) raw[i] = (int(i % 11) - 5) / 64.0f;
        ggml_quantize_chunk(GGML_TYPE_Q8_0, raw.data(), w->data, 0, 8, 32, nullptr);
        p.pending[ggml_get_name(w)] = *w;
    }
    sh_plan(p);
    assert(s.weight_cache_failed && cache_writes == 2 && p.pending.empty());
    assert(s.weights.size() == 1 && s.weights.count(ggml_get_name(gate)));
    assert(s.weights.at(ggml_get_name(gate)).w.empty());
    assert(!sh_link_is_live(s.link));
    ggml_cgraph graph = {};
    assert(sh_card_compute(s, &graph) == GGML_STATUS_FAILED);
    assert(ggml_backend_shielded_graph_compute(nullptr, &graph) == GGML_STATUS_FAILED);
    assert(!sh_register(s, later) && cache_writes == 2);
    ggml_free(ctx);
    puts("cache-registration: partial shared group aborts before worker upload or pad import");
}
