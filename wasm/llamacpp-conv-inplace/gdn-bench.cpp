// GATED_DELTA_NET timing at the 27B's verify shape: in place into a 2-slot
// cache, S_v 128, 48 value heads over 16 key heads, 2 tokens, one sequence,
// scalar gate, 8 threads. Prints the mean microseconds per op call; run once
// per ENCLAVE_GGML_GDN_TOKFUSE value (read once per process), interleaved.
//
//   gdn-bench [N_TOKENS] [THREADS] [ITERS]
#include "ggml.h"
#include "ggml-cpu.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <vector>

int main(int argc, char ** argv) {
    const int64_t S_v = 128, H = 48, H_k = 16, n_s = 1, K = 2;
    const int64_t n_t = argc > 1 ? atoll(argv[1]) : 2;
    const int threads = argc > 2 ? atoi(argv[2]) : 8;
    const int iters = argc > 3 ? atoi(argv[3]) : 3000;
    ggml_init_params ip = { (size_t) 256 << 20, nullptr, false };
    ggml_context * ctx = ggml_init(ip);
    std::mt19937 rng(1);
    std::normal_distribution<float> nd(0.f, 1.f);
    auto fill = [&](ggml_tensor * t, float sc, float off) {
        float * p = (float *) t->data;
        for (int64_t i = 0; i < ggml_nelements(t); i++) p[i] = nd(rng) * sc + off; };
    ggml_tensor * q = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, S_v, H_k, n_t, n_s);
    ggml_tensor * k = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, S_v, H_k, n_t, n_s);
    ggml_tensor * v = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, S_v, H, n_t, n_s);
    ggml_tensor * g = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, 1, H, n_t, n_s);
    ggml_tensor * b = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, 1, H, n_t, n_s);
    fill(q, 0.1f, 0.f); fill(k, 0.1f, 0.f); fill(v, 1.f, 0.f); fill(g, 0.05f, -0.02f); fill(b, 0.1f, 0.3f);
    const size_t st_bytes = (size_t) S_v * S_v * H * n_s * sizeof(float);
    ggml_tensor * cache = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, (int64_t) (st_bytes * K / sizeof(float)));
    fill(cache, 0.01f, 0.f);
    ggml_tensor * st = ggml_view_4d(ctx, cache, S_v, S_v, H, n_s, S_v * sizeof(float), S_v * S_v * sizeof(float),
                                    S_v * S_v * H * sizeof(float), 0);
    ggml_tensor * res = ggml_gated_delta_net_inplace(ctx, q, k, v, g, b, st, K, st_bytes);
    ggml_cgraph * gr = ggml_new_graph(ctx);
    ggml_build_forward_expand(gr, res);
    ggml_cplan plan = ggml_graph_plan(gr, threads, nullptr);
    std::vector<uint8_t> work(plan.work_size + 64);
    plan.work_data = work.data();
    for (int i = 0; i < 200; i++) ggml_graph_compute(gr, &plan);   // warm
    const auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < iters; i++) ggml_graph_compute(gr, &plan);
    const double us = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count() / iters;
    const char * e = getenv("ENCLAVE_GGML_GDN_TOKFUSE");
    printf("tokfuse=%s n_t=%lld threads=%d iters=%d  %.1f us/call\n", e ? e : "(default on)", (long long) n_t, threads, iters, us);
    ggml_free(ctx);
    return 0;
}
