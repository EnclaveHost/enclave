#ifndef SHIELDED_PAD_MINT_V3_H
#define SHIELDED_PAD_MINT_V3_H
#include "shielded-pads-v3.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Independently established identities of the registered CPU weights. The
 * caller obtains these from verified assets/encoding, NOT from incoming demand
 * or by copying the grant's expected hashes. This primitive checks agreement
 * and actual registered geometry; it does not hash or authenticate asset files. */
typedef struct {
    uint8_t model_digest[32], calib_digest[32], encoding_digest[32];
} sh_pads_v3_source;

/* Explicit standalone CPU mint; no CLI, relay, seed issuance or consumer hook.
 * The link must contain the COMPLETE registered manifest, with private stable
 * CPU weights, and must not have connected/started refill threads. The caller
 * serializes the link and keeps every input private/stable until return.
 * Complete groups may be registered in a different order; their ordered members
 * must match. r always uses the admitted CANONICAL ordinal, never local order.
 *
 * policy/spans/directory/name obey the v3 writer contract. Seed authorization,
 * immutable seed-to-manifest binding and reserve-before-use remain caller
 * responsibilities; this call never authorizes a replay or remint.
 *
 * threads is explicit 1..64, capped to nonempty groups. max_scratch_bytes is a
 * mandatory aggregate cap for all task r/u/planes/acc/AEAD scratch and the
 * writer's shared AEAD scratch. Bounded public metadata and the writer's nonce
 * bitmap are separately limited by the v3 file/manifest policy. All scratch is
 * sized/allocated before minting, retained per thread, and wiped before return.
 * Failed thread creation executes that lane on the caller exactly once.
 *
 * published is required and initialized false, then reports the same durable
 * publication boundary as writer_finish. An error with true requires explicit
 * reconciliation. No partial file is intentionally published on a mint error.
 */
int sh_link_mint_sparse_v3(sh_link *link, const sh_pads_v3_source *source,
        const sh_pads_v3_policy *policy, const sh_pads_span *spans,
        const uint8_t seed[32], const uint8_t consumer_pk[32],
        int directory_fd, const char *name, uint32_t threads,
        uint64_t max_scratch_bytes, bool *published);

#ifdef __cplusplus
}
#endif
#endif
