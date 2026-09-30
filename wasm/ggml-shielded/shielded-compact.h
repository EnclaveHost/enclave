#pragma once
#include "shielded-tee.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct sh_compact_store sh_compact_store;
/* Private immutable lossless storage; no host mapping, disk, or mask reuse.
 * NULL on unsupported CPU/geometry or allocation/validation failure. */
sh_compact_store *sh_compact_create(const int8_t *, int64_t K, int64_t N);
void sh_compact_free(sh_compact_store *);
size_t sh_compact_bytes(const sh_compact_store *);
int sh_compact_read(void *, uint64_t, uint8_t *, size_t);
int sh_compact_refill(void *, const int32_t *, int, int32_t *, int64_t);
#ifdef __cplusplus
}
#endif
