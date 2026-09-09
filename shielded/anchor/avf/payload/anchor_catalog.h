/* Catalog admission primitive. The expected catalog/model hashes are authority supplied
 * by measured code or measured immutable assets, never by the model file owner. */
#ifndef ANCHOR_CATALOG_H
#define ANCHOR_CATALOG_H
#include "anchor_gguf.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct {
    anchor_gguf_table table;
    uint8_t model_identity[32];
    uint8_t catalog_identity[32];
    int authenticated_catalog;
} anchor_catalog_table;
/* Reads only the catalog and GGUF header. Hashes both private copies, parses the
 * exact verified header with the production parser, compares the complete layout,
 * and populates expected tensor digests. Consumers still verify actual tensors.
 * On failure, out is empty. whole_digest/has_whole stay zero on success. */
int anchor_catalog_open(int model_fd, int catalog_fd,
    const uint8_t expected_catalog[32], const uint8_t expected_model[32],
    const anchor_hash_ops *h, anchor_catalog_table *out, char *err, size_t errcap);
void anchor_catalog_free(anchor_catalog_table *out);
#ifdef __cplusplus
}
#endif
#endif
