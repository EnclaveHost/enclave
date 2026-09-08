/* Shared-prefix KV artifacts (shielded/dealer/PLAN.md, P4).
 *
 * The shared prefix of a chat (system prompt, tool schemas) is public text,
 * so the platform prefills it once, in the clear, and publishes the resulting
 * KV cache for (model, prefix) as a signed file; a consumer loads it instead
 * of prefilling: no pad rows for the prefix, no minutes of phone prefill, a
 * one-second re-park after a restart. The KV file itself is llama's
 * `llama_state_seq_save_file` of the prefix sequence; the trust is the
 * sidecar `<file>.sig`. Version 2 binds the actual model AND calibration:
 *
 *   enclave-prefix-kv-v2\n
 *   model-sha256 <whole GGUF SHA-256 hex, 64>\n
 *   calib-sha512-256 <first 32 bytes of calibration SHA-512, hex 64>\n
 *   prefix-sha512 <hex, 128>\n
 *   tokens <n>\n
 *   file-sha512 <hex, 128>\n
 *   sig <hex, 128>\n
 *
 * The signature covers all six preceding lines including newlines. Production
 * consumers require v2; v1 historically used the calibration digest as its
 * "model" label and cannot distinguish models sharing a calibration. Its old
 * diagnostic API and format remain available:
 *
 *   enclave-prefix-kv-v1\n
 *   model <model digest hex, 64>\n
 *   prefix-sha512 <hex, 128>\n
 *   tokens <n>\n
 *   file-sha512 <hex, 128>\n
 *   sig <hex, 128>\n
 *
 * `sig` is Ed25519 (TweetNaCl) over the first five lines exactly as written
 * (including their newlines), by the platform's prefix key, which consumers
 * pin the way they pin the ledger key. Nothing here is secret. */
#ifndef SHIELDED_PREFIX_KV_H
#define SHIELDED_PREFIX_KV_H
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Writes `<kv_path>.sig`. `sk` is the 64-byte TweetNaCl Ed25519 secret. */
int sh_prefix_kv_sign(const char *kv_path, const uint8_t model_digest[32], const char *prefix, size_t prefix_len,
                      uint64_t n_tokens, const uint8_t sk[64], char *err, size_t err_cap);
int sh_prefix_kv_sign_v2(const char *kv_path, const uint8_t model_sha256[32], const uint8_t calib_digest[32], const char *prefix, size_t prefix_len,
                         uint64_t n_tokens, const uint8_t sk[64], char *err, size_t err_cap);
/* Verifies `<kv_path>.sig` against the pinned key, this model and this exact
 * prefix text, and the file's own hash. 0 = usable (n_tokens filled in),
 * -1 = not usable (err says why). Never loads anything into llama. */
int sh_prefix_kv_verify(const char *kv_path, const uint8_t pk[32], const uint8_t model_digest[32], const char *prefix, size_t prefix_len,
                        uint64_t *n_tokens_out, char *err, size_t err_cap);
/* Diagnostic verification through a held descriptor. This defeats pathname
 * replacement only: later reads can still see changed contents. Consumers
 * must use snapshot_read and load its retained private bytes instead. */
int sh_prefix_kv_verify_fd(const char *kv_path, int kv_fd, const uint8_t pk[32], const uint8_t model_digest[32], const char *prefix, size_t prefix_len,
                           uint64_t *n_tokens_out, char *err, size_t err_cap);

/* Owns the EXACT private bytes authenticated against the signed sidecar.
 * The caller must consume bytes directly, never re-read the source file.
 * Initialize to zero; pass an empty output (free an earlier snapshot first).
 * On failure output stays empty. max_bytes/max_tokens bound untrusted storage
 * and signed metadata before allocation. The original fd position is unchanged.
 * snapshot_free releases public data and clears all fields. */
typedef struct {
    uint8_t *bytes;
    size_t size;
    uint64_t n_tokens;
} sh_prefix_kv_snapshot;
int sh_prefix_kv_snapshot_read(const char *kv_path, int kv_fd, const uint8_t pk[32], const uint8_t model_digest[32], const char *prefix, size_t prefix_len,
                               size_t max_bytes, uint64_t max_tokens, sh_prefix_kv_snapshot *out, char *err, size_t err_cap);
/* Strict version 2: no fallback to a calibration-only v1 identity. The model
 * digest must come from the trusted stage/pin, never an untrusted cache tag. */
int sh_prefix_kv_snapshot_read_v2(const char *kv_path, int kv_fd, const uint8_t pk[32], const uint8_t model_sha256[32], const uint8_t calib_digest[32], const char *prefix, size_t prefix_len,
                                  size_t max_bytes, uint64_t max_tokens, sh_prefix_kv_snapshot *out, char *err, size_t err_cap);
void sh_prefix_kv_snapshot_free(sh_prefix_kv_snapshot *snapshot);
/* View the sequence-state body in a verified snapshot. This checks the pinned
 * llama file magic/version, signed versus embedded token counts, bounds and
 * token IDs. The format uses little-endian uint32 headers/tokens on our targets.
 * This is the FILE body. The pinned fork's memory API needs an extra envelope;
 * use prefix-kv-llama.h to adapt it, rather than passing this body directly to
 * llama_state_seq_set_data. */
int sh_prefix_kv_snapshot_state(const sh_prefix_kv_snapshot *snapshot, uint32_t magic, uint32_t version, int32_t vocab_size,
                                const uint8_t **state_out, size_t *size_out, char *err, size_t err_cap);

#ifdef __cplusplus
}
#endif
#endif
