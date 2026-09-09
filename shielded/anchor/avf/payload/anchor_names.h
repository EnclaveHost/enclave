/* What may land on the pVM's pads port under a given name (anchor_payload.c receiver): a canonical
 * dealt-pad shipment, one of the exact shared-prefix assets, a catalog-named public artifact, or nothing. */
#ifndef ANCHOR_NAMES_H
#define ANCHOR_NAMES_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef enum { ANCHOR_NAME_REFUSED = 0, ANCHOR_NAME_SHIPMENT = 1, ANCHOR_NAME_PREFIX = 2, ANCHOR_NAME_ARTIFACT = 3 } anchor_name_class;
/* SHIPMENT: "<32 lowercase hex>-<index0>-<count>.pads" with canonical decimals (no leading zeros, no
 * sign, fit in 64 bits, count >= 1, index0 + count does not overflow); seed_hex_out/index0/count filled.
 * It is judged against its own header and acknowledged. PREFIX: exactly "prefix.kv", "prefix.kv.sig"
 * or "prefix.txt": stored as offered, verified at use under the pinned prefix key, never acknowledged.
 * ARTIFACT: exactly "<64 lowercase hex>.i8": a PUBLIC encoded-weight artifact named by its own content
 * digest; admitted only when an authenticated encoded catalog lists that digest (anchor_artifacts.h),
 * block-verified against the catalog while received, never acknowledged.
 * REFUSED: anything else (a slash, "..", another suffix, padding, uppercase hex): not stored. */
anchor_name_class anchor_name_classify(const char *name, char seed_hex_out[33], uint64_t *index0, uint64_t *count);
#ifdef __cplusplus
}
#endif
#endif
