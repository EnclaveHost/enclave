/* enclave_llama - the flat C ABI between wasmtime's ggml wasi-nn backend and
 * llama.cpp. llama.h passes structs BY VALUE (llama_model_params, llama_batch),
 * whose layout shifts between llama.cpp releases - hand-rolled Rust FFI against
 * that would be layout-roulette on every bump. This shim pins the boundary to
 * pointers and scalars only (opaque handles, int32/uint32/float*), compiled and
 * shipped INSIDE the prebuilt enclave-llamacpp tarball next to libllama, so the
 * Rust side binds trivial functions that cannot drift. Same story for libmtmd
 * (vision), whose C API also passes structs by value: see the vision block at
 * the bottom.
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
/* host tokenizer (pure vocab lookups; see the .c for conventions) */
int32_t ell_tokenize(void *model, const char *text, int32_t text_len,
                     int32_t *out_ids, int32_t out_cap);
int32_t ell_token_piece(void *model, int32_t id, char *buf, int32_t cap);

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

/* ---- multi-sequence serving (continuous batching) ----------------------
 *
 * ell_new_server: a context that serves up to n_seq_max CONCURRENT sequences
 * out of ONE unified KV pool of n_ctx tokens TOTAL (kv_unified: any sequence
 * may grow into whatever the pool has free - the pool is sized once, not per
 * sequence, which is the whole memory win over one ell_new_context per
 * request). Same type_k/type_v/flash_attn contract as ell_new_context; free
 * with ell_free_context. n_seq_max 1 behaves like ell_new_context.
 *
 * n_ubatch (the physical batch llama splits n_batch into) stays at llama's
 * default unless ENCLAVE_GGML_N_UBATCH is set in the environment. It is read
 * HERE rather than passed, because adding a parameter would silently change
 * this function's ABI for a wasmtime built against an older tarball. Raising
 * it costs compute-buffer VRAM and only matters for vision models that decode
 * images with a non-causal mask, which must hold a whole image in one ubatch.
 *
 * ell_decode_batch: decode n_items sequences' pending tokens in ONE
 * llama_decode call - under load, concurrent requests' decode steps merge
 * into one pass over the weights instead of n_items passes. Flat arrays,
 * item i owning counts[i] tokens:
 *   seq_ids[i]     the sequence the tokens extend (0..n_seq_max-1)
 *   counts[i]      how many tokens item i feeds (>= 1)
 *   positions[i]   the position of item i's FIRST token in its sequence
 *                  (= tokens already decoded into that sequence)
 *   tokens_flat    all items' tokens back to back (sum(counts) <= n_batch)
 * On success writes item i's LAST-token logits (n_vocab floats) to
 * logits_flat + i*n_vocab and returns 0. 1 = the KV pool cannot hold the
 * batch right now (llama restores state - retryable after other sequences
 * finish); other nonzero = decode error. A caller must not have two items
 * for the SAME sequence in one call.
 *
 * ell_seq_remove: drop one finished sequence's tokens from the pool (the
 * slot is reusable immediately). Callers serialize all three calls per
 * context - the shim adds no locking. */
void *ell_new_server(void *model, uint32_t n_ctx, uint32_t n_batch, uint32_t n_seq_max,
                     int32_t type_k, int32_t type_v, int32_t flash_attn);
int32_t ell_decode_batch(void *ctx, void *model, int32_t n_items,
                         const int32_t *seq_ids, const int32_t *counts,
                         const int32_t *positions, const int32_t *tokens_flat,
                         float *logits_flat);
void ell_seq_remove(void *ctx, int32_t seq_id);

