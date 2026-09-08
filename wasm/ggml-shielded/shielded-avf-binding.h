#ifndef SHIELDED_AVF_BINDING_H
#define SHIELDED_AVF_BINDING_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* Must agree with relay/avf-binding.mjs. The caller supplies its OWN public
 * keys from trusted state, never keys supplied by normal-world plumbing.
 * AVF's certificate challenge is SHA256 of these bytes; its attested key
 * signs the complete bytes. Do not expose an arbitrary signing fallback. */
#define SH_AVF_PAD_DOMAIN "enclave-avf-pad-bind-v1\n"
#define SH_AVF_PAD_BINDING_LEN (sizeof(SH_AVF_PAD_DOMAIN) - 1 + 44 + 32 + 32)

static inline void sh_avf_pad_binding(uint8_t out[SH_AVF_PAD_BINDING_LEN],
                                      const uint8_t transport_pk[32],
                                      const uint8_t pad_pk[32], const uint8_t nonce[32]) {
    static const uint8_t prefix[12] = {0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00};
    size_t off = sizeof(SH_AVF_PAD_DOMAIN) - 1;
    memcpy(out, SH_AVF_PAD_DOMAIN, off);
    memcpy(out + off, prefix, 12); off += 12;
    memcpy(out + off, transport_pk, 32); off += 32;
    memcpy(out + off, pad_pk, 32); off += 32;
    memcpy(out + off, nonce, 32);
}

/* Validate an app-forwarded transcript against keys the pVM generated. The
 * nonce is allowed to come from the app: freshness is checked by the relay.
 * The relay also checks the certificate challenge equals SHA256(transcript).
 * Thus forwarding a wrong challenge cannot authenticate a different key. */
static inline int sh_avf_pad_binding_valid(const uint8_t *bound, size_t len,
                                           const uint8_t transport_pk[32],
                                           const uint8_t pad_pk[32]) {
    uint8_t expected[SH_AVF_PAD_BINDING_LEN];
    if (!bound || len != sizeof expected || !transport_pk || !pad_pk) return 0;
    sh_avf_pad_binding(expected, transport_pk, pad_pk, bound + len - 32);
    return memcmp(expected, bound, len) == 0;
}
#endif
