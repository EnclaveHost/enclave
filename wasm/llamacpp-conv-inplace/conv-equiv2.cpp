// ggml_ssm_conv_state against the graph it replaces, bit for bit, over a
// SEQUENCE of calls on one simulated recurrent cache.
//
// The cache holds K slots of mem_size cells, each cell one sequence's
// {d_conv-1, d_inner} conv state; the active sequences sit at cells
// [kv_head, kv_head + n_s). Every call reads its state from slot `read`
// (0 normally; >0 after a rollback, which llama.cpp serves through a gather,
// i.e. the non-identity path) and writes all K slots, as build_conv_state does.
//
// Two flows run the same call sequence on two copies of the cache:
//   reference  concat(state, x^T) -> ssm_conv -> per-slot copies, always
//   production the fused op when the call reads slot 0 (the identity gather
//              build_conv takes), the reference ops otherwise (its fallback)
// After every call the outputs and the ENTIRE cache (every slot, every cell,
// including the inactive ones, which must be untouched) are compared bytewise.
#include "ggml.h"
#include "ggml-cpu.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <vector>

struct Call { int64_t n_t; int64_t read; };

static ggml_tensor * ref_ops(ggml_context * ctx, ggml_cgraph * g, ggml_tensor * cache, ggml_tensor * x, ggml_tensor * c,
                             int64_t nw, int64_t d_inner, int64_t n_s, int64_t mem_size, int64_t kv_head, int64_t K, int64_t read) {
    const size_t row_size = ggml_row_size(GGML_TYPE_F32, nw * d_inner);
    ggml_tensor * st = ggml_view_3d(ctx, cache, nw, d_inner, n_s, nw * sizeof(float), row_size,
                                    (size_t) (read * mem_size + kv_head) * row_size);
    ggml_tensor * ci = ggml_concat(ctx, st, ggml_transpose(ctx, x), 0);
    ggml_tensor * out = ggml_ssm_conv(ctx, ci, c);
    ggml_build_forward_expand(g, out);
    const int64_t ncs = ci->ne[0];
    for (int64_t s = 0; s < K; s++) {
        int64_t s_idx = ncs - nw - s; if (s_idx < 0) s_idx = 0;
        ggml_tensor * last = ggml_view_3d(ctx, ci, nw, d_inner, n_s, ci->nb[1], ci->nb[2], ggml_row_size(ci->type, s_idx));
        ggml_tensor * dstv = ggml_view_2d(ctx, cache, nw * d_inner, n_s, row_size, (size_t) (s * mem_size + kv_head) * row_size);
        ggml_build_forward_expand(g, ggml_cpy(ctx, last, dstv));
    }
    return out;
}

