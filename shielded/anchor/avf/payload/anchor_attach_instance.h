#ifndef ANCHOR_ATTACH_INSTANCE_H
#define ANCHOR_ATTACH_INSTANCE_H
/* The boot-time INSTANCE proof for a relay attach (RUNNER-AGENT.md "Attach"; reviewed with the verifier session). Once the
 * runner's name is registered on chain, the relay's hub takes an attach under it only with the registry operator's signature,
 * and the owner's co-signer (runner/attach-cosigner.mjs) gives that only for the owner's own VM INSTANCE. At boot -- before the
 * app and its evidence port -- the one instance proof there is is this: the instance key's Ed25519 signature over
 *   "enclave-pvm-attach-instance-v1\n" || B,   B = THIS pVM's own pad-bind transcript (shielded-avf-binding.h),
 * so the instance is paired with this boot's transport key and the relay's nonce inside B.
 * Signs ONLY when B is this pVM's own transcript over its own transport and pad keys: otherwise it returns 0 and leaves `sig`
 * untouched, so a forwarded foreign transcript never gets an instance signature. The secret key is only read here, never
 * copied out; the caller prints the instance SPKI and the signature, nothing else. Needs tweetnacl (crypto_sign) and
 * shielded-avf-binding.h included first. */
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#define ANCHOR_ATTACH_INSTANCE_DOMAIN "enclave-pvm-attach-instance-v1\n"
static inline int anchor_attach_instance_sign(const uint8_t *bound, size_t blen, const uint8_t tpk[32], const uint8_t ppk[32],
                                              const unsigned char isk[64], uint8_t sig[64]) {
    enum { D = sizeof(ANCHOR_ATTACH_INSTANCE_DOMAIN) - 1, M = D + SH_AVF_PAD_BINDING_LEN };
    if (!bound || !sig || blen != SH_AVF_PAD_BINDING_LEN || !sh_avf_pad_binding_valid(bound, blen, tpk, ppk)) return 0;
    unsigned char m[M], sm[M + 64]; unsigned long long smlen = 0;
    memcpy(m, ANCHOR_ATTACH_INSTANCE_DOMAIN, D); memcpy(m + D, bound, blen);
    if (crypto_sign(sm, &smlen, m, M, isk) != 0 || smlen != sizeof sm) return 0;
    memcpy(sig, sm, 64);
    return 1;
}
#endif
