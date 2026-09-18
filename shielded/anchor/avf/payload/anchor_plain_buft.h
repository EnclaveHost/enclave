/* anchor_plain_buft.h -- a plain host buffer type that is NOT ggml_backend_cpu_buffer_type() by pointer (C++ only).
 * llama.cpp's tensor_buft_overrides treat an override to the CPU type as "still consider the CPU backend's extra buffer
 * types", so REPACK wins anyway; a distinct type is taken verbatim. It delegates everything to the CPU type. Weights an
 * offloading backend claims live here: host memory (so ggml's scheduler offers the op to the backend's offload_op), never
 * repacked (the bytes are not what that backend multiplies by anyway). Same trick as engine.cpp's CPU_plain. */
#ifndef ANCHOR_PLAIN_BUFT_H
#define ANCHOR_PLAIN_BUFT_H
#include "ggml-backend.h"
#include "ggml-backend-impl.h"
static const char *anchor_plain_name(ggml_backend_buffer_type_t) { return "CPU_plain"; }
static ggml_backend_buffer_t anchor_plain_alloc(ggml_backend_buffer_type_t buft, size_t size) {
    ggml_backend_buffer_t b = ggml_backend_buft_alloc_buffer(ggml_backend_cpu_buffer_type(), size); if (b) b->buft = buft; return b; }
static size_t anchor_plain_alignment(ggml_backend_buffer_type_t) { return ggml_backend_buft_get_alignment(ggml_backend_cpu_buffer_type()); }
static size_t anchor_plain_max_size(ggml_backend_buffer_type_t) { return ggml_backend_buft_get_max_size(ggml_backend_cpu_buffer_type()); }
static size_t anchor_plain_alloc_size(ggml_backend_buffer_type_t, const struct ggml_tensor *t) { return ggml_backend_buft_get_alloc_size(ggml_backend_cpu_buffer_type(), t); }
static bool anchor_plain_is_host(ggml_backend_buffer_type_t) { return true; }
static inline ggml_backend_buffer_type_t anchor_plain_buft(void) {
    static struct ggml_backend_buffer_type t = { { anchor_plain_name, anchor_plain_alloc, anchor_plain_alignment, anchor_plain_max_size, anchor_plain_alloc_size, anchor_plain_is_host }, nullptr, nullptr };
    if (!t.device) t.device = ggml_backend_buft_get_device(ggml_backend_cpu_buffer_type());
    return &t;
}
#define ANCHOR_TPU_CLAIM_PATTERN "^blk\\.[0-9]+\\.(attn_q|attn_k|attn_v|attn_output|ffn_gate|ffn_up|ffn_down)\\.weight$"
#endif
