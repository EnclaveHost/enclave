/* anchor_attach_instance.h, natively: the instance key signs ONLY this pVM's own pad-bind transcript, under its own domain;
 * every foreign or malformed transcript gets nothing (0, and the output buffer untouched). Prints the instance public key, the
 * transcript and the signature so the node test verifies them the way the owner's co-signer does. */
#include "tweetnacl.h"
#include "shielded-avf-binding.h"
#include "anchor_attach_instance.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned long long ctr = 1;
void randombytes(unsigned char *p, unsigned long long n) { for (unsigned long long i = 0; i < n; i++) p[i] = (unsigned char)(ctr++ * 131u + 7u); }
static void hex(const char *label, const uint8_t *b, size_t n) { printf("%s=", label); for (size_t i = 0; i < n; i++) printf("%02x", b[i]); printf("\n"); }
static int untouched(const uint8_t sig[64]) { for (int i = 0; i < 64; i++) if (sig[i] != 0xAA) return 0; return 1; }

int main(void) {
    unsigned char ipk[32], isk[64], tpk[32], tsk[64], ppk[32], opk[32], osk[64];
    assert(crypto_sign_keypair(ipk, isk) == 0);   /* the instance key */
    assert(crypto_sign_keypair(tpk, tsk) == 0);   /* this boot's transport key */
    assert(crypto_sign_keypair(opk, osk) == 0);   /* ANOTHER VM's transport key */
    randombytes(ppk, 32);                         /* this boot's pad key (public half) */
    uint8_t nonce[32]; randombytes(nonce, 32);
    uint8_t B[SH_AVF_PAD_BINDING_LEN], sig[64];
    sh_avf_pad_binding(B, tpk, ppk, nonce);
    /* its own transcript: signed */
    memset(sig, 0xAA, 64);
    assert(anchor_attach_instance_sign(B, sizeof B, tpk, ppk, isk, sig) == 1 && !untouched(sig));
    { unsigned char m[sizeof(ANCHOR_ATTACH_INSTANCE_DOMAIN) - 1 + sizeof B], sm[sizeof m + 64], out[sizeof sm]; unsigned long long ol = 0;
      memcpy(m, ANCHOR_ATTACH_INSTANCE_DOMAIN, sizeof(ANCHOR_ATTACH_INSTANCE_DOMAIN) - 1); memcpy(m + sizeof(ANCHOR_ATTACH_INSTANCE_DOMAIN) - 1, B, sizeof B);
      memcpy(sm, sig, 64); memcpy(sm + 64, m, sizeof m);
      assert(crypto_sign_open(out, &ol, sm, sizeof sm, ipk) == 0 && ol == sizeof m); }   /* over DOMAIN || B, by the instance key */
    /* foreign or malformed: nothing */
    uint8_t F[SH_AVF_PAD_BINDING_LEN];
    sh_avf_pad_binding(F, opk, ppk, nonce); memset(sig, 0xAA, 64);
    assert(anchor_attach_instance_sign(F, sizeof F, tpk, ppk, isk, sig) == 0 && untouched(sig));          /* another VM's transport key */
    uint8_t P[32]; memcpy(P, ppk, 32); P[0] ^= 1; sh_avf_pad_binding(F, tpk, P, nonce); memset(sig, 0xAA, 64);
    assert(anchor_attach_instance_sign(F, sizeof F, tpk, ppk, isk, sig) == 0 && untouched(sig));          /* another pad key */
    memcpy(F, B, sizeof B); F[0] ^= 1; memset(sig, 0xAA, 64);
    assert(anchor_attach_instance_sign(F, sizeof F, tpk, ppk, isk, sig) == 0 && untouched(sig));          /* another domain */
    memset(sig, 0xAA, 64);
    assert(anchor_attach_instance_sign(B, sizeof B - 1, tpk, ppk, isk, sig) == 0 && untouched(sig));      /* truncated */
    uint8_t L[SH_AVF_PAD_BINDING_LEN + 1]; memcpy(L, B, sizeof B); L[sizeof B] = 0; memset(sig, 0xAA, 64);
    assert(anchor_attach_instance_sign(L, sizeof L, tpk, ppk, isk, sig) == 0 && untouched(sig));          /* extended */
    memset(sig, 0xAA, 64);
    assert(anchor_attach_instance_sign(NULL, sizeof B, tpk, ppk, isk, sig) == 0 && untouched(sig));       /* none */
    /* for the node side: verify as the co-signer does */
    anchor_attach_instance_sign(B, sizeof B, tpk, ppk, isk, sig);
    hex("ipk", ipk, 32); hex("B", B, sizeof B); hex("sig", sig, 64);
    printf("anchor-attach-instance: ok\n");
    return 0;
}
