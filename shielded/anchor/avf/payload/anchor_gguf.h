/* GGUF walk for the pVM's model stage: ONE streaming read of the file that hashes every byte it consumes
 * (the whole-file digest = the pin's form), parses the header from those same bytes, and routes the data
 * region into per-tensor digests. The table is therefore bound to the bytes the pin vouches for: a header
 * swapped between "parse" and "hash" cannot exist, because there is only one read. The verified header
 * bytes are retained so a consumer that reads its own copy (llama) can be compared against them.
 * Every consumer of a tensor later hashes what it took and compares (27B-FEASIBILITY.md s.11). */
#ifndef ANCHOR_GGUF_H
#define ANCHOR_GGUF_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct { char name[128]; uint64_t ne[4]; uint32_t n_dims, type; uint64_t offset, size; uint8_t digest[32]; } anchor_gguf_tensor;
typedef struct {
    anchor_gguf_tensor *t; size_t n;
    uint64_t data_start, file_size, alignment; uint32_t version;
    uint8_t *header; size_t header_len;         /* the exact header bytes (magic .. last tensor info), verified */
    uint8_t whole_digest[32]; int has_whole;    /* the whole-file digest (the pin) from the same read; a consumer binding
                                                 * an artifact to THIS model (the prefix sidecar v2) uses it, not the calib */
} anchor_gguf_table;
/* Incremental SHA-256 as the pins module provides it (ctx is opaque storage of at least 256 bytes). */
typedef struct { void (*init)(void *ctx); void (*update)(void *ctx, const uint8_t *m, size_t n); void (*final)(void *ctx, uint8_t out[32]); } anchor_hash_ops;
/* The stage: one sequential read through fd (pread by offset, position untouched). With `h`, every byte is
 * hashed into `pin` and each tensor into its entry; with h == NULL only the header is walked (tests,
 * inspection) and nothing is authenticated. 1 on success (table allocated; free with anchor_gguf_free);
 * 0 with err on anything malformed, unknown, truncated, overlapping, duplicated or changed under the read. */
int  anchor_gguf_stage(int fd, anchor_gguf_table *t, const anchor_hash_ops *h, uint8_t pin[32], char *err, size_t errcap);
/* The same, reporting progress: `progress(ctx, done, total)` after every 1 GiB and at the end (NULL = silent). */
typedef void (*anchor_gguf_progress)(void *ctx, uint64_t done, uint64_t total);
int  anchor_gguf_stage_p(int fd, anchor_gguf_table *t, const anchor_hash_ops *h, uint8_t pin[32], anchor_gguf_progress progress, void *pctx, char *err, size_t errcap);
void anchor_gguf_free(anchor_gguf_table *t);
const anchor_gguf_tensor *anchor_gguf_find(const anchor_gguf_table *t, const char *name);
#ifdef __cplusplus
}
#endif
#endif
