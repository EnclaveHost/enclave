/* Structural matcher for the optional residual/RMSNorm projection fusion.
 * The matcher inspects no tensor values. Before fusing projections, a caller
 * must authenticate the specification and product weights, then check placement
 * and graph readiness. The scheduling-only local path needs no product bundle.
 * Matching a prefix permits the backend to keep its LOCAL add/norm/mul in the
 * same scheduler split as the two projections; it never offloads those ops. */
#ifndef SHIELDED_FUSION_H
#define SHIELDED_FUSION_H

#include "ggml.h"
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

struct sh_fusion_member {
    std::string weight;
    int64_t outputs = 0;
};
struct sh_fusion_spec {
    std::string first_weight;
    std::string norm_weight;
    int64_t inputs = 0;
    int64_t hidden = 0;
    std::vector<sh_fusion_member> next;
};
struct sh_fusion_pattern {
    const ggml_tensor *first = nullptr;
    const ggml_tensor *residual = nullptr;
    const ggml_tensor *add = nullptr;
    const ggml_tensor *norm = nullptr;
    const ggml_tensor *scaled = nullptr;
    const ggml_tensor *next = nullptr;
    float eps = 0;
};

static inline bool sh_fusion_matrix(const ggml_tensor *t, ggml_type type, int64_t width, int64_t rows) {
    return t && width > 0 && rows > 0 && t->type == type &&
        t->ne[0] == width && t->ne[1] == rows && t->ne[2] == 1 && t->ne[3] == 1 &&
        ggml_is_contiguous(t);
}

/* Qwen3.5's SSM output has a reshape between projection and residual add.
 * Only contiguous aliases with identical matrix geometry can be elided.
 * Views, transposes and permutations are intentionally not recognized. */
static inline const ggml_tensor *sh_fusion_unwrap(const ggml_tensor *t) {
    for (int depth = 0; t && t->op == GGML_OP_RESHAPE; depth++) {
        const auto *src = t->src[0];
        if (depth == 4 || !src || src == t || src->type != t->type ||
            !ggml_are_same_shape(t, src) || !ggml_is_contiguous(t) || !ggml_is_contiguous(src)) return nullptr;
        t = src;
    }
    return t;
}

static inline bool sh_fusion_match_add(const ggml_tensor *node, const sh_fusion_spec &spec, sh_fusion_pattern &out) {
    if (!node || node->op != GGML_OP_ADD || !sh_fusion_matrix(node, GGML_TYPE_F32, spec.hidden, node->ne[1])) return false;
    const int64_t m = node->ne[1];
    for (int side = 0; side < 2; side++) {
        const auto *first = sh_fusion_unwrap(node->src[side]);
        const auto *residual = node->src[1 - side];
        if (!first || first->op != GGML_OP_MUL_MAT || !first->src[0] ||
            spec.first_weight != ggml_get_name(first->src[0]) ||
            !sh_fusion_matrix(first, GGML_TYPE_F32, spec.hidden, m) ||
            !sh_fusion_matrix(first->src[0], GGML_TYPE_Q8_0, spec.inputs, spec.hidden) ||
            !sh_fusion_matrix(first->src[1], GGML_TYPE_F32, spec.inputs, m) ||
            !sh_fusion_matrix(residual, GGML_TYPE_F32, spec.hidden, m) ||
            sh_fusion_unwrap(residual) == first) continue;
        out = {};
        out.first = first; out.residual = residual; out.add = node;
        return true;
    }
    return false;
}

/* Accept only add -> RMSNorm(eps) -> mul(public gamma) -> calibrated matmul.
 * The prefix forms support scheduler ownership; only a match with next !=
 * nullptr is an executable fusion candidate. A bias, LoRA branch, broadcast
 * residual, noncontiguous view or unrelated norm must retain the normal path. */
