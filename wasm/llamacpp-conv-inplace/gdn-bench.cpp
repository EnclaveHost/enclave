// GATED_DELTA_NET timing at the 27B's verify shape: in place into a K-slot
// cache (default 2), S_v 128, 48 value heads over 16 key heads, N tokens
// (default 2), one sequence, scalar gate, THREADS threads (default 8). Prints
// the mean microseconds per op call. Run once per value of the switch under
// test (ENCLAVE_GGML_GDN_REGROW, or ENCLAVE_GGML_GDN_TOKFUSE on a tree with that
// unapplied patch; each is read once per process), interleaved.
//
//   gdn-bench [N_TOKENS] [THREADS] [ITERS] [K] [NSTATES]
//
// NSTATES > 1 gives every "layer" its own state cache and inputs and runs them
// in turn, as the graph does (48 recurrent layers x 3 MB on the 27B is more than
// the L3), so the state arrives cold; K = 1 drops the rollback snapshot.
// GDN_BENCH_WARM=1 reads each layer's state cache (untimed, on WARM_THREADS
// threads, default 8) just before its call, as a prefetch during the exchange
// wait would; only the op calls are timed.
#include "ggml.h"
#include "ggml-cpu.h"
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <thread>
#include <vector>

int main(int argc, char ** argv) {
    const int64_t S_v = 128, H = 48, H_k = 16, n_s = 1;
    const int64_t n_t = argc > 1 ? atoll(argv[1]) : 2;
    const int threads = argc > 2 ? atoi(argv[2]) : 8;
    const int iters = argc > 3 ? atoi(argv[3]) : 3000;
    const int64_t K = argc > 4 ? atoll(argv[4]) : 2;
    const int nst = argc > 5 ? atoi(argv[5]) : 1;
    const size_t st_bytes = (size_t) S_v * S_v * H * n_s * sizeof(float);
    ggml_init_params ip = { (size_t) nst * (st_bytes * K + (8u << 20)) + (64u << 20), nullptr, false };
    ggml_context * ctx = ggml_init(ip);
    std::mt19937 rng(1);
    std::normal_distribution<float> nd(0.f, 1.f);
    auto fill = [&](ggml_tensor * t, float sc, float off) {
        float * p = (float *) t->data;
        for (int64_t i = 0; i < ggml_nelements(t); i++) p[i] = nd(rng) * sc + off; };
    std::vector<ggml_cgraph *> grs;
    for (int l = 0; l < nst; l++) {
        ggml_tensor * q = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, S_v, H_k, n_t, n_s);
        ggml_tensor * k = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, S_v, H_k, n_t, n_s);
        ggml_tensor * v = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, S_v, H, n_t, n_s);
        ggml_tensor * g = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, 1, H, n_t, n_s);
        ggml_tensor * b = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, 1, H, n_t, n_s);
        fill(q, 0.1f, 0.f); fill(k, 0.1f, 0.f); fill(v, 1.f, 0.f); fill(g, 0.05f, -0.02f); fill(b, 0.1f, 0.3f);
        ggml_tensor * cache = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, (int64_t) (st_bytes * K / sizeof(float)));
        fill(cache, 0.01f, 0.f);
        ggml_tensor * st = ggml_view_4d(ctx, cache, S_v, S_v, H, n_s, S_v * sizeof(float), S_v * S_v * sizeof(float),
                                        S_v * S_v * H * sizeof(float), 0);
        ggml_tensor * res = ggml_gated_delta_net_inplace(ctx, q, k, v, g, b, st, K, K > 1 ? st_bytes : 0);
        ggml_cgraph * gr = ggml_new_graph(ctx);
        ggml_build_forward_expand(gr, res);
        grs.push_back(gr);
    }
    ggml_cplan plan = ggml_graph_plan(grs[0], threads, nullptr);
    std::vector<uint8_t> work(plan.work_size + 64);
    plan.work_data = work.data();
    const int warm = nst > 1 ? 2 : 200;
    for (int i = 0; i < warm; i++) for (auto * gr : grs) ggml_graph_compute(gr, &plan);
    const int it = nst > 1 ? (iters + nst - 1) / nst : iters;
    const bool warmup_each = getenv("GDN_BENCH_WARM") && getenv("GDN_BENCH_WARM")[0] == '1';
    const int wthreads = getenv("WARM_THREADS") ? atoi(getenv("WARM_THREADS")) : 8;
    std::vector<const float *> caches;
    for (auto * gr : grs) caches.push_back((const float *) ggml_graph_node(gr, -1)->src[5]->data);
    const size_t cache_floats = st_bytes * K / sizeof(float);
    volatile float sink = 0;
    auto touch = [&](const float * c) {
        std::vector<std::thread> th;
        std::vector<float> part(wthreads, 0.f);
        for (int w = 0; w < wthreads; w++) th.emplace_back([&, w] {
            const size_t a = cache_floats * w / wthreads, b = cache_floats * (w + 1) / wthreads;
            float acc = 0; for (size_t i = a; i < b; i += 16) acc += c[i];
            part[w] = acc; });
        for (auto & t : th) t.join();
        for (float v : part) sink = sink + v;
    };
    double us_total = 0;
    for (int i = 0; i < it; i++) for (size_t l = 0; l < grs.size(); l++) {
        if (warmup_each) touch(caches[l]);
        const auto t0 = std::chrono::steady_clock::now();
        ggml_graph_compute(grs[l], &plan);
        us_total += std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count();
    }
    const double us = us_total / ((double) it * nst);
    const char * e1 = getenv("ENCLAVE_GGML_GDN_REGROW");
    const char * e2 = getenv("ENCLAVE_GGML_GDN_TOKFUSE");
    printf("regrow=%s tokfuse=%s n_t=%lld threads=%d K=%lld states=%d warm=%d calls=%d  %.1f us/call\n", e1 ? e1 : "(default)",
           e2 ? e2 : "(default)", (long long) n_t, threads, (long long) K, nst, (int) warmup_each, it * nst, us);
    ggml_free(ctx);
    return 0;
}
