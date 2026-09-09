// Use the real backend and its existing authenticated-source fixture helpers.
#define main verifier_fixture_main
#include "shielded-weight-verifier.cpp"
#undef main

int main(int argc, char **argv) {
    assert(argc == 3); const std::string mode = argv[2];
    setenv("SHIELDED_PUBLIC_WEIGHT_CACHE_ONLY", mode == "off" ? "0" : mode == "malformed" ? "yes" : "1", 1);
    setenv("SHIELDED_PUBLIC_WEIGHT_CACHE", mode == "nocache" ? "0" : "1", 1);
    setenv("SHIELDED_PAD_CHECK", mode == "nopad" ? "0" : "1", 1);
    setenv("SHIELDED_NO_SIMD", "1", 1);
    setenv("SHIELDED_PREP_THREADS", "1", 1);
    // A nonexistent path makes any unintended temporary-cache write fail.
    setenv("SHIELDED_WEIGHT_CACHE_DIR", "/required-cache-must-not-write", 1);
    if (mode != "nodealt") {
        setenv("SHIELDED_PAD_SOURCE", argv[1], 1);
        setenv("SHIELDED_PAD_SEED", std::string(64, '0').c_str(), 1);
        setenv("SHIELDED_PAD_SEED_ID", std::string(32, '0').c_str(), 1);
        setenv("SHIELDED_PAD_SK", std::string(64, '0').c_str(), 1);
    }
    if (mode == "off") unsetenv("SHIELDED_WEIGHT_CACHE_DIR");
    verifier_state state;
    if (mode != "unauth") assert(ggml_backend_shielded_set_weight_verifier(verify, &state) == SH_OK);
    sh_pool &pool = sh_pool_get(); sh_pool_init(pool);
    sh_state &s = *pool.cards[0]; s.configured = s.calib_loaded = true; s.calib_version = 2;
    s.calib["blk.0.ffn_gate.weight"] = {8, {}};
    auto *ctx = ggml_init({1u << 20, nullptr, false}); assert(ctx);
    auto *w = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, 32, 8);
    ggml_set_name(w, "blk.0.ffn_gate.weight");
    std::vector<float> raw(256);
    for (size_t i = 0; i < raw.size(); i++) raw[i] = (int(i % 11) - 5) / 64.0f;
    ggml_quantize_chunk(GGML_TYPE_Q8_0, raw.data(), w->data, 0, 8, 32, nullptr);
    auto &record = state.expected[ggml_get_name(w)]; record.mapping = nullptr;
    record.bytes.assign((uint8_t *)w->data, (uint8_t *)w->data + ggml_nbytes(w));
    int8_t encoded[256]; int fw[8];
    assert(sh_prepare_rows_threaded(w->data, 32, 8, encoded, fw) == 0);
    const bool ok = sh_register(s, w);
    if (mode != "on" && mode != "off") {
        assert(!ok && s.weight_cache_failed && s.weights.empty());
    } else {
        assert(ok && state.calls == 1 && !s.weight_cache_failed);
        auto &e = s.weights.at(ggml_get_name(w));
        assert(!e.w_cache && e.source_verified);
        assert(e.w.empty() == (mode == "on"));
        assert((sh_link_weight(s.link, e.node) == nullptr) == (mode == "on"));
        int64_t x[32], y[8];
        for (int k = 0; k < 32; k++) x[k] = k % 5 - 2;
        for (int j = 0; j < 8; j++) { y[j] = 0; for (int k = 0; k < 32; k++) y[j] += x[k] * encoded[j*32+k]; }
        assert(sh_link_verify(s.link, e.node, x, y, 1));
        y[3]++; assert(!sh_link_verify(s.link, e.node, x, y, 1)); y[3]--;
        int64_t out[8]; std::fill(out, out+8, INT64_C(123456)); int64_t *yp = out;
        const int rc = sh_link_gemm_local(s.link, &e.node, 1, x, 1, &yp);
        if (mode == "on") {
            assert(rc == SH_ERR_VERIFY);
            for (auto v : out) assert(v == 123456);
        } else { assert(rc == SH_OK); for (int j = 0; j < 8; j++) assert(out[j] == y[j]); }
    }
    ggml_free(ctx);
    puts("required-cache: authenticated registration, released bytes, retained verification and refusal PASS");
}
