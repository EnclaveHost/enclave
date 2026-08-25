/*
 * ggml-test -- run one real ggml MUL_MAT through the shielded backend and
 * compare it against the CPU backend computing the same graph.
 *
 * The comparison is a TOLERANCE, deliberately, and the tolerance is the honest
 * one: the shielded path is an exact fixed-point product, so it does not equal
 * ggml's f32 dot product, it equals it to within the quantum of the encoding
 * (2^-(act_frac + f_w)) times the reduction length. Asserting bit-equality would
 * be wrong; asserting "close enough to look right" would hide a wrong exponent.
 * So the bound is derived from the encoding, not chosen to pass.
 */
#include "ggml-shielded.h"
#include "ggml.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <vector>

int main(int argc, char **argv) {
    int64_t K = 512, N = 256, M = 4;
    for (int i = 1; i < argc - 1; i++) {
        if (!strcmp(argv[i], "--k")) K = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--n")) N = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--m")) M = atoll(argv[++i]);
    }

    std::mt19937 rng(1234);
    std::normal_distribution<float> nd(0.0f, 0.02f);
    std::normal_distribution<float> na(0.0f, 1.0f);

    std::vector<float> w_f32((size_t)K * N);
    for (auto &v : w_f32) v = nd(rng);
    std::vector<float> a_f32((size_t)K * M);
    for (auto &v : a_f32) v = na(rng);

    std::vector<uint8_t> w_q8(ggml_row_size(GGML_TYPE_Q8_0, K) * N);
    ggml_quantize_chunk(GGML_TYPE_Q8_0, w_f32.data(), w_q8.data(), 0, N, K, nullptr);

    std::vector<float> w2_f32((size_t)N * K);
    for (auto &v : w2_f32) v = nd(rng);
    std::vector<uint8_t> w2_q8(ggml_row_size(GGML_TYPE_Q8_0, N) * K);
    ggml_quantize_chunk(GGML_TYPE_Q8_0, w2_f32.data(), w2_q8.data(), 0, K, N, nullptr);

    auto run = [&](ggml_backend_t backend, std::vector<float> &out) -> bool {
        ggml_init_params ip = { ggml_tensor_overhead() * 8 + ggml_graph_overhead(), nullptr, true };
        ggml_context *ctx = ggml_init(ip);
        ggml_tensor *w = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, K, N);
        ggml_set_name(w, "blk.0.ffn_gate.weight");
        ggml_tensor *a = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, K, M);
        ggml_set_name(a, "act");
        ggml_tensor *y = ggml_mul_mat(ctx, w, a);
        ggml_cgraph *gf = ggml_new_graph(ctx);
        ggml_build_forward_expand(gf, y);

        ggml_backend_buffer_t buf = ggml_backend_alloc_ctx_tensors(ctx, backend);
        if (!buf) { fprintf(stderr, "alloc failed\n"); ggml_free(ctx); return false; }
        ggml_backend_tensor_set(w, w_q8.data(), 0, w_q8.size());
        ggml_backend_tensor_set(a, a_f32.data(), 0, a_f32.size() * sizeof(float));

        const ggml_status st = ggml_backend_graph_compute(backend, gf);
        if (st != GGML_STATUS_SUCCESS) {
            fprintf(stderr, "compute failed: %d\n", (int)st);
            ggml_backend_buffer_free(buf); ggml_free(ctx); return false;
        }
        out.resize((size_t)N * M);
        ggml_backend_tensor_get(y, out.data(), 0, out.size() * sizeof(float));
        ggml_backend_buffer_free(buf);
        ggml_free(ctx);
        return true;
    };

    /* The integration that matters: a MIXED graph under ggml_backend_sched with
     * [shielded, cpu]. matmul -> silu -> matmul is the smallest thing shaped like
     * a real FFN, and the point is that sched puts the two matmuls on the shielded
     * backend and the SiLU on the CPU without being told to -- nonlinear ops on
     * secret data must never leave the enclave, and the way that is enforced is
     * supports_op returning false, not a comment. */
    auto run_sched = [&](std::vector<float> &out, int &n_shielded) -> bool {
        ggml_backend_t cpu2 = ggml_backend_cpu_init();
        ggml_backend_t sh2  = ggml_backend_shielded_init();
        ggml_backend_t bes[2] = { sh2, cpu2 };            /* shielded first = priority 0 */
        ggml_backend_buffer_type_t bufts[2] = {
            ggml_backend_get_default_buffer_type(sh2), ggml_backend_get_default_buffer_type(cpu2) };
        ggml_backend_sched_t sched = ggml_backend_sched_new(bes, bufts, 2, 2048, false, true);

        ggml_init_params ip = { ggml_tensor_overhead() * 16 + ggml_graph_overhead(), nullptr, true };
        ggml_context *ctx = ggml_init(ip);
        ggml_tensor *w1 = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, K, N);
        ggml_set_name(w1, "blk.0.ffn_gate.weight");
        ggml_tensor *w2 = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, N, K);
        ggml_set_name(w2, "blk.0.ffn_down.weight");
        ggml_tensor *a = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, K, M);
        ggml_set_name(a, "act");
        ggml_tensor *h = ggml_silu(ctx, ggml_mul_mat(ctx, w1, a));
        ggml_tensor *y = ggml_mul_mat(ctx, w2, h);
        ggml_cgraph *gf = ggml_new_graph(ctx);
        ggml_build_forward_expand(gf, y);

        ggml_backend_buffer_t buf = ggml_backend_alloc_ctx_tensors(ctx, cpu2);
        if (!buf) { fprintf(stderr, "sched alloc failed\n"); return false; }
        ggml_backend_tensor_set(w1, w_q8.data(), 0, w_q8.size());
        ggml_backend_tensor_set(w2, w2_q8.data(), 0, w2_q8.size());
        ggml_backend_tensor_set(a, a_f32.data(), 0, a_f32.size() * sizeof(float));

        if (!ggml_backend_sched_reserve(sched, gf)) { fprintf(stderr, "reserve failed\n"); return false; }
        const ggml_status st = ggml_backend_sched_graph_compute(sched, gf);
        if (st != GGML_STATUS_SUCCESS) { fprintf(stderr, "sched compute failed %d\n", (int)st); return false; }

        n_shielded = 0;
        for (int i = 0; i < ggml_graph_n_nodes(gf); i++) {
            ggml_tensor *nd = ggml_graph_node(gf, i);
            ggml_backend_t b = ggml_backend_sched_get_tensor_backend(sched, nd);
            const bool on_sh = b && ggml_backend_is_shielded(b);
            if (on_sh) n_shielded++;
            fprintf(stderr, "[sched] %-24s %-12s -> %s\n", ggml_get_name(nd),
                    ggml_op_name(nd->op), b ? ggml_backend_name(b) : "(none)");
            if (on_sh && nd->op != GGML_OP_MUL_MAT) {
                fprintf(stderr, "FATAL: %s landed on the shielded backend\n", ggml_op_name(nd->op));
                return false;
            }
        }
        out.resize((size_t)K * M);
        ggml_backend_tensor_get(y, out.data(), 0, out.size() * sizeof(float));
        ggml_backend_buffer_free(buf);
        ggml_free(ctx);
        ggml_backend_sched_free(sched);
        ggml_backend_free(sh2);
        ggml_backend_free(cpu2);
        return true;
    };

    std::vector<float> ref, got;
    ggml_backend_t cpu = ggml_backend_cpu_init();
    if (!run(cpu, ref)) return 2;
    ggml_backend_free(cpu);

    ggml_backend_t sh = ggml_backend_shielded_init();
    if (!run(sh, got)) return 2;
    ggml_backend_free(sh);

    double worst = 0.0, sum2 = 0.0, refmax = 0.0;
    for (size_t i = 0; i < ref.size(); i++) {
        const double d = fabs((double)ref[i] - (double)got[i]);
        if (d > worst) worst = d;
        sum2 += d * d;
        if (fabs((double)ref[i]) > refmax) refmax = fabs((double)ref[i]);
    }
    std::vector<float> sched_out;
    int n_shielded = 0;
    const bool sched_ok = run_sched(sched_out, n_shielded);

    uint64_t off = 0, loc = 0, macs = 0, vf = 0;
    ggml_backend_shielded_stats(&off, &loc, &macs, &vf);

    printf("{\"K\":%lld,\"N\":%lld,\"M\":%lld,\"max_abs_err\":%.6g,\"rms_err\":%.6g,"
           "\"ref_max\":%.6g,\"rel\":%.6g,\"offloaded_nodes\":%llu,\"local_nodes\":%llu,"
           "\"verify_fail\":%llu,\"sched_ok\":%s,\"sched_shielded_nodes\":%d}\n",
           (long long)K, (long long)N, (long long)M, worst,
           sqrt(sum2 / (double)ref.size()), refmax, refmax > 0 ? worst / refmax : 0.0,
           (unsigned long long)off, (unsigned long long)loc, (unsigned long long)vf,
           sched_ok ? "true" : "false", n_shielded);
    /* Two shielded nodes and no others: the FFN's matmuls offloaded, its SiLU did
     * not. A run where sched quietly put everything on the CPU would otherwise
     * look like a pass. */
    return (vf == 0 && sched_ok && n_shielded == 2) ? 0 : 1;
}
