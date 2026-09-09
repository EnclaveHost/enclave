#ifndef ANCHOR_ENCODED_CATALOG_H
#define ANCHOR_ENCODED_CATALOG_H
#include "anchor_catalog.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct {
    const anchor_gguf_tensor *source; /* held authenticated source table */
    uint64_t bytes, rows, blocks;
    uint8_t encoded_sha256[32];
    const uint8_t *block_sha256;     /* private catalog-owned bytes */
    const uint8_t *exponents_le32;   /* same catalog-owned bytes for the backend's checked decoder */
    int32_t *exponents;              /* decoded LE values; backend also checks calibration bounds */
} anchor_encoded_entry;
typedef struct {
    uint8_t *raw;
    size_t raw_bytes;
    anchor_encoded_entry *entries;
    size_t count;
    int authenticated;
    uint8_t identity[32];
} anchor_encoded_catalog;
/* Catalog admission. All expected hashes and the source table are trusted caller input.
 * The source table must outlive this catalog. This authenticates metadata, never
 * artifact bytes. A PRESENT catalog that fails any check is fatal, not a miss. */
int anchor_encoded_catalog_open(int fd, const uint8_t expected_catalog[32],
    const anchor_catalog_table *source, const uint8_t expected_calib[32],
    const uint8_t expected_converter[32], const anchor_hash_ops *h,
    anchor_encoded_catalog *out, char *err, size_t errcap);
const anchor_encoded_entry *anchor_encoded_find(const anchor_encoded_catalog *, const char *name);
void anchor_encoded_catalog_free(anchor_encoded_catalog *);
#ifdef __cplusplus
}
#endif
#endif
