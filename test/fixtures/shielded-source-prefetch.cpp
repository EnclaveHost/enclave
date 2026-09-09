#include <atomic>
#include <new>
static std::atomic<bool> fail_prefetch_allocation{false};
#define SH_SOURCE_PREFETCH_RESIZE(v, n) do { if (fail_prefetch_allocation.exchange(false)) throw std::bad_alloc(); (v).resize(n); } while (0)
#define main verifier_fixture_main
#include "shielded-weight-verifier.cpp"
#undef main

struct prefetch_fixture {
    verifier_state values;
    std::atomic<bool> entered{false}, release{false};
    std::atomic<int> readers{0};
    std::vector<std::string> read_order;
    bool overlap = false;
    std::string mode;
};
static const char *first_name = "blk.0.ffn_gate.weight";
static const char *second_name = "blk.0.ffn_up.weight";
static void await_flag(const std::atomic<bool> &flag) {
    const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!flag.load()) {
        assert(std::chrono::steady_clock::now() < end);
        std::this_thread::yield();
    }
}
static int pref_read(void *ctx, const char *name, uint32_t type, const int64_t ne[4], void *bytes, size_t n) {
    auto &s = *static_cast<prefetch_fixture *>(ctx);
    struct guard { std::atomic<int> &n; ~guard() { n.fetch_sub(1); } } done{s.readers};
    assert(s.readers.fetch_add(1) == 0); // the registration pipeline has only one source reader
    s.read_order.emplace_back(name);
    const bool second = !strcmp(name, second_name);
    if (second && s.mode != "off" && s.mode != "allocfail") {
        s.entered.store(true); await_flag(s.release);
        // The planner's error return may clear its descriptor table while
        // this callback still uses the background job's descriptor copy.
        if (s.mode == "abort") std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    if (second && s.mode == "readfail") { s.values.reads++; return SH_ERR_IO; }
    const int rc = read_source(&s.values, name, type, ne, bytes, n);
    if (second && s.mode == "tamper" && rc == SH_OK) static_cast<uint8_t *>(bytes)[20] ^= 1;
    return rc;
}
static int pref_verify(void *ctx, const char *name, uint32_t type, const int64_t ne[4], const void *bytes, size_t n) {
    auto &s = *static_cast<prefetch_fixture *>(ctx);
    if (!strcmp(name, first_name) && s.mode != "off" && s.mode != "allocfail") {
        await_flag(s.entered);
        s.overlap = true;
        s.release.store(true);
    }
    const int rc = verify(&s.values, name, type, ne, bytes, n);
    return s.mode == "abort" && !strcmp(name, first_name) ? SH_ERR_VERIFY : rc;
}

int main(int argc, char **argv) {
    assert(argc == 3); prefetch_fixture state; state.mode = argv[2];
    setenv("SHIELDED_SOURCE_PREFETCH", state.mode == "off" ? "0" : state.mode == "invalid" ? "yes" : "1", 1);
    setenv("SHIELDED_PUBLIC_WEIGHT_CACHE_ONLY", "1", 1);
    setenv("SHIELDED_PUBLIC_WEIGHT_CACHE", "1", 1);
    setenv("SHIELDED_PAD_CHECK", "1", 1);
    setenv("SHIELDED_NO_SIMD", "1", 1);
    setenv("SHIELDED_PREP_THREADS", "1", 1);
    setenv("SHIELDED_PAD_SOURCE", argv[1], 1);
    setenv("SHIELDED_PAD_SEED", std::string(64, '0').c_str(), 1);
    setenv("SHIELDED_PAD_SEED_ID", std::string(32, '0').c_str(), 1);
    setenv("SHIELDED_PAD_SK", std::string(64, '0').c_str(), 1);
    assert(ggml_backend_shielded_set_weight_verifier(pref_verify, &state) == SH_OK);
    sh_pool &pool = sh_pool_get(); sh_pool_init(pool);
    sh_state &s = *pool.cards[0]; s.configured = s.calib_loaded = true; s.calib_version = 2;
    s.calib[first_name] = {8, {}};
    auto *ctx = ggml_init({1u << 20, nullptr, true}); assert(ctx);
    std::vector<ggml_backend_buffer_t> buffers;
    std::vector<ggml_tensor *> tensors;
    for (const auto *name : {first_name, second_name}) {
        auto *w = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, 32, 8); ggml_set_name(w, name);
        std::vector<float> raw(256);
        for (size_t i = 0; i < raw.size(); i++) raw[i] = (int(i % 11) - 5) / 64.0f;
        auto &bytes = state.values.expected[name].bytes; bytes.resize(8 * 34);
        ggml_quantize_chunk(GGML_TYPE_Q8_0, raw.data(), bytes.data(), 0, 8, 32, nullptr);
        auto *b = ggml_backend_shielded_weight_source(w, pref_read, &state); assert(b);
        buffers.push_back(b); tensors.push_back(w);
        pool.pending[name] = *w;
    }
    if (state.mode == "lifetime" || state.mode == "mismatch") {
        sh_source_prefetch prefetch;
        ggml_tensor temporary = *tensors[1];
        prefetch.start(&temporary); await_flag(state.entered);
        memset(&temporary, 0, sizeof temporary); // source descriptor storage goes away
        state.release.store(true);
        auto got = prefetch.take(tensors[state.mode == "mismatch" ? 0 : 1]);
        if (state.mode == "mismatch") assert(!got);
        else assert(got && got->status == 1 && got->bytes == state.values.expected[second_name].bytes);
        assert(state.values.calls == 0); // reads alone never count as authentication
        pool.pending.clear();
    } else if (state.mode == "cap") {
        auto *w = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, 32, (sh_source_prefetch::cap / 34) + 1);
        ggml_set_name(w, "blk.1.ffn_gate.weight");
        auto *b = ggml_backend_shielded_weight_source(w, pref_read, &state); assert(b); buffers.push_back(b);
        sh_source_prefetch prefetch; prefetch.start(w);
        assert(!prefetch.take(w) && state.values.reads == 0);
        pool.pending.clear();
    } else {
        if (state.mode == "allocfail") fail_prefetch_allocation.store(true);
        if (state.mode == "encoded") g_encoded_source = [](void *, const char *, uint32_t, const int64_t *, ggml_shielded_encoded_entry *) { return 1; };
        sh_plan(pool);
        assert(pool.pending.empty());
        if (state.mode == "off" || state.mode == "on" || state.mode == "allocfail") {
            assert(s.weights.size() == 2 && state.values.calls == 2 && state.values.reads == 2);
            assert(state.overlap == (state.mode == "on"));
            assert((state.read_order == std::vector<std::string>{first_name, second_name}));
            for (auto *w : tensors) {
                auto &e = s.weights.at(ggml_get_name(w)); assert(e.w.empty() && e.source_verified);
                int8_t encoded[256]; int fw[8];
                assert(sh_prepare_rows_threaded(state.values.expected[w->name].bytes.data(), 32, 8, encoded, fw) == 0);
                int64_t x[32], y[8];
                for (int k = 0; k < 32; k++) x[k] = k % 5 - 2;
                for (int j = 0; j < 8; j++) { y[j] = 0; for (int k = 0; k < 32; k++) y[j] += x[k] * encoded[j * 32 + k]; }
                assert(sh_link_verify(s.link, e.node, x, y, 1)); y[3]++;
                assert(!sh_link_verify(s.link, e.node, x, y, 1));
            }
        } else if (state.mode == "tamper" || state.mode == "readfail") {
            assert(s.source_verification_failed && s.weights.size() == 1 && state.overlap);
            assert(state.values.calls == (state.mode == "tamper" ? 2 : 1));
        } else if (state.mode == "abort") {
            assert(s.source_verification_failed && s.weights.empty() && state.overlap && state.values.reads == 2);
        } else {
            assert(s.source_verification_failed && s.weights.empty() && state.values.calls == 0 && state.values.reads == 0);
        }
    }
    assert(state.readers.load() == 0);
    for (auto *b : buffers) ggml_backend_buffer_free(b);
    ggml_free(ctx);
    puts("source-prefetch: overlap, authentication, bounds and lifetime PASS");
}
