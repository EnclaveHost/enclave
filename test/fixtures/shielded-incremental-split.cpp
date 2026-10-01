#include "../../wasm/ggml-shielded/ggml-shielded.cpp"
#include <cassert>
int main() {
    setenv("SHIELDED_SOURCE_RECLAIM_INCREMENTAL", "1", 1);
    setenv("SHIELDED_SPLIT_COLS", "1", 1);
    setenv("SHIELDED_MIN_MACS", "0", 1);
    setenv("SHIELDED_MAX_M", "16", 1);
    struct state {
        std::map<std::string, std::vector<uint8_t>> bytes;
        int reads = 0, verified = 0, released = 0;
    } data;
    auto read = +[](void *opaque, const char *name, uint32_t type, const int64_t ne[4], void *out, size_t n) {
        auto &s = *static_cast<state *>(opaque);
        assert(type == GGML_TYPE_Q8_0 && ne[0] == 32 && ne[1] == 64);
        assert(s.bytes.at(name).size() == n);
        // No read of the next tensor before both cards' previous slices exist
        // and their original source has been retired.
        assert(s.released == s.reads / 2);
        memcpy(out, s.bytes.at(name).data(), n); s.reads++;
        return SH_OK;
    };
    auto verify = +[](void *opaque, const char *name, uint32_t, const int64_t[4], const void *in, size_t n) {
        auto &s = *static_cast<state *>(opaque);
        assert(s.bytes.at(name).size() == n && !memcmp(s.bytes.at(name).data(), in, n));
        s.verified++; return SH_OK;
    };
    auto release = +[](void *opaque) {
        auto &s = *static_cast<state *>(opaque);
        const int count = std::min(s.released + 1, 2);
        assert(s.verified == 2 * count && s.reads == s.verified);
        auto &p = sh_pool_get(); assert(p.cards.size() == 2);
        for (auto *card : p.cards) assert(card->weights.size() == size_t(count));
        s.released++; return SH_OK;
    };
    assert(ggml_backend_shielded_set_weight_verifier(verify, &data) == SH_OK);
    assert(ggml_backend_shielded_set_source_release(release, &data) == SH_OK);
    auto &p = sh_pool_get(); p.extra.emplace_back(new sh_state()); p.cards.push_back(p.extra.back().get());
    for (auto *card : p.cards) {
        card->configured = card->calib_loaded = true; card->calib_version = 2;
        card->calib["blk.0.ffn_gate.weight"] = {8, {}};
    }
    auto *ctx = ggml_init({1u << 20, nullptr, true}); assert(ctx);
    std::vector<ggml_backend_buffer_t> buffers;
    for (const char *name : {"blk.0.ffn_gate.weight", "blk.0.ffn_up.weight"}) {
        auto *w = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, 32, 64); ggml_set_name(w, name);
        std::vector<float> values(32*64);
        for (size_t i=0;i<values.size();i++) values[i]=(int(i%11)-5)/64.0f;
        auto &bytes = data.bytes[name]; bytes.resize(ggml_nbytes(w));
        ggml_quantize_chunk(GGML_TYPE_Q8_0, values.data(), bytes.data(), 0, 64, 32, nullptr);
        auto *buffer = ggml_backend_shielded_weight_source(w, read, &data); assert(buffer);
        buffers.push_back(buffer); p.pending[name] = *w;
    }
    sh_plan(p);
    assert(data.reads == 4 && data.verified == 4 && data.released == 3);
    for (auto *card : p.cards) assert(!card->source_verification_failed);
    for (auto *buffer : buffers) ggml_backend_buffer_free(buffer);
    ggml_free(ctx);
    puts("incremental split: all card slices authenticated before source retirement");
}
