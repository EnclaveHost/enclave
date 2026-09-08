/* Real scheduler coverage, with a closed loopback worker endpoint so all
 * products use the trusted exact fallback. No CUDA backend is loaded. */
#include "../../wasm/ggml-shielded/ggml-shielded.h"
#include "ggml.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

static void fill_weight(ggml_tensor *w, int seed) {
    std::vector<float> raw(ggml_nelements(w));
    for (size_t i = 0; i < raw.size(); i++) raw[i] = float((i * 7 + seed) % 31 - 15.0) / 1024;
    std::vector<unsigned char> q(ggml_nbytes(w));
    ggml_quantize_chunk(GGML_TYPE_Q8_0, raw.data(), q.data(), 0, w->ne[1], w->ne[0], nullptr);
    ggml_backend_tensor_set(w, q.data(), 0, q.size());
}
static void fill_input(ggml_tensor *t, int seed) {
    std::vector<float> v(ggml_nelements(t));
    for (size_t i = 0; i < v.size(); i++) v[i] = float((i * 11 + seed) % 37 - 18.0) / 32;
    ggml_backend_tensor_set(t, v.data(), 0, v.size() * sizeof(float));
}
static uint64_t hash_tensor(ggml_tensor *t) {
    std::vector<unsigned char> v(ggml_nbytes(t));
    ggml_backend_tensor_get(t, v.data(), 0, v.size());
    uint64_t h = 14695981039346656037ULL;
    for (auto b : v) h = (h ^ b) * 1099511628211ULL;
    return h;
}

int main(int argc, char **argv) {
    assert(argc == 3);
    const int m = atoi(argv[1]);
    const std::string scenario = argv[2];
    const bool enabled = getenv("SHIELDED_FUSE_LOCAL") && atoi(getenv("SHIELDED_FUSE_LOCAL")) != 0;
    const bool first_local = scenario == "first-local";
    const bool no_next = scenario == "next-local" || scenario == "next-uncalibrated";
    const bool invalid_pool = scenario == "invalid-pool";
    const bool eligible = enabled && !first_local && !no_next && !invalid_pool && m <= 16;
    auto *cpu = ggml_backend_cpu_init(); assert(cpu);
    ggml_backend_cpu_set_n_threads(cpu, 1);
    auto *sh = ggml_backend_shielded_init(); assert(sh);
    ggml_backend_t bes[] = {sh, cpu};
    ggml_backend_buffer_type_t types[] = {ggml_backend_get_default_buffer_type(sh), ggml_backend_get_default_buffer_type(cpu)};
    auto *sched = ggml_backend_sched_new(bes, types, 2, 256, false, true); assert(sched);
    ggml_init_params ip = {2 << 20, nullptr, true};
    auto *inputs = ggml_init(ip), *ctx = ggml_init(ip); assert(inputs && ctx);
    auto *w = ggml_new_tensor_2d(inputs, GGML_TYPE_Q8_0, 64, 32);
    ggml_set_name(w, scenario == "ssm" ? "blk.3.ssm_out.weight" : "blk.3.attn_output.weight");
    auto *gate_w = ggml_new_tensor_2d(inputs, GGML_TYPE_Q8_0, 32, 96);
    auto *up_w = ggml_new_tensor_2d(inputs, GGML_TYPE_Q8_0, 32, 96);
    ggml_set_name(gate_w, "blk.3.ffn_gate.weight"); ggml_set_name(up_w, "blk.3.ffn_up.weight");
    auto *x = ggml_new_tensor_2d(inputs, GGML_TYPE_F32, 64, m);
    auto *residual = ggml_new_tensor_2d(inputs, GGML_TYPE_F32, 32, m);
    auto *gamma = ggml_new_tensor_1d(inputs, GGML_TYPE_F32, 32);
    ggml_set_name(gamma, "blk.3.post_attention_norm.weight");
    auto *buffer = ggml_backend_alloc_ctx_tensors(inputs, cpu); assert(buffer);
    fill_weight(w, 3); fill_weight(gate_w, 7); fill_weight(up_w, 11);
    fill_input(x, 13); fill_input(residual, 17); fill_input(gamma, 19);
    auto *first = ggml_mul_mat(ctx, w, x);
    auto *view = scenario == "ssm" ? ggml_reshape_2d(ctx, first, 32, m) : first;
    auto *add = ggml_add(ctx, view, residual);
    auto *norm = ggml_rms_norm(ctx, add, 1e-6f);
    auto *scaled = ggml_mul(ctx, norm, gamma);
    auto *gate = ggml_mul_mat(ctx, gate_w, scaled), *up = ggml_mul_mat(ctx, up_w, scaled);
    auto *activation = ggml_silu(ctx, gate);
    auto *out = ggml_mul(ctx, activation, up);
    ggml_set_output(out);
    // A second consumer extends the residual add's lifetime beyond the norm.
    // The allocator must preserve it even when the local island shares a split.
    auto *residual_out = ggml_scale(ctx, add, 0.5f);
    ggml_set_output(residual_out);
    auto *g = ggml_new_graph_custom(ctx, 128, false);
    ggml_build_forward_expand(g, out); ggml_build_forward_expand(g, residual_out);
    for (auto *node : {add, norm, scaled}) assert(ggml_backend_supports_op(sh, node) == eligible);
    assert(!ggml_backend_supports_op(sh, activation));
    assert(!ggml_backend_supports_op(sh, out));
    assert(!ggml_backend_supports_op(sh, residual_out));
    assert(ggml_backend_sched_alloc_graph(sched, g));
    int local_nodes = 0;
    for (auto *node : {add, norm, scaled}) {
        auto *be = ggml_backend_sched_get_tensor_backend(sched, node);
        const bool on_sh = be && ggml_backend_is_shielded(be);
        assert(on_sh == eligible);
        local_nodes += on_sh;
    }
    for (auto *node : {activation, out, residual_out})
        assert(!ggml_backend_is_shielded(ggml_backend_sched_get_tensor_backend(sched, node)));
    assert(ggml_backend_sched_graph_compute(sched, g) == GGML_STATUS_SUCCESS);
    const auto h1 = hash_tensor(out), r1 = hash_tensor(residual_out);
    // Reuse the exact graph/allocation with different inputs. Cached values
    // from the preceding execution cannot satisfy this result.
    fill_input(x, 23); fill_input(residual, 29);
    assert(ggml_backend_sched_graph_compute(sched, g) == GGML_STATUS_SUCCESS);
    const auto h2 = hash_tensor(out), r2 = hash_tensor(residual_out);
    assert(h1 != h2 && r1 != r2);
    uint64_t off = 0, loc = 0, macs = 0, vf = 0;
    ggml_backend_shielded_stats(&off, &loc, &macs, &vf);
    assert(off == 0 && vf == 0);
    std::printf("{\"island_nodes\":%d,\"output\":[\"%016llx\",\"%016llx\"],\"residual\":[\"%016llx\",\"%016llx\"]}\n",
        local_nodes, (unsigned long long)h1, (unsigned long long)h2, (unsigned long long)r1, (unsigned long long)r2);
    ggml_backend_sched_free(sched);
    ggml_backend_buffer_free(buffer);
    ggml_free(ctx); ggml_free(inputs);
    ggml_backend_free(sh); ggml_backend_free(cpu);
}
