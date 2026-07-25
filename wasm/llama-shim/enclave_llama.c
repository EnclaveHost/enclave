/* enclave_llama.c - see enclave_llama.h for the contract. Built against the
 * PINNED llama.cpp checkout by the enclave-llamacpp toolchain workflow (and by
 * hand for local smokes):
 *
 *   cc -shared -fPIC -Wl,-soname,libenclave_llama.so \
 *      -I<llama.cpp>/include -I<llama.cpp>/ggml/include \
 *      enclave_llama.c -L<llama.cpp>/build/bin -lllama -lggml \
 *      -o libenclave_llama.so
 *
 * The -soname is load-bearing: the wasmtime binary NEEDs "libenclave_llama.so"
 * by that bare name, and in the manager image it is resolved by ldconfig from
 * /usr/local/lib - a soname-less lib is not reliably cached there.
 */
#include "enclave_llama.h"
#include "llama.h"
#include "ggml.h"
#include "ggml-backend.h"

#include <stdlib.h>
#include <string.h>

void ell_init(void) {
    /* GGML_BACKEND_DL builds ship the compute backends (cpu, cuda) as
     * dlopened modules so the wasmtime binary carries no DT_NEEDED on
     * libcuda.so.1 (the driver exists only at runtime, injected by the
     * nvidia container runtime - and never on CPU-flavor nodes). Load them
     * from ENCLAVE_GGML_BACKEND_DIR (NULL = executable dir + cwd). A module
     * whose own deps are unresolvable is skipped silently in release builds;
     * ell_gpu_devices() is how callers check that a GPU actually arrived.
     *
     * Guarded: the sd shim (enclave_sd) shares this process AND this ggml -
     * whichever init runs first loads the modules; loading again would
     * register duplicate devices in ggml's registry. */
    if (ggml_backend_dev_count() == 0) {
        ggml_backend_load_all_from_path(getenv("ENCLAVE_GGML_BACKEND_DIR"));
    }
    llama_backend_init();
}

int32_t ell_gpu_devices(void) {
    int32_t n = 0;
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        if (ggml_backend_dev_type(ggml_backend_dev_get(i)) == GGML_BACKEND_DEVICE_TYPE_GPU) {
            n++;
        }
    }
    return n;
}

void *ell_load_model(const char *path, int32_t n_gpu_layers) {
    struct llama_model_params p = llama_model_default_params();
    p.n_gpu_layers = n_gpu_layers;
    return llama_model_load_from_file(path, p);
}

void ell_free_model(void *model) { llama_model_free((struct llama_model *)model); }

int32_t ell_n_vocab(void *model) {
    return llama_vocab_n_tokens(llama_model_get_vocab((const struct llama_model *)model));
}

/* ell_kv_type code -> ggml_type; unknown falls back to F16 (the llama default). */
static enum ggml_type ell_ggml_kv_type(int32_t t) {
    switch (t) {
        case ELL_KV_Q8_0: return GGML_TYPE_Q8_0;
        case ELL_KV_Q4_0: return GGML_TYPE_Q4_0;
        case ELL_KV_F32:  return GGML_TYPE_F32;
        case ELL_KV_F16:
        default:          return GGML_TYPE_F16;
    }
}

void *ell_new_context(void *model, uint32_t n_ctx, uint32_t n_batch,
                      int32_t type_k, int32_t type_v, int32_t flash_attn) {
    struct llama_context_params p = llama_context_default_params();
    p.n_ctx = n_ctx;
    if (n_batch) { p.n_batch = n_batch; }
    p.type_k = ell_ggml_kv_type(type_k);
    p.type_v = ell_ggml_kv_type(type_v);
    switch (flash_attn) {
        case ELL_FA_ENABLED:  p.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_ENABLED;  break;
        case ELL_FA_DISABLED: p.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED; break;
        case ELL_FA_AUTO:
        default:              p.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_AUTO;     break;
    }
    return llama_init_from_model((struct llama_model *)model, p);
}

void ell_free_context(void *ctx) { llama_free((struct llama_context *)ctx); }

void ell_reset(void *ctx) {
    llama_memory_clear(llama_get_memory((struct llama_context *)ctx), true);
}

int32_t ell_decode(void *ctx, void *model, const int32_t *tokens, int32_t n, float *logits_out) {
    struct llama_context *lctx = (struct llama_context *)ctx;
    if (n <= 0 || (uint32_t)n > llama_n_batch(lctx)) {
        return -1;
    }
    /* llama_batch_get_one wants a mutable pointer but does not write; the
     * cast is safe against the pinned revision (verified at pin time). */
    struct llama_batch batch = llama_batch_get_one((llama_token *)tokens, n);
    int32_t rc = llama_decode(lctx, batch);
    if (rc != 0) {
        return rc;
    }
    const float *logits = llama_get_logits_ith(lctx, -1);
    if (!logits) {
        return -2;
    }
    memcpy(logits_out, logits, (size_t)ell_n_vocab(model) * sizeof(float));
    return 0;
}