static int flow(const char * name, int64_t d_inner, int64_t d_conv, int64_t n_s, int64_t mem_size, int64_t kv_head, int64_t K,
                const std::vector<Call> & calls, int nthreads, uint32_t seed, bool zeros) {
    const int64_t nw = d_conv - 1;
    ggml_init_params ip = { (size_t) 1 << 30, nullptr, false };
    ggml_context * ctx = ggml_init(ip);
    std::mt19937 rng(seed);
    std::normal_distribution<float> nd(0.f, 1.f);
    auto fill = [&](ggml_tensor * t) { float * p = (float *) t->data;
        for (int64_t i = 0; i < ggml_nelements(t); i++) {
            float v = nd(rng);
            if (zeros) { const uint32_t r = rng() % 6; if (r == 0) v = 0.0f; else if (r == 1) v = -0.0f; }
            p[i] = v;
        } };
    const size_t row_size = ggml_row_size(GGML_TYPE_F32, nw * d_inner);
    ggml_tensor * cache_ref = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, nw * d_inner, K * mem_size);
    ggml_tensor * cache_pro = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, nw * d_inner, K * mem_size);
    fill(cache_ref); memcpy(cache_pro->data, cache_ref->data, ggml_nbytes(cache_ref));
    ggml_tensor * c = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, d_conv, d_inner); fill(c);
    int bad = 0, fused_calls = 0;
    for (size_t k = 0; k < calls.size(); k++) {
        const int64_t n_t = calls[k].n_t, read = calls[k].read;
        ggml_tensor * x = ggml_new_tensor_3d(ctx, GGML_TYPE_F32, d_inner, n_t, n_s); fill(x);
        ggml_cgraph * g1 = ggml_new_graph(ctx);
        ggml_tensor * o1 = ref_ops(ctx, g1, cache_ref, x, c, nw, d_inner, n_s, mem_size, kv_head, K, read);
        ggml_graph_compute_with_ctx(ctx, g1, nthreads);
        ggml_cgraph * g2 = ggml_new_graph(ctx);
        ggml_tensor * o2;
        if (read == 0) {   // identity: the fused op, reading and updating slot 0 where it lies
            ggml_tensor * st = ggml_view_3d(ctx, cache_pro, nw, d_inner, n_s, nw * sizeof(float), row_size, (size_t) kv_head * row_size);
            o2 = ggml_ssm_conv_state(ctx, st, x, c, K, (size_t) mem_size * row_size);
            ggml_build_forward_expand(g2, o2);
            fused_calls++;
        } else {           // rollback read: build_conv's fallback, the reference ops
            o2 = ref_ops(ctx, g2, cache_pro, x, c, nw, d_inner, n_s, mem_size, kv_head, K, read);
        }
        ggml_graph_compute_with_ctx(ctx, g2, nthreads);
        const bool out_same = ggml_nbytes(o1) == ggml_nbytes(o2) && !memcmp(o1->data, o2->data, ggml_nbytes(o1));
        const bool cache_same = !memcmp(cache_ref->data, cache_pro->data, ggml_nbytes(cache_ref));
        if (!out_same || !cache_same) {
            printf("  %s: call %zu (n_t=%lld read slot %lld, %s) output %s, cache %s\n", name, k, (long long) n_t, (long long) read,
                   read == 0 ? "fused" : "fallback", out_same ? "same" : "DIFFERS", cache_same ? "same" : "DIFFERS");
            bad++;
        }
    }
    printf("%s %s: d_inner=%lld d_conv=%lld n_s=%lld mem_size=%lld kv_head=%lld K=%lld threads=%d, %zu calls (%d fused, %zu fallback)%s\n",
           bad ? "FAIL" : "PASS", name, (long long) d_inner, (long long) d_conv, (long long) n_s, (long long) mem_size,
           (long long) kv_head, (long long) K, nthreads, calls.size(), fused_calls, calls.size() - fused_calls, zeros ? ", signed zeros" : "");
    ggml_free(ctx);
    return bad;
}

int main() {
    int bad = 0;
    // single calls at the shapes the 27B uses, and the vector/scalar boundary
    for (int64_t n_t : {1, 2, 17, 64, 65}) for (int64_t K : {1, 2})
        bad += flow("single", 10240, 4, 1, 1, 0, K, {{n_t, 0}}, 8, (uint32_t) (n_t * 17 + K), true);
    // several sequences at a nonzero cache head, snapshot stride past the active state
    bad += flow("multi-seq", 10240, 4, 3, 8, 2, 2, {{1, 0}, {2, 0}, {1, 0}}, 8, 11, true);
    bad += flow("multi-seq", 10245, 4, 3, 5, 1, 3, {{3, 0}, {1, 0}, {2, 0}}, 8, 12, false);
    // more rollback slots than new tokens: the older slots come from the old state
    for (int64_t n_t : {1, 2}) bad += flow("K>n_t", 10240, 4, 1, 4, 1, 4, {{n_t, 0}, {n_t, 0}}, 8, (uint32_t) (20 + n_t), true);
    // consecutive calls with rollbacks and resumes: fused and fallback interleaved on one cache
    {
        std::mt19937 r(7);
        std::vector<Call> seq;
        for (int i = 0; i < 24; i++) seq.push_back({(int64_t) (1 + r() % 3), (r() % 4 == 0) ? (int64_t) (1 + r() % 2) : 0});
        bad += flow("rollback/resume", 10240, 4, 1, 3, 1, 3, seq, 8, 31, true);
        bad += flow("rollback/resume", 10240, 4, 2, 4, 1, 3, seq, 3, 32, false);
    }
    // the other convolution widths the op accepts (2..16), both paths
    for (int64_t d_conv : {2, 3, 5, 16}) for (int64_t n_t : {1, 2, 64, 65})
        bad += flow("width", 1024 + 7, d_conv, 2, 3, 1, 2, {{n_t, 0}, {1, 0}}, 4, (uint32_t) (d_conv * 100 + n_t), true);
    printf(bad ? "SOME FAILED (%d)\n" : "ALL PASS\n", bad);
    return bad ? 1 : 0;
}