/* ---- speculative decoding primitives --------------------------------------
 *
 * ell_decode_seq_full: decode n tokens of ONE sequence and write logits for
 * EVERY position (n rows of n_vocab, in feed order) - the verify step: the
 * target model consumes the draft's proposed tokens in one pass and hands
 * back the distribution at each position. Same position/seq/rc contract as
 * one ell_decode_batch item.
 *
 * ell_seq_rewind: drop a sequence's tokens from position n_keep onward; the
 * next decode continues at n_keep. Returns 0 on success, -1 if the memory
 * REFUSED the partial removal (recurrent/hybrid models keep no per-token
 * state history; nothing is mutated on refusal) - a caller getting -1 must
 * NOT decode further on that sequence as-if rewound. n_keep 0 (= remove
 * everything) always succeeds. Prefer ell_seq_copy branch-verify for
 * speculative rounds: it needs no rewind on any architecture.
 *
 * ell_seq_copy: make dst_seq an exact branch of src_seq (dst's previous
 * contents dropped first). Attention KV cells are SHARED (metadata only);
 * recurrent/hybrid state is copy-on-write - dst diverges into its own state
 * cell at its next decode, leaving src untouched. The speculative pattern:
 * branch target -> verify the draft's tokens on the branch with
 * ell_decode_seq_full -> full accept: ell_seq_copy(branch -> real);
 * partial accept: drop the branch and re-feed only the accepted tokens on
 * the real sequence. Zero extra memory, no snapshots, works on every arch.
 *
 * ell_model_recurrent: 1 when the model carries recurrent (SSM/hybrid)
 * state - partial ell_seq_rewind will fail on such models and branch-verify
 * is the only speculative strategy; 0 = classic attention-only.
 *
 * Callers serialize all calls per context, as with every context call. */
int32_t ell_decode_seq_full(void *ctx, void *model, int32_t seq_id, int32_t pos0,
                            const int32_t *tokens, int32_t n, float *logits_out);
int32_t ell_seq_rewind(void *ctx, int32_t seq_id, int32_t n_keep);
void ell_seq_copy(void *ctx, int32_t src_seq, int32_t dst_seq);
int32_t ell_model_recurrent(void *model);

/* ---- MTP (multi-token prediction) self-drafting ---------------------------
 *
 * When the GGUF carries a trained next-token head (llama arch metadata
 * n_layer_nextn > 0 - the *-MTP model variants), the model drafts for
 * ITSELF: the head runs beside the trunk at near-zero cost, no separate
 * draft model, no second weights allocation. Single-head, own-memory mode
 * only (qwen3.5/3.6; the head is dense attention even on hybrid trunks).
 *
 * Protocol, per accepted-stream sequence (callers serialize all calls, as
 * with every context call; pos/seq bookkeeping mirrors the target's):
 *   ell_mtp_new       one per server context; enables nextn hidden output
 *                     on the target and creates the head context (tiny
 *                     attention KV). NULL = no head in the model / OOM.
 *   ell_mtp_harvest   right after a target decode that produced outputs for
 *                     EVERY position of one sequence (ell_decode_seq_full):
 *                     stash the target's per-position hidden rows. Must run
 *                     before any other target decode overwrites them.
 *   ell_mtp_observe   mirror the round's ACCEPTED tokens into the head KV
 *                     (pairs each token with the hidden row of the position
 *                     before it; row n-1 becomes the next draft seed).
 *                     Requires a preceding harvest of >= n rows. Rejected
 *                     proposals never enter the head - its KV stays clean.
 *   ell_mtp_draft     propose up to k tokens (greedy, stops when the head's
 *                     confidence drops below p_min); returns how many.
 *   ell_mtp_reset     forget one sequence (session teardown).
 *   ell_mtp_available capability probe on a loaded model. */
int32_t ell_mtp_available(void *model);
void *ell_mtp_new(void *model, void *target_ctx, uint32_t n_ctx, uint32_t n_batch,
                  uint32_t n_seq_max, int32_t type_k, int32_t type_v, int32_t flash_attn);
void ell_mtp_free(void *m);
void ell_mtp_harvest(void *m, void *target_ctx, int32_t seq, int32_t n_rows);
int32_t ell_mtp_observe(void *m, int32_t seq, int32_t pos0,
                        const int32_t *tokens, int32_t n);
int32_t ell_mtp_draft(void *m, int32_t seq, int32_t id_last, int32_t n_past,
                      int32_t k, float p_min, int32_t *tokens_out);
