/* anchor_reattach.h, natively (built with ASan/UBSan by test/anchor-reattach.test.mjs): REATTACH takes the relay's nonce and
 * nothing else; B is built from the keys armed at boot (their bytes land in B unchanged); every malformed argument, a second
 * re-attach inside 5 s, a clock that went backwards, a key change after boot, and an unarmed session each produce NOTHING
 * (B and the instance signature untouched, no instance proof flagged). Prints ipk, the transport and pad keys, the nonce,
 * B and the instance signature so the node test checks B against relay/avf-binding.mjs and the signature as the co-signer does. */
#include "tweetnacl.h"
#include "shielded-avf-binding.h"
#include "anchor_attach_instance.h"
#include "anchor_reattach.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned long long ctr = 1;
void randombytes(unsigned char *p, unsigned long long n) { for (unsigned long long i = 0; i < n; i++) p[i] = (unsigned char)(ctr++ * 131u + 7u); }
static void hex(const char *label, const uint8_t *b, size_t n) { printf("%s=", label); for (size_t i = 0; i < n; i++) printf("%02x", b[i]); printf("\n"); }
static int filled(const uint8_t *b, size_t n, uint8_t v) { for (size_t i = 0; i < n; i++) if (b[i] != v) return 0; return 1; }
static uint8_t B[SH_AVF_PAD_BINDING_LEN], S[64]; static int has;
static void reset(void) { memset(B, 0xAA, sizeof B); memset(S, 0xAA, sizeof S); has = 7; }
/* a refusal: a reason, and nothing produced */
static void refused(anchor_reattach_ctx *c, const char *arg, size_t len, uint64_t now, const char *want) {
    reset();
    const char *why = anchor_reattach_prepare(c, arg, len, now, B, S, &has);
    if (!why || !strstr(why, want)) { fprintf(stderr, "expected a refusal containing \"%s\", got %s (len %zu)\n", want, why ? why : "GO", len); exit(1); }
    assert(filled(B, sizeof B, 0xAA) && filled(S, sizeof S, 0xAA) && has == 0);
}

int main(void) {
    unsigned char ipk[32], isk[64], tpk[32], tsk[64], ppk[32];
    assert(crypto_sign_keypair(ipk, isk) == 0);   /* the instance key */
    assert(crypto_sign_keypair(tpk, tsk) == 0);   /* this boot's transport key */
    randombytes(ppk, 32);                         /* this boot's pad key (public half) */
    const char *good = "00112233445566778899aabbccddeeff0123456789abcdeffedcba9876543210";
    uint8_t want_nonce[32]; assert(anchor_reattach_parse(good, 64, want_nonce) == 1);

    anchor_reattach_ctx c;
    /* not armed: nothing */
    memset(&c, 0, sizeof c); refused(&c, good, 64, 100000, "not armed");
    anchor_reattach_arm(&c, tpk, ppk, isk, 1);

    /* malformed arguments: nothing, and the rate is NOT spent */
    char buf[80];
    refused(&c, good, 63, 100000, "64 lowercase hex");                                          /* 63 characters */
    memcpy(buf, good, 64); buf[64] = '0'; refused(&c, buf, 65, 100000, "64 lowercase hex");     /* 65 characters */
    memcpy(buf, good, 64); buf[64] = ' '; buf[65] = 'x'; refused(&c, buf, 66, 100000, "64 lowercase hex");   /* trailing garbage */
    refused(&c, good, 0, 100000, "64 lowercase hex");                                           /* empty */
    refused(&c, NULL, 64, 100000, "64 lowercase hex");                                          /* none */
    memcpy(buf, good, 64); buf[10] = 'g'; refused(&c, buf, 64, 100000, "64 lowercase hex");     /* not hex */
    memcpy(buf, good, 64); buf[11] = 'A'; refused(&c, buf, 64, 100000, "64 lowercase hex");     /* uppercase */
    memcpy(buf, good, 64); buf[20] = '\0'; refused(&c, buf, 64, 100000, "64 lowercase hex");    /* an embedded NUL */
    memcpy(buf, good, 64); buf[63] = '\n'; refused(&c, buf, 64, 100000, "64 lowercase hex");    /* a control byte */
    assert(c.any == 0);

    /* the good one: B from the ARMED keys and exactly this nonce; the instance proof over B */
    reset();
    assert(anchor_reattach_prepare(&c, good, 64, 100000, B, S, &has) == NULL && has == 1);
    enum { D = sizeof(SH_AVF_PAD_DOMAIN) - 1 };
    static const uint8_t prefix[12] = {0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00};
    assert(memcmp(B, SH_AVF_PAD_DOMAIN, D) == 0 && memcmp(B + D, prefix, 12) == 0);
    assert(memcmp(B + D + 12, tpk, 32) == 0 && memcmp(B + D + 44, ppk, 32) == 0 && memcmp(B + D + 76, want_nonce, 32) == 0);
    { unsigned char m[sizeof(ANCHOR_ATTACH_INSTANCE_DOMAIN) - 1 + sizeof B], sm[sizeof m + 64], out[sizeof sm]; unsigned long long ol = 0;
      memcpy(m, ANCHOR_ATTACH_INSTANCE_DOMAIN, sizeof(ANCHOR_ATTACH_INSTANCE_DOMAIN) - 1); memcpy(m + sizeof(ANCHOR_ATTACH_INSTANCE_DOMAIN) - 1, B, sizeof B);
      memcpy(sm, S, 64); memcpy(sm + 64, m, sizeof m);
      assert(crypto_sign_open(out, &ol, sm, sizeof sm, ipk) == 0 && ol == sizeof m); }
    hex("ipk", ipk, 32); hex("tpk", tpk, 32); hex("ppk", ppk, 32); hex("nonce", want_nonce, 32); hex("B", B, sizeof B); hex("sig", S, 64);

    /* the rate: a second inside 5 s is refused, at 5 s it is admitted; a clock that went backwards is refused */
    refused(&c, good, 64, 100000 + 4999, "one re-attach per 5 s");
    refused(&c, good, 64, 99999, "one re-attach per 5 s");
    reset(); assert(anchor_reattach_prepare(&c, good, 64, 105000, B, S, &has) == NULL && has == 1);
    /* a malformed argument inside the window is refused as malformed, and does not move the window */
    refused(&c, good, 65, 106000, "64 lowercase hex");
    assert(c.last_ms == 105000);

    /* the keys changed after arming (never expected): refused, nothing certified; restored: admitted again */
    tpk[0] ^= 1; refused(&c, good, 64, 200000, "keys changed"); tpk[0] ^= 1;
    ppk[5] ^= 1; refused(&c, good, 64, 200000, "keys changed"); ppk[5] ^= 1;
    reset(); assert(anchor_reattach_prepare(&c, good, 64, 200000, B, S, &has) == NULL);

    /* a boot with no instance key: B is still made, and no instance proof is claimed */
    anchor_reattach_ctx n; anchor_reattach_arm(&n, tpk, ppk, NULL, 0);
    reset(); assert(anchor_reattach_prepare(&n, good, 64, 100000, B, S, &has) == NULL && has == 0 && filled(S, sizeof S, 0xAA));
    printf("anchor-reattach: ok\n");
    return 0;
}
