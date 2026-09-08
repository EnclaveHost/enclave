/* GGUF header walk for the pVM's model stage: which bytes belong to which tensor, so that ONE sequential
 * pass over the file yields the whole-file digest (the pin) AND a per-tensor digest table from the same
 * bytes (27B-FEASIBILITY.md s.11). Every consumer of a tensor later hashes what it took and compares.
 * The hash is pluggable (anchor_pins' backend); the table is plain memory, never persisted. */
#ifndef ANCHOR_GGUF_H
#define ANCHOR_GGUF_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct { char name[128]; uint64_t offset, size; uint32_t type; uint8_t digest[32]; } anchor_gguf_tensor;
typedef struct { anchor_gguf_tensor *t; size_t n; uint64_t data_start, file_size, alignment; uint32_t version; } anchor_gguf_table;
/* Incremental SHA-256 as the pins module provides it (ctx is opaque storage of at least 256 bytes). */
typedef struct { void (*init)(void *ctx); void (*update)(void *ctx, const uint8_t *m, size_t n); void (*final)(void *ctx, uint8_t out[32]); } anchor_hash_ops;
/* Parse the header through fd (pread, position untouched). 1 on success with t->t allocated (caller frees
 * with anchor_gguf_free); 0 with err filled on anything malformed, unknown, overlapping or out of the file. */
int  anchor_gguf_parse(int fd, anchor_gguf_table *t, char *err, size_t errcap);
void anchor_gguf_free(anchor_gguf_table *t);
/* One sequential pass over the whole file: whole-file digest into `pin`, each tensor's digest into its
 * table entry, from the same bytes. 1 on success; 0 (err) on a short read or read error - nothing is
 * trusted then. */
int  anchor_gguf_digest_pass(int fd, anchor_gguf_table *t, const anchor_hash_ops *h, uint8_t pin[32], char *err, size_t errcap);
/* Look a tensor up by name (NULL if absent). */
const anchor_gguf_tensor *anchor_gguf_find(const anchor_gguf_table *t, const char *name);
#ifdef __cplusplus
}
#endif
#endif
