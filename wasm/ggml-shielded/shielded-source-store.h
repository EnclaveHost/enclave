#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Local weight storage regenerated from the weight's own private source bytes
 * (shielded-source-store.cpp): no encoded copy is held. NULL if the re-encoding
 * of every row does not equal `expected` (the registered encoding), on an
 * unsupported CPU/type, or on allocation failure. Rows [col0, col0+N) of the
 * source; `type` is the ggml_type of `src`. */
typedef struct sh_source_store sh_source_store;
sh_source_store *sh_source_store_create(const void *src, int type, int64_t K, int64_t col0, int64_t N,
                                        const int8_t *expected);
void sh_source_store_free(sh_source_store *);
size_t sh_source_store_bytes(const sh_source_store *);
int sh_source_store_read(void *, uint64_t, uint8_t *, size_t);
int sh_source_store_refill(void *, const int32_t *, int, int32_t *, int64_t);
#ifdef __cplusplus
}
#endif