void ell_mtp_reset(void *m, int32_t seq);

/* ---- vision (multimodal input) via libmtmd --------------------------------
 *
 * A VLM ships two files: the language GGUF (loaded by ell_load_model like any
 * other model) and an mmproj GGUF holding the vision encoder + projector.
 * libmtmd owns everything model-specific about the pairing: which marker
 * tokens wrap an image (qwen's vision_start/end, gemma's start_of_image),
 * whether the image chunk decodes with a non-causal mask, and how M-RoPE
 * numbers the image's positions. The shim therefore hands mtmd the RAW FILE
 * BYTES and a position, and gets back "this many positions consumed" - no
 * vision knowledge crosses into wasmtime or the guest.
 *
 * These entry points are OPTIONAL: a wasmtime built against an older tarball
 * resolves them at runtime (dlsym) and reports "no vision" when they are
 * absent, so a toolchain bump is what turns vision on, never a rebuild
 * requirement. Keep that property - do not let the ggml backend NEED them at
 * link time.
 *
 * ell_mtmd_caps_file  probe an mmproj without loading it (and without a
 *                     model): bitmask 1 = vision, 2 = audio, 0 = neither,
 *                     -1 = unreadable/not an mmproj. Cheap enough for the
 *                     preload path to classify a volume's ggufs.
 * ell_mtmd_new        load the projector for `model`. n_threads sizes the CPU
 *                     side of preprocessing; use_gpu 1 puts the encoder on the
 *                     GPU (where the share paid for one). image_max_tokens > 0
 *                     caps the tokens ONE image may expand to on dynamic-
 *                     resolution models (0 = the mmproj's own metadata) - the
 *                     lever that keeps a phone photo from eating the KV pool.
 *                     NULL on failure.
 * ell_mtmd_eval_image tokenize + encode + decode ONE image file (whatever
 *                     stb_image reads: png/jpg/webp/gif/bmp) into `seq_id` of
 *                     `lctx` starting at `pos0`, marker tokens included.
 *                     Writes the POSITIONS consumed to n_pos_out (M-RoPE
 *                     makes that differ from token count, which is why the
 *                     caller cannot compute it). n_batch is the caller's
 *                     llama batch size. Returns 0 ok; 1 decode failed;
 *                     2 the bytes are not a decodable image; 3 the image
 *                     needs a larger n_ubatch (non-causal models must hold a
 *                     whole image in one ubatch - raise ENCLAVE_GGML_N_UBATCH);
 *                     -1 bad arguments.
 *
 * Threading: eval is NOT thread-safe against itself or against decode on the
 * same lctx (it drives llama_decode directly and toggles the causal mask).
 * Callers serialize it exactly as they serialize decode. */
/* ell_d2h_probe   times a size_mb device->host copy into pinned (if the
 *                 device's host buffer type allocates - out[0]=1) and plain
 *                 pageable memory; out = [pinned_ok, pinned_us, pageable_us].
 *                 The CVM-side answer to "why do multi-row logits copies
 *                 cost ~20ms under confidential compute". 0 ok, -1 no GPU. */
/* ell_graph_perf  [build_us, sched_alloc_us, set_inputs_us, slot_state]
 *                 from llama_graph_perf; micros read-and-clear, slot_state
 *                 persistent (0/1/-1). 0 ok, -1 null ctx. */
int32_t ell_graph_perf(void *ctx, int64_t *out);

int32_t ell_d2h_probe(int32_t size_mb, int64_t *out);

int32_t ell_mtmd_caps_file(const char *mmproj_path);
void *ell_mtmd_new(void *model, const char *mmproj_path, int32_t n_threads,
                   int32_t use_gpu, int32_t image_max_tokens);
void ell_mtmd_free(void *m);
int32_t ell_mtmd_eval_image(void *m, void *lctx, int32_t seq_id, int32_t pos0,
                            const uint8_t *bytes, uint32_t len, int32_t n_batch,
                            int32_t *n_pos_out);

#ifdef __cplusplus
}
#endif
#endif