void *ell_new_server(void *model, uint32_t n_ctx, uint32_t n_batch, uint32_t n_seq_max,
                     int32_t type_k, int32_t type_v, int32_t flash_attn) {
    struct llama_context_params p = llama_context_default_params();
    p.n_ctx = n_ctx;
    if (n_batch) { p.n_batch = n_batch; }
    if (n_seq_max) { p.n_seq_max = n_seq_max; }
    /* ONE pool of n_ctx tokens shared by every sequence (vs. the split
     * per-stream layout): a long conversation and several short ones coexist
     * without pre-partitioning, which is the sizing model the platform's
     * capacity gates price. */
    p.kv_unified = true;
    p.type_k = ell_ggml_kv_type(type_k);
    p.type_v = ell_ggml_kv_type(type_v);
    switch (flash_attn) {
        case ELL_FA_ENABLED:  p.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_ENABLED;  break;
        case ELL_FA_DISABLED: p.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED; break;
        case ELL_FA_AUTO:
        default:              p.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_AUTO;     break;
    }
    return llama_init_from_model((struct llama_model *)model, p);
}

int32_t ell_decode_batch(void *ctx, void *model, int32_t n_items,
                         const int32_t *seq_ids, const int32_t *counts,
                         const int32_t *positions, const int32_t *tokens_flat,
                         float *logits_flat) {
    struct llama_context *lctx = (struct llama_context *)ctx;
    if (n_items <= 0) {
        return -1;
    }
    int32_t total = 0;
    for (int32_t i = 0; i < n_items; i++) {
        if (counts[i] <= 0 || positions[i] < 0) {
            return -1;
        }
        total += counts[i];
    }
    if ((uint32_t)total > llama_n_batch(lctx)) {
        return -1;
    }
    struct llama_batch batch = llama_batch_init(total, 0, 1);
    int32_t cursor = 0;
    for (int32_t i = 0; i < n_items; i++) {
        for (int32_t t = 0; t < counts[i]; t++) {
            batch.token[cursor]     = tokens_flat[cursor];
            batch.pos[cursor]       = positions[i] + t;
            batch.n_seq_id[cursor]  = 1;
            batch.seq_id[cursor][0] = seq_ids[i];
            batch.logits[cursor]    = (int8_t)(t == counts[i] - 1);
            cursor++;
        }
    }
    batch.n_tokens = total;
    int32_t rc = llama_decode(lctx, batch);
    if (rc != 0) {
        llama_batch_free(batch);
        return rc;
    }
    const size_t row = (size_t)ell_n_vocab(model);
    cursor = 0;
    for (int32_t i = 0; i < n_items; i++) {
        cursor += counts[i];
        const float *logits = llama_get_logits_ith(lctx, cursor - 1);
        if (!logits) {
            llama_batch_free(batch);
            return -2;
        }
        memcpy(logits_flat + (size_t)i * row, logits, row * sizeof(float));
    }
    llama_batch_free(batch);
    return 0;
}

void ell_seq_remove(void *ctx, int32_t seq_id) {
    llama_memory_seq_rm(llama_get_memory((struct llama_context *)ctx), seq_id, -1, -1);
}

int32_t ell_decode_seq_full(void *ctx, void *model, int32_t seq_id, int32_t pos0,
                            const int32_t *tokens, int32_t n, float *logits_out) {
    struct llama_context *lctx = (struct llama_context *)ctx;
    if (n <= 0 || pos0 < 0 || (uint32_t)n > llama_n_batch(lctx)) {
        return -1;
    }
    struct llama_batch batch = llama_batch_init(n, 0, 1);
    for (int32_t t = 0; t < n; t++) {
        batch.token[t]     = tokens[t];
        batch.pos[t]       = pos0 + t;
        batch.n_seq_id[t]  = 1;
        batch.seq_id[t][0] = seq_id;
        batch.logits[t]    = 1;
    }
    batch.n_tokens = n;
    int32_t rc = llama_decode(lctx, batch);
    if (rc != 0) {
        llama_batch_free(batch);
        return rc;
    }
    const size_t row = (size_t)ell_n_vocab(model);
    for (int32_t t = 0; t < n; t++) {
        const float *lg = llama_get_logits_ith(lctx, t);
        if (!lg) {
            llama_batch_free(batch);
            return -2;
        }
        memcpy(logits_out + (size_t)t * row, lg, row * sizeof(float));
    }
    llama_batch_free(batch);
    return 0;
}

void ell_seq_rewind(void *ctx, int32_t seq_id, int32_t n_keep) {
    llama_memory_seq_rm(llama_get_memory((struct llama_context *)ctx), seq_id, n_keep, -1);
}
