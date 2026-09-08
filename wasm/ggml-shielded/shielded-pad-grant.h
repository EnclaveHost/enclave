#ifndef SHIELDED_PAD_GRANT_H
#define SHIELDED_PAD_GRANT_H

#include "tweetnacl.h"
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* Expected context is assembled from TRUSTED pVM state, not grant metadata
 * forwarded by Android. The ledger key is measured/pinned, the two public keys
 * belong to this boot, asset digests were checked against measured pins, and
 * request_nonce is freshly generated inside the pVM for this pending request.
 * Successful verification authorizes opening this box, not resetting the pad
 * bank. The caller must consume the pending request once and retain monotonic
 * window state. See shielded/anchor/avf/PAD-BOOTSTRAP.md. */
typedef struct {
    char name[65];
    uint8_t transport_pk[32], pad_pk[32];
    uint8_t model_digest[32], calib_digest[32], request_nonce[32];
} sh_pad_grant_context;

typedef struct {
    uint8_t seed_id[16];
    uint64_t epoch;
    uint8_t epk[32], nonce[12], box[48], sig[64];
} sh_pad_seed_grant;

#define SH_PAD_GRANT_MESSAGE_CAP 768

static inline void sh_pad_grant_hex(char *out, const uint8_t *in, size_t n) {
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) { out[2*i] = digits[in[i] >> 4]; out[2*i+1] = digits[in[i] & 15]; }
    out[2*n] = 0;
}

static inline size_t sh_pad_grant_message(char *out, size_t cap,
                                         const sh_pad_grant_context *c,
                                         const sh_pad_seed_grant *g) {
    if (!out || !cap || !c || !g || !g->epoch || g->epoch > UINT64_C(9007199254740991)) return 0;
    size_t name_len = 0;
    while (name_len < sizeof c->name && c->name[name_len]) {
        const unsigned char v = (unsigned char)c->name[name_len++];
        if (!((v >= 'A' && v <= 'Z') || (v >= 'a' && v <= 'z') ||
              (v >= '0' && v <= '9') || v == '_' || v == '-')) return 0;
    }
    if (!name_len || name_len > 64) return 0;
    char tpk[65], ppk[65], model[65], calib[65], request[65], sid[33], epk[65], nonce[25], box[97];
    sh_pad_grant_hex(tpk, c->transport_pk, 32); sh_pad_grant_hex(ppk, c->pad_pk, 32);
    sh_pad_grant_hex(model, c->model_digest, 32); sh_pad_grant_hex(calib, c->calib_digest, 32);
    sh_pad_grant_hex(request, c->request_nonce, 32); sh_pad_grant_hex(sid, g->seed_id, 16);
    sh_pad_grant_hex(epk, g->epk, 32); sh_pad_grant_hex(nonce, g->nonce, 12); sh_pad_grant_hex(box, g->box, 48);
    const int n = snprintf(out, cap,
        "enclave-pads-seed-grant-v1\n%s\n302a300506032b6570032100%s\n%s\n%s\n%s\n%s\n%s\n%llu\n%s\n%s\n%s",
        c->name, tpk, ppk, model, calib, request, sid, (unsigned long long)g->epoch, epk, nonce, box);
    return n > 0 && (size_t)n < cap ? (size_t)n : 0;
}

static inline int sh_pad_ledger_signature_verify(const uint8_t ledger_pk[32],
                                                 const char *msg, size_t n,
                                                 const uint8_t sig[64]) {
    if (!ledger_pk || !msg || !sig || !n || n >= SH_PAD_GRANT_MESSAGE_CAP) return 0;
    /* TweetNaCl's older verifier does not reject S >= the subgroup order.
     * Require canonical Ed25519 signatures at this protocol boundary. */
    static const uint8_t order[32] = {
        0xed,0xd3,0xf5,0x5c,0x1a,0x63,0x12,0x58,0xd6,0x9c,0xf7,0xa2,0xde,0xf9,0xde,0x14,
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0x10
    };
    int less = 0;
    for (int i = 31; i >= 0; i--) {
        if (sig[32+i] == order[i]) continue;
        less = sig[32+i] < order[i]; break;
    }
    if (!less) return 0;
    uint8_t signed_msg[64 + SH_PAD_GRANT_MESSAGE_CAP], opened[64 + SH_PAD_GRANT_MESSAGE_CAP];
    unsigned long long opened_len = 0;
    memcpy(signed_msg, sig, 64); memcpy(signed_msg + 64, msg, n);
    return crypto_sign_open(opened, &opened_len, signed_msg, 64 + (unsigned long long)n, ledger_pk) == 0 &&
           opened_len == (unsigned long long)n;
}

static inline int sh_pad_grant_verify(const uint8_t ledger_pk[32],
                                      const sh_pad_grant_context *context,
                                      const sh_pad_seed_grant *grant) {
    char msg[SH_PAD_GRANT_MESSAGE_CAP];
    if (!grant) return 0;
    const size_t n = sh_pad_grant_message(msg, sizeof msg, context, grant);
    return sh_pad_ledger_signature_verify(ledger_pk, msg, n, grant->sig);
}

static inline int sh_pad_public_hex_valid(const char *s, size_t min, size_t max) {
    if (!s) return 0;
    size_t n = 0;
    while (n <= max && s[n]) {
        if (!((s[n] >= '0' && s[n] <= '9') || (s[n] >= 'a' && s[n] <= 'f'))) return 0;
        n++;
    }
    return n >= min && n <= max && n % 2 == 0;
}

/* The request nonce comes from the current pVM request, not from response
 * metadata. A signed old window for this seed cannot satisfy a new nonce,
 * even after destroying/recreating a link or changing the model graph. */
static inline int sh_pad_window_v2_verify(const uint8_t ledger_pk[32], const char *seed_id,
                                          uint64_t lo, uint64_t hi, uint64_t iat,
                                          const char *request_nonce, const uint8_t sig[64]) {
    if (!sh_pad_public_hex_valid(seed_id, 32, 32) || !sh_pad_public_hex_valid(request_nonce, 32, 128) ||
        hi <= lo || hi > UINT64_C(9007199254740991) || iat > UINT64_C(9007199254740991)) return 0;
    char msg[SH_PAD_GRANT_MESSAGE_CAP];
    const int n = snprintf(msg, sizeof msg, "enclave-pads-window-v2\n%s\n%llu\n%llu\n%llu\n%s",
        seed_id, (unsigned long long)lo, (unsigned long long)hi, (unsigned long long)iat, request_nonce);
    return n > 0 && n < (int)sizeof msg && sh_pad_ledger_signature_verify(ledger_pk, msg, (size_t)n, sig);
}
#endif
