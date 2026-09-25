#ifndef ANCHOR_REATTACH_H
#define ANCHOR_REATTACH_H
/* The in-place RE-ATTACH (RUNNER-AGENT.md "Reconnect in place"; design reviewed with the verifier session). After a relay
 * drop the RUNNING VM attaches again without a restart. The host sends `REATTACH <64 lowercase hex>`: the new relay
 * connection's nonce and NOTHING ELSE. The transcript
 *   B = SH_AVF_PAD_DOMAIN || this VM's transport SPKI || its pad key || that nonce
 * is built HERE from the keys the VM generated at boot, so no transcript is ever taken from outside and there is no
 * foreign-transcript case to judge: sh_avf_pad_binding_valid is an internal assertion. The caller then certifies sha256(B)
 * (a NEW AVF attestation) and signs B with that attested key, exactly as at boot; the instance proof over B is made here
 * (anchor_attach_instance.h). Nothing here reads or writes the tier's caps state (the attach time, the caps nonce): a
 * re-attached tunnel carries no tier, because relay/pvm-cpu-tier.mjs needs a self-test AFTER the attach.
 * Bounded: at most one per ANCHOR_REATTACH_MIN_MS on the VM's own clock, so a buggy host cannot loop the attestation service.
 * (Measured on the Pixel 10: every attestation of 14 device runs, 125 chains over 105 fresh leaf keys, hangs off ONE
 * provisioned AVF key, so a call does not consume a remotely provisioned key; the bound is about load, not a key pool.)
 * The instance secret is only passed through to anchor_attach_instance_sign: never copied, never printed.
 * Needs tweetnacl (crypto_sign), shielded-avf-binding.h and anchor_attach_instance.h included first. */
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#define ANCHOR_REATTACH_CMD "REATTACH "
#define ANCHOR_REATTACH_MIN_MS 5000u
typedef struct {
    const uint8_t *tpk, *ppk;              /* the LIVE boot keys (the payload's g_tpk, g_ppk): read-only after boot */
    uint8_t tpk0[32], ppk0[32];            /* copies taken once, when armed: a re-attach refuses if the live keys ever differ */
    const unsigned char *isk; int inst;    /* the instance secret, when this boot derived one (never copied) */
    uint64_t last_ms; int any;             /* the rate: the VM clock of the last admitted re-attach */
    int armed;
} anchor_reattach_ctx;

/* Once at boot, after the transport, pad and instance keys exist. */
static inline void anchor_reattach_arm(anchor_reattach_ctx *c, const uint8_t *tpk, const uint8_t *ppk, const unsigned char *isk, int inst) {
    memset(c, 0, sizeof *c);
    if (!tpk || !ppk) return;
    c->tpk = tpk; c->ppk = ppk; memcpy(c->tpk0, tpk, 32); memcpy(c->ppk0, ppk, 32);
    c->isk = inst ? isk : NULL; c->inst = inst && isk; c->armed = 1;
}

/* The argument after "REATTACH ": exactly 64 LOWERCASE hex characters, `len` being the byte count the line reader returned
 * (so an embedded NUL or any trailing byte is refused). 1 = parsed into nonce; 0 = refused, nonce untouched. */
static inline int anchor_reattach_parse(const char *arg, size_t len, uint8_t nonce[32]) {
    if (!arg || !nonce || len != 64) return 0;
    uint8_t n[32];
    for (size_t i = 0; i < 64; i++) {
        const char ch = arg[i]; int v;
        if (ch >= '0' && ch <= '9') v = ch - '0'; else if (ch >= 'a' && ch <= 'f') v = ch - 'a' + 10; else return 0;
        if (i & 1) n[i / 2] = (uint8_t)(n[i / 2] | v); else n[i / 2] = (uint8_t)(v << 4);
    }
    memcpy(nonce, n, 32);
    return 1;
}

/* NULL = go: B is this VM's own transcript over the relay's nonce, and isig (when *has_isig) the instance proof over B.
 * Otherwise a static refusal, and nothing is produced. A malformed argument does not spend the rate; an admitted one does,
 * whatever the attestation that follows says. */
static inline const char *anchor_reattach_prepare(anchor_reattach_ctx *c, const char *arg, size_t len, uint64_t now_ms,
                                                  uint8_t B[SH_AVF_PAD_BINDING_LEN], uint8_t isig[64], int *has_isig) {
    uint8_t nonce[32], b[SH_AVF_PAD_BINDING_LEN], s[64];
    if (has_isig) *has_isig = 0;
    if (!c || !c->armed || !B || !isig || !has_isig) return "not armed: no boot keys in this session";
    if (!anchor_reattach_parse(arg, len, nonce)) return "the argument must be exactly the relay's nonce, 64 lowercase hex";
    if (memcmp(c->tpk, c->tpk0, 32) || memcmp(c->ppk, c->ppk0, 32)) return "this VM's keys changed since boot (never expected): nothing certified";
    if (c->any && (now_ms < c->last_ms || now_ms - c->last_ms < ANCHOR_REATTACH_MIN_MS)) return "at most one re-attach per 5 s";
    c->last_ms = now_ms; c->any = 1;
    sh_avf_pad_binding(b, c->tpk0, c->ppk0, nonce);
    if (!sh_avf_pad_binding_valid(b, sizeof b, c->tpk, c->ppk)) return "internal: the transcript is not this VM's own (never expected)";
    if (c->inst) { if (!anchor_attach_instance_sign(b, sizeof b, c->tpk, c->ppk, c->isk, s)) return "internal: the instance proof failed"; memcpy(isig, s, 64); *has_isig = 1; }
    memcpy(B, b, sizeof b);
    return NULL;
}
#endif
