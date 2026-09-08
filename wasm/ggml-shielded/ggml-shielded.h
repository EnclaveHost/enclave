/*
 * ggml-shielded.h -- a GGML backend that offloads linear ops to a GPU whose host
 * is fully untrusted.
 *
 * This is the piece REPORT.md calls "the production engine" and lists as open
 * item 1: without it the shielded tier is a protocol and a worker with nothing
 * able to drive them, and a metal box advertises a shielded pool that nothing can
 * buy. shielded/model.py is the specification; this is the same op placement in
 * the engine, so an ordinary ggml graph -- llama.cpp, whisper.cpp, sd.cpp -- gets
 * the tier without knowing it exists.
 *
 * HOW THE SPLIT HAPPENS. ggml_backend_sched already partitions a graph across a
 * priority-ordered backend list and inserts the copies. By default this backend
 * claims matmuls against q8_0 weights it has calibration for; everything else --
 * softmax, norms, SiLU, rope, attention, sampling -- lands on the CPU backend,
 * inside the enclave. SHIELDED_FUSE_LOCAL=1 additionally keeps recognized
 * residual-add/RMSNorm/gamma islands on this backend, executing those operations
 * LOCALLY in the enclave on the caller thread. It changes no exchange or weight
 * encoding and is only a scheduling prerequisite for future product fusion.
 * The classifier uses public tensor metadata and launch configuration, so
 * it is deterministic across decode steps, which is what stops sched reallocating
 * and forcing a full graph resend every token.
 *
 * WHAT CROSSES. Public weights, once, in the clear. Then one-time-padded
 * activations and their masked products, and nothing else, ever. Plaintext
 * activations, the pads, the KV cache, the Freivalds secret and the sampling state
 * never leave the CVM.
 *
 * WHAT THIS IS NOT. It is not a confidentiality boundary by itself -- the masks
 * are. The worker is assumed hostile and is expected to read every byte it gets.
 */
#ifndef GGML_SHIELDED_H
#define GGML_SHIELDED_H

#include "ggml.h"
#include "ggml-backend.h"
#include "shielded-tee.h"

#ifdef __cplusplus
extern "C" {
#endif

GGML_BACKEND_API ggml_backend_t     ggml_backend_shielded_init(void);
GGML_BACKEND_API bool               ggml_backend_is_shielded(ggml_backend_t backend);
GGML_BACKEND_API ggml_backend_reg_t ggml_backend_shielded_reg(void);

/* Where the worker is, and which calibration to trust. Both default from the
 * environment (SHIELDED_HOST, SHIELDED_PORT, SHIELDED_CALIB) so an engine can
 * enable the tier as launch configuration without an app-visible API -- which is
 * the point: existing catalog guests keep their wasi-nn contract unchanged. */
GGML_BACKEND_API void ggml_backend_shielded_configure(const char *host, int port,
                                                      const char *calib_path);

/* Optional source authentication, installed once BEFORE loading/reserving any
 * model graph. The callback must match name/type/dimensions/length AND digest
 * against a trusted model manifest; SH_OK alone admits the tensor. Bytes are a
 * PRIVATE copy that the backend then encodes without rereading the source.
 * The callback/context must outlive the backend and must not reenter it.
 * Verified weights use their encoded representation for local fallback;
 * unverified original mappings are never used as an escape hatch. This API
 * does not authenticate llama's metadata or tensors placed on another backend. */
typedef int (*ggml_shielded_weight_verifier)(void *ctx, const char *name,
    uint32_t type, const int64_t ne[4], const void *bytes, size_t nbytes);
GGML_BACKEND_API int ggml_backend_shielded_set_weight_verifier(
    ggml_shielded_weight_verifier verifier, void *ctx);

/* Optional streamed PUBLIC weights. The reader fills exactly nbytes of private
 * storage; it may read an untrusted file. The installed verifier authenticates
 * those same bytes before encoding or copying them to another backend.
 * This non-host buffer exposes no readable weight mapping. CPU fallback goes
 * through authenticated copies; a failed generic ggml read aborts the process
 * because that API has no error return. A fallback copy may require one whole
 * tensor in RAM. Partial reads still authenticate the entire source tensor.
 *
 * Install the verifier first. tensor must have no data and either no buffer or
 * a zero-size no_alloc placeholder. Success attaches the returned buffer to
 * tensor; failure returns NULL without changing it. Caller owns the buffer and
 * must keep it, the reader/context and verifier/context alive until every model
 * and graph using the tensor is destroyed. This does not authenticate metadata. */
typedef int (*ggml_shielded_weight_reader)(void *ctx, const char *name,
    uint32_t type, const int64_t ne[4], void *bytes, size_t nbytes);
GGML_BACKEND_API ggml_backend_buffer_t ggml_backend_shielded_weight_source(
    struct ggml_tensor *tensor, ggml_shielded_weight_reader reader, void *ctx);
/* Cumulative encoded-cache read requests and bytes actually read from storage,
 * including block authentication over-read. Snapshot after prefill and decode
 * to distinguish initial upload from steady inference I/O. */
GGML_BACKEND_API void ggml_backend_shielded_weight_cache_stats(uint64_t *calls, uint64_t *bytes);

/* Capability probe used by the manager before admitting a pooled tenant. */
GGML_BACKEND_API int ggml_backend_shielded_pool_version(void);
/* Dealt pads: mint one .pads shipment from the registered weights (single
 * link). Hex arguments: seed 64, seed_id 32, model digest 64, consumer X25519
 * public key 64. Returns SH_OK or an sh error. */
/* Dealt pads: ledger windows from the host (a pVM's owner-app path) instead of
 * SHIELDED_PAD_LEDGER. Install before the first graph. */
GGML_BACKEND_API void ggml_backend_shielded_set_window_provider(sh_window_fn fn, void *ctx);
/* The same, through the card's worker (dealer runs with SHIELDED_ZERO_PADS=1). */
GGML_BACKEND_API int ggml_backend_shielded_mint_worker(const char *seed_hex, const char *seed_id_hex, const char *digest_hex,
                                                       uint64_t index0, uint64_t count, const char *consumer_pk_hex, const char *path);
GGML_BACKEND_API int ggml_backend_shielded_mint(const char *seed_hex, const char *seed_id_hex, const char *digest_hex,
                                                uint64_t index0, uint64_t count, const char *consumer_pk_hex, const char *path);

/* Pads consumed (one cell per weight group per token row) and missed, summed
 * over the cards: the quantity a dealt-pads usage receipt reports. */
GGML_BACKEND_API void ggml_backend_shielded_pads_used(uint64_t *used, uint64_t *missed);
/* Counters for the boot probe and the supervisor's verdict. */
GGML_BACKEND_API void ggml_backend_shielded_stats(uint64_t *offloaded_nodes,
                                                  uint64_t *local_nodes,
                                                  uint64_t *macs,
                                                  uint64_t *verify_fail);

#ifdef __cplusplus
}
#endif
#endif
