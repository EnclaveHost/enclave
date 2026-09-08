#pragma once

#include "prefix-kv.h"
#include "llama.h"
#include <cstdio>
#include <cstring>
#include <vector>
#include <exception>

/* The pinned llama fork's memory-state API adds an eight-byte envelope that
 * its sequence files omit. Obtain that envelope from the live library instead
 * of duplicating its private magic. The destination must be a fresh sequence;
 * its empty serialized state is small (460 bytes for our 0.8B fixture).
 *
 * This consumes the snapshot: after validating its file envelope, replace
 * eight already-checked token/header bytes immediately before the state body.
 * The body remains the exact authenticated private bytes, with no second
 * file read or full-sized copy. Free the snapshot after this call. */
static inline int sh_prefix_kv_load_snapshot(llama_context *ctx, sh_prefix_kv_snapshot *snapshot,
                                            llama_seq_id sequence, int32_t vocab_size, char *err, size_t err_cap) {
    if (!ctx || !snapshot || !snapshot->n_tokens || snapshot->n_tokens > llama_n_ctx(ctx)) {
        std::snprintf(err, err_cap, "prefix tokens exceed the destination context"); return -1;
    }
    const uint8_t *body = nullptr; size_t body_size = 0;
    if (sh_prefix_kv_snapshot_state(snapshot, LLAMA_STATE_SEQ_MAGIC, LLAMA_STATE_SEQ_VERSION,
                                   vocab_size, &body, &body_size, err, err_cap)) return -1;
    try {
        const size_t envelope_state_size = llama_state_seq_get_size(ctx, sequence);
        // A populated sequence would need an unnecessary potentially huge copy.
        if (envelope_state_size < 8 || envelope_state_size > 65536) {
            std::snprintf(err, err_cap, "prefix destination is not a small fresh sequence"); return -1;
        }
        std::vector<uint8_t> envelope(envelope_state_size);
        if (llama_state_seq_get_data(ctx, envelope.data(), envelope.size(), sequence) != envelope.size()) {
            std::snprintf(err, err_cap, "cannot obtain llama memory-state envelope"); return -1;
        }
        uint8_t *wrapped = snapshot->bytes + (body - snapshot->bytes) - 8;
        std::memcpy(wrapped, envelope.data(), 8);
        const size_t consumed = llama_state_seq_set_data(ctx, wrapped, body_size + 8, sequence);
        if (consumed != body_size + 8) {
            std::snprintf(err, err_cap, "prefix state consumed %zu of %zu bytes", consumed, body_size + 8); return -1;
        }
        return 0;
    } catch (const std::exception &e) {
        std::snprintf(err, err_cap, "prefix state load failed: %s", e.what()); return -1;
    }
}
