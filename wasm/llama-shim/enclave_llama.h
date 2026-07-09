/* enclave_llama - the flat C ABI between wasmtime's ggml wasi-nn backend and
 * llama.cpp. llama.h passes structs BY VALUE (llama_model_params, llama_batch),
 * whose layout shifts between llama.cpp releases - hand-rolled Rust FFI against
 * that would be layout-roulette on every bump. This shim pins the boundary to
 * pointers and scalars only (opaque handles, int32/uint32/float*), compiled and
 * shipped INSIDE the prebuilt enclave-llamacpp tarball next to libllama, so the
 * Rust side binds nine trivial functions that cannot drift.
 *
 * Threading/session model: one ell_context per wasi-nn execution context. The
 * KV cache lives inside it - callers feed token ids (chunked to <= n_batch)
 * and read back logits for the last fed token. ell_reset() starts a fresh
 * sequence without reallocating.
 */
#ifndef ENCLAVE_LLAMA_H
#define ENCLAVE_LLAMA_H
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* once per process, before anything else; loads the dlopened ggml backend
 * modules from ENCLAVE_GGML_BACKEND_DIR (unset = exe dir + cwd) */
void ell_init(void);

/* how many ggml GPU devices the loaded backends expose (0 = the CUDA module
 * or the driver is missing; CPU inference still works) */
int32_t ell_gpu_devices(void);

/* n_gpu_layers: 0 = pure CPU, -1 = offload every layer. NULL on failure. */
void *ell_load_model(const char *path, int32_t n_gpu_layers);
void ell_free_model(void *model);
int32_t ell_n_vocab(void *model);

/* KV-cache element type for ell_new_context's type_k/type_v. Our OWN stable
 * codes, mapped to ggml_type inside the shim (which owns the ggml.h include),
 * so the Rust<->shim scalar ABI never tracks ggml's internal enum numbering. */
enum ell_kv_type {
    ELL_KV_F16  = 0,   /* default - matches llama_context_default_params() */
    ELL_KV_Q8_0 = 1,   /* 8-bit; V-quant REQUIRES flash attention (see below) */
    ELL_KV_Q4_0 = 2,   /* 4-bit; V-quant REQUIRES flash attention */
    ELL_KV_F32  = 3,   /* full precision */
};

/* Flash Attention selector for ell_new_context's flash_attn. A quantized V
 * cache (type_v != F16/F32) is only valid with FA ENABLED; llama.cpp aborts
 * context creation otherwise. AUTO lets llama.cpp decide per model/backend. */
enum ell_flash_attn {
    ELL_FA_AUTO     = 0,   /* default */
    ELL_FA_DISABLED = 1,
    ELL_FA_ENABLED  = 2,
};

/* n_ctx 0 = the model's training context; n_batch = max tokens per ell_decode
 * call. type_k/type_v are ell_kv_type codes (0 = F16 default); flash_attn is an
 * ell_flash_attn code (0 = AUTO). NULL on failure. */
void *ell_new_context(void *model, uint32_t n_ctx, uint32_t n_batch,
                      int32_t type_k, int32_t type_v, int32_t flash_attn);
void ell_free_context(void *ctx);

/* wipe the KV cache: next ell_decode starts a fresh sequence */
void ell_reset(void *ctx);

/* Feed n tokens (n <= n_batch); on success writes n_vocab floats - the logits
 * of the LAST fed token - to logits_out and returns 0. Nonzero = decode error
 * (context overflow, backend failure). */
int32_t ell_decode(void *ctx, void *model, const int32_t *tokens, int32_t n, float *logits_out);

#ifdef __cplusplus
}
#endif
#endif
