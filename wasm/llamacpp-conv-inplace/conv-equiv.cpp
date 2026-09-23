// ggml_ssm_conv_state against the graph it replaces, bit for bit.
//
// Reference (build_conv_state + ggml_ssm_conv): conv_input = concat(state, x^T),
// out = ssm_conv(conv_input, c), and for each rollback slot s the columns
// [max(0, ncs-nw-s), +nw) of conv_input copied into slot s. Fused: the same
// state copied into a separate buffer, ggml_ssm_conv_state(state, x, c, K, stride).
// Compares the outputs and every slot of the updated state with memcmp.
#include "ggml.h"
#include "ggml-cpu.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <random>

static int run(int64_t d_inner, int64_t n_t, int64_t K, int nthreads, uint32_t seed, bool zeros = false) {
    const int64_t d_conv = 4, nw = d_conv - 1, n_s = 1;
    const size_t mem = (size_t) 1 << 30;
    ggml_init_params ip = { mem, nullptr, false };
    ggml_context * ctx = ggml_init(ip);
    std::mt19937 rng(seed);
    std::normal_distribution<float> nd(0.f, 1.f);
    // zeros: a third of the values exactly +0 or -0, so the sign of a zero
    // product and of a zero sum is exercised (FMA from +0 vs a leading mul)
    auto fill = [&](ggml_tensor * t) { float * p = (float *) t->data;
        for (int64_t i = 0; i < ggml_nelements(t); i++) {
            float v = nd(rng);
            if (zeros) { const uint32_t r = rng() % 6; if (r == 0) v = 0.0f; else if (r == 1) v = -0.0f; }
            p[i] = v;
        } };

    // the recurrent cache: K slots of {nw, d_inner} rows
    ggml_tensor * cache_ref = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, nw * d_inner, K);
    ggml_tensor * cache_fus = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, nw * d_inner, K);
    fill(cache_ref); memcpy(cache_fus->data, cache_ref->data, ggml_nbytes(cache_ref));
    ggml_tensor * x = ggml_new_tensor_3d(ctx, GGML_TYPE_F32, d_inner, n_t, n_s); fill(x);
    ggml_tensor * c = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, d_conv, d_inner);  fill(c);
    const size_t row_size = ggml_row_size(GGML_TYPE_F32, nw * d_inner);

    // reference graph
    ggml_cgraph * g1 = ggml_new_graph(ctx);
    ggml_tensor * st = ggml_view_3d(ctx, cache_ref, nw, d_inner, n_s, nw * sizeof(float), row_size, 0);
    ggml_tensor * ci = ggml_concat(ctx, st, ggml_transpose(ctx, x), 0);
    ggml_tensor * o1 = ggml_ssm_conv(ctx, ci, c);
    ggml_build_forward_expand(g1, o1);
    const int64_t ncs = ci->ne[0];
    for (int64_t s = 0; s < K; s++) {
        int64_t s_idx = ncs - nw - s; if (s_idx < 0) s_idx = 0;
        ggml_tensor * last = ggml_view_3d(ctx, ci, nw, d_inner, n_s, ci->nb[1], ci->nb[2], ggml_row_size(ci->type, s_idx));
        ggml_tensor * dstv = ggml_view_2d(ctx, cache_ref, nw * d_inner, n_s, cache_ref->nb[1], s * row_size);
        ggml_build_forward_expand(g1, ggml_cpy(ctx, last, dstv));
    }
    ggml_graph_compute_with_ctx(ctx, g1, nthreads);

    // fused graph
    ggml_cgraph * g2 = ggml_new_graph(ctx);
    ggml_tensor * st2 = ggml_view_3d(ctx, cache_fus, nw, d_inner, n_s, nw * sizeof(float), row_size, 0);
    ggml_tensor * o2 = ggml_ssm_conv_state(ctx, st2, x, c, K, row_size);
    ggml_build_forward_expand(g2, o2);
    ggml_graph_compute_with_ctx(ctx, g2, nthreads);

    const bool out_same = ggml_nbytes(o1) == ggml_nbytes(o2) && !memcmp(o1->data, o2->data, ggml_nbytes(o1));
    const bool state_same = !memcmp(cache_ref->data, cache_fus->data, ggml_nbytes(cache_ref));
    int64_t diff_out = 0;
    for (int64_t i = 0; i < ggml_nelements(o1); i++) diff_out += ((const uint32_t *) o1->data)[i] != ((const uint32_t *) o2->data)[i];
    printf("d_inner=%lld n_t=%lld K=%lld threads=%d: output %s (%lld differ), state (all %lld slots) %s\n",
           (long long) d_inner, (long long) n_t, (long long) K, nthreads, out_same ? "IDENTICAL" : "DIFFERS",
           (long long) diff_out, (long long) K, state_same ? "IDENTICAL" : "DIFFERS");
    ggml_free(ctx);
    return out_same && state_same ? 0 : 1;
}

int main() {
    int bad = 0;
    for (int64_t n_t : {1, 2, 3, 17, 70}) for (int64_t K : {1, 2}) for (int th : {1, 8})
        bad += run(10240, n_t, K, th, (uint32_t) (n_t * 131 + K * 7 + th));
    bad += run(37, 5, 2, 3, 99);   // ragged channel count across threads
    for (int64_t n_t : {1, 2, 17}) for (int64_t K : {1, 2})
        bad += run(10240, n_t, K, 8, (uint32_t) (1000 + n_t * 3 + K), /*zeros=*/true);
    bad += run(10240 + 5, 2, 2, 8, 4242, true);   // a channel count that leaves a scalar tail per thread
    printf(bad ? "SOME DIFFER\n" : "ALL IDENTICAL\n");
    return bad ? 1 : 0;
}