static inline bool sh_fusion_match(const ggml_tensor *node, const sh_fusion_spec &spec, sh_fusion_pattern &out) {
    if (!node) return false;
    if (node->op == GGML_OP_ADD) return sh_fusion_match_add(node, spec, out);
    if (node->op == GGML_OP_RMS_NORM) {
        sh_fusion_pattern p;
        float eps;
        std::memcpy(&eps, node->op_params, sizeof eps);
        if (!std::isfinite(eps) || eps <= 0 || !sh_fusion_match_add(node->src[0], spec, p) ||
            !sh_fusion_matrix(node, GGML_TYPE_F32, spec.hidden, p.add->ne[1])) return false;
        p.norm = node; p.eps = eps; out = p;
        return true;
    }
    if (node->op == GGML_OP_MUL) {
        for (int side = 0; side < 2; side++) {
            const auto *norm = node->src[side], *gamma = node->src[1 - side];
            sh_fusion_pattern p;
            if (!norm || norm->op != GGML_OP_RMS_NORM || !gamma || gamma->op != GGML_OP_NONE ||
                spec.norm_weight != ggml_get_name(gamma) ||
                !sh_fusion_matrix(gamma, GGML_TYPE_F32, spec.hidden, 1) ||
                !sh_fusion_match(norm, spec, p) ||
                !sh_fusion_matrix(node, GGML_TYPE_F32, spec.hidden, p.add->ne[1])) continue;
            p.scaled = node; out = p;
            return true;
        }
        return false;
    }
    if (node->op == GGML_OP_MUL_MAT) {
        const auto *weight = node->src[0], *scaled = node->src[1];
        if (!weight || !scaled || scaled->op != GGML_OP_MUL) return false;
        for (const auto &member : spec.next) {
            sh_fusion_pattern p;
            if (member.weight != ggml_get_name(weight) ||
                !sh_fusion_matrix(weight, GGML_TYPE_Q8_0, spec.hidden, member.outputs) ||
                !sh_fusion_match(scaled, spec, p) ||
                !sh_fusion_matrix(node, GGML_TYPE_F32, member.outputs, p.add->ne[1])) continue;
            p.next = node; out = p;
            return true;
        }
    }
    return false;
}

/* The residual must already be available when the first projection is due.
 * An input outside this scheduler split is ready by the scheduler's contract;
 * a producer inside it must precede first. This check also rejects a residual
 * that depends on first through other ops, which cannot be folded early. */
static inline bool sh_fusion_ready(ggml_cgraph *graph, const sh_fusion_pattern &p) {
    if (!graph || !p.first || !p.residual || !p.next) return false;
    const auto *residual = sh_fusion_unwrap(p.residual);
    if (!residual || residual == p.first) return false;
    int first = -1, add = -1, norm = -1, scaled = -1, next = -1, input = -1;
    for (int i = 0; i < ggml_graph_n_nodes(graph); i++) {
        const auto *node = ggml_graph_node(graph, i);
        if (node == p.first) first = i;
        if (node == p.add) add = i;
        if (node == p.norm) norm = i;
        if (node == p.scaled) scaled = i;
        if (node == p.next) next = i;
        if (node == residual) input = i;
    }
    return first >= 0 && (input < 0 || input < first) &&
        first < add && add < norm && norm < scaled && scaled < next;
}

/* Execute ONE matched local op at its normal graph position. Do not execute
 * the island early: scheduler allocations may alias tensors whose lifetimes
 * end between these ops. The RMS computation follows ggml-cpu/ops.cpp: each
 * square is float, accumulation is double, mean/scale are float. Retaining the
 * scale avoids recomputing a norm when the fused next projection is decoded.
 * These small vector ops use the caller thread, avoiding a new CPU threadpool
 * or extra scheduling barriers at every local op. */
static inline bool sh_fusion_compute_local(const ggml_tensor *node, const sh_fusion_pattern &p,
                                           float *inv_rms, size_t inv_capacity) {
    if (!node || !node->data || !p.add || !p.first || !p.residual) return false;
    const int64_t d = p.add->ne[0], m = p.add->ne[1];
    auto *dst = (float *)node->data;
    if (node == p.add) {
        if (!p.first->data || !p.residual->data) return false;
        const auto *a = (const float *)p.first->data, *b = (const float *)p.residual->data;
        for (int64_t i = 0; i < m * d; i++) dst[i] = a[i] + b[i];
        return true;
    }
    if (node == p.norm) {
        if (!p.add->data || !inv_rms || inv_capacity < (size_t)m) return false;
        const auto *src = (const float *)p.add->data;
        for (int64_t row = 0; row < m; row++) {
            double sum = 0;
            for (int64_t j = 0; j < d; j++) sum += (double)(src[row * d + j] * src[row * d + j]);
            const float mean = (float)(sum / d);
            const float scale = 1.0f / std::sqrt(mean + p.eps);
            if (!std::isfinite(scale) || scale <= 0) return false;
            inv_rms[row] = scale;
            for (int64_t j = 0; j < d; j++) dst[row * d + j] = src[row * d + j] * scale;
        }
        return true;
    }
    if (node == p.scaled) {
        const auto *gamma = node->src[node->src[0] == p.norm ? 1 : 0];
        if (!p.norm || !p.norm->data || !gamma || !gamma->data) return false;
        const auto *src = (const float *)p.norm->data, *g = (const float *)gamma->data;
        for (int64_t row = 0; row < m; row++)
            for (int64_t j = 0; j < d; j++) dst[row * d + j] = src[row * d + j] * g[j];
        return true;
    }
    return false;
}
#endif
