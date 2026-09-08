#include "../../wasm/ggml-shielded/shielded-fusion.h"
#include "ggml-cpu.h"
#include <cassert>
#include <cstdio>
#include <limits>

struct tensors {
    ggml_tensor *weight, *x, *residual, *first, *add, *norm, *gamma, *scaled, *gate, *up;
};
static sh_fusion_spec spec = {"blk.3.attn_output.weight", "blk.3.post_attention_norm.weight", 64, 32,
    {{"blk.3.ffn_gate.weight", 96}, {"blk.3.ffn_up.weight", 96}}};

static tensors make(ggml_context *ctx, int m = 4, bool reshape = false, bool reverse_add = false) {
    tensors t = {};
    const auto k = spec.inputs, d = spec.hidden, n = spec.next[0].outputs;
    t.weight = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, k, d);
    ggml_set_name(t.weight, spec.first_weight.c_str());
    t.x = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, k, m);
    t.residual = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, d, m);
    t.first = ggml_mul_mat(ctx, t.weight, t.x);
    auto *v = reshape ? ggml_reshape_2d(ctx, t.first, d, m) : t.first;
    t.add = reverse_add ? ggml_add(ctx, t.residual, v) : ggml_add(ctx, v, t.residual);
    t.norm = ggml_rms_norm(ctx, t.add, 1e-6f);
    t.gamma = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, d);
    ggml_set_name(t.gamma, spec.norm_weight.c_str());
    t.scaled = ggml_mul(ctx, t.norm, t.gamma);
    auto *gate = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, d, n);
    auto *up = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, d, n);
    ggml_set_name(gate, spec.next[0].weight.c_str());
    ggml_set_name(up, spec.next[1].weight.c_str());
    t.gate = ggml_mul_mat(ctx, gate, t.scaled);
    t.up = ggml_mul_mat(ctx, up, t.scaled);
    return t;
}

/* Compute only the local nodes with real ggml CPU kernels, starting from a
 * synthetic first projection. Compare at EVERY boundary, including allocations
 * that reuse the first projection or residual for the subsequent local ops. */
static void arithmetic() {
    for (int d : {32, 1024}) for (int m : {1, 3, 8, 16}) for (int alias : {0, 1, 2}) {
        spec.hidden = d;
        ggml_init_params ip = {16 << 20, nullptr, false};
        auto *ctx = ggml_init(ip); assert(ctx);
        auto ref = make(ctx, m), got = make(ctx, m);
        if (alias) {
            got.add->data = alias == 1 ? got.first->data : got.residual->data;
            got.norm->data = got.add->data;
            got.scaled->data = got.norm->data;
        }
        for (int i = 0; i < d * m; i++) {
            // Include all-zero rows, cancellation and markedly different
            // magnitudes. No random seed or platform distribution is involved.
            const float a = i / d == 0 ? 0 : std::ldexp(float((i * 7) % 61 - 30), (i % 9) - 10);
            const float b = i % 5 == 0 ? -a : a * -0.25f;
            ((float *)ref.first->data)[i] = ((float *)got.first->data)[i] = a;
            ((float *)ref.residual->data)[i] = ((float *)got.residual->data)[i] = b;
        }
        for (int j = 0; j < d; j++)
            ((float *)ref.gamma->data)[j] = ((float *)got.gamma->data)[j] = 0.5f + float(j % 17) / 16;
        sh_fusion_pattern p;
        assert(sh_fusion_match(got.scaled, spec, p));
        std::vector<float> inv(m + 2, -123.0f);
        ggml_tensor *refs[] = {ref.add, ref.norm, ref.scaled};
        ggml_tensor *gots[] = {got.add, got.norm, got.scaled};
        for (int op = 0; op < 3; op++) {
            auto *g = ggml_new_graph_custom(ctx, 8, false);
            ggml_graph_add_node(g, refs[op]);
            refs[op]->flags |= GGML_TENSOR_FLAG_COMPUTE;
            assert(ggml_graph_compute_with_ctx(ctx, g, 1) == GGML_STATUS_SUCCESS);
            assert(sh_fusion_compute_local(gots[op], p, inv.data() + 1, m));
            // Identical float operations and double RMS reduction: no product
            // quantization has been added by this scheduling prerequisite.
            if (std::memcmp(refs[op]->data, gots[op]->data, sizeof(float) * d * m) != 0) {
                for (int j = 0; j < d * m; j++) {
                    const float a = ((float *)refs[op]->data)[j], b = ((float *)gots[op]->data)[j];
                    if (std::memcmp(&a, &b, sizeof a)) {
                        std::fprintf(stderr, "d=%d m=%d alias=%d op=%d at=%d cpu=%a local=%a\n", d, m, alias, op, j, a, b);
                        break;
                    }
                }
                assert(false);
            }
        }
        assert(inv.front() == -123.0f && inv.back() == -123.0f);
        for (int row = 0; row < m; row++) assert(std::isfinite(inv[row + 1]) && inv[row + 1] > 0);
        assert(!sh_fusion_compute_local(got.gate, p, inv.data(), inv.size()));
        assert(!sh_fusion_compute_local(got.norm, p, inv.data(), m - 1));
        assert(!sh_fusion_compute_local(got.norm, p, nullptr, m));
        // Bad numerics must stop the graph before any later projection runs.
        ((float *)got.add->data)[0] = std::numeric_limits<float>::infinity();
        assert(!sh_fusion_compute_local(got.norm, p, inv.data(), m));
        ((float *)got.add->data)[0] = std::numeric_limits<float>::quiet_NaN();
        assert(!sh_fusion_compute_local(got.norm, p, inv.data(), m));
        ggml_free(ctx);
    }
    spec.hidden = 32;
}
static ggml_cgraph *graph(ggml_context *ctx, ggml_tensor *last) {
    auto *g = ggml_new_graph_custom(ctx, 64, false);
    ggml_build_forward_expand(g, last);
    return g;
}

int main() {
    ggml_init_params ip = {1 << 20, nullptr, true};
    auto *ctx = ggml_init(ip); assert(ctx);
    sh_fusion_pattern p;
    for (int m : {1, 3, 8, 16}) for (bool reshape : {false, true}) for (bool reverse : {false, true}) {
        auto t = make(ctx, m, reshape, reverse);
        for (auto *node : {t.add, t.norm, t.scaled, t.gate, t.up}) assert(sh_fusion_match(node, spec, p));
        assert(p.first == t.first && p.residual == t.residual && p.add == t.add &&
            p.norm == t.norm && p.scaled == t.scaled && p.next == t.up && p.eps == 1e-6f);
        assert(sh_fusion_ready(graph(ctx, t.up), p));
        // A scheduler split without the local norm island cannot execute it.
        auto *split = ggml_new_graph_custom(ctx, 8, false);
        ggml_graph_add_node(split, t.first); ggml_graph_add_node(split, t.up);
        assert(!sh_fusion_ready(split, p));
        ggml_reset(ctx);
    }
    auto t = make(ctx);
    assert(!sh_fusion_match(nullptr, spec, p));
    assert(!sh_fusion_match(t.first, spec, p));
    auto wrong = spec; wrong.first_weight = "blk.2.attn_output.weight";
    assert(!sh_fusion_match(t.gate, wrong, p));
    wrong = spec; wrong.norm_weight = "blk.3.attn_norm.weight";
    assert(!sh_fusion_match(t.gate, wrong, p));
    wrong = spec; wrong.inputs = 128;
    assert(!sh_fusion_match(t.gate, wrong, p));
    wrong = spec; wrong.next[0].outputs = 32;
    assert(!sh_fusion_match(t.gate, wrong, p));
    for (float eps : {0.0f, -1.0f, std::numeric_limits<float>::infinity(), std::numeric_limits<float>::quiet_NaN()}) {
        std::memcpy(t.norm->op_params, &eps, sizeof eps);
        assert(!sh_fusion_match(t.gate, spec, p));
    }
    float eps = 1e-6f; std::memcpy(t.norm->op_params, &eps, sizeof eps);
    auto x = *t.x; x.nb[1] *= 2; t.first->src[1] = &x;
    assert(!sh_fusion_match(t.gate, spec, p)); t.first->src[1] = t.x;
    auto weight = *t.weight; weight.type = GGML_TYPE_F16; t.first->src[0] = &weight;
    assert(!sh_fusion_match(t.gate, spec, p)); t.first->src[0] = t.weight;
    auto *old_residual = t.add->src[1];
    t.add->src[1] = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, 32, 1);
    assert(!sh_fusion_match(t.gate, spec, p)); t.add->src[1] = old_residual;
    t.add->src[1] = t.first;
    assert(!sh_fusion_match(t.gate, spec, p)); t.add->src[1] = old_residual;
    auto alias = *t.first; alias.op = GGML_OP_VIEW; alias.src[0] = t.first;
    t.add->src[0] = &alias;
    assert(!sh_fusion_match(t.gate, spec, p));
    alias.op = GGML_OP_RESHAPE; alias.src[0] = &alias;
    assert(!sh_fusion_match(t.gate, spec, p)); t.add->src[0] = t.first;
    // An extra branch/bias after the first projection is not the algebra.
    t.add->src[0] = ggml_add(ctx, t.first, t.residual);
    assert(!sh_fusion_match(t.gate, spec, p)); t.add->src[0] = t.first;
    // Gamma must be a public leaf weight, not a runtime-computed multiplier.
    t.gamma->op = GGML_OP_SCALE;
    assert(!sh_fusion_match(t.gate, spec, p)); t.gamma->op = GGML_OP_NONE;
    // A residual produced from first matches the local island's shape but
    // cannot be consumed early. The execution-readiness check must reject it.
    t.add->src[1] = ggml_scale(ctx, t.first, 0.5f);
    assert(sh_fusion_match(t.gate, spec, p));
    assert(!sh_fusion_ready(graph(ctx, t.gate), p));
    ggml_free(ctx);
    arithmetic();
    std::puts("fusion pattern, ordering and CPU arithmetic: ok");
}
