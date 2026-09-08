#include "shielded-pad-grant.h"
#include <assert.h>
#include <stdlib.h>

void randombytes(unsigned char *p, unsigned long long n) { (void)p; (void)n; abort(); }

static void unhex(const char *s, uint8_t *out, size_t n) {
    assert(strlen(s) == 2*n);
    for (size_t i = 0; i < n; i++) {
        unsigned v;
        assert(sscanf(s + 2*i, "%2x", &v) == 1);
        out[i] = (uint8_t)v;
    }
}

int main(int argc, char **argv) {
    assert(argc == 14);
    uint8_t ledger[32];
    sh_pad_grant_context c = {0}; sh_pad_seed_grant g = {0};
    unhex(argv[1], ledger, 32);
    assert(strlen(argv[2]) <= 64); strcpy(c.name, argv[2]);
    unhex(argv[3], c.transport_pk, 32); unhex(argv[4], c.pad_pk, 32);
    unhex(argv[5], c.model_digest, 32); unhex(argv[6], c.calib_digest, 32);
    unhex(argv[7], c.request_nonce, 32); unhex(argv[8], g.seed_id, 16);
    g.epoch = strtoull(argv[9], NULL, 10);
    unhex(argv[10], g.epk, 32); unhex(argv[11], g.nonce, 12);
    unhex(argv[12], g.box, 48); unhex(argv[13], g.sig, 64);
    char msg[SH_PAD_GRANT_MESSAGE_CAP];
    const size_t n = sh_pad_grant_message(msg, sizeof msg, &c, &g);
    assert(n);
    if (!sh_pad_grant_verify(ledger, &c, &g)) { puts("rejected"); return 1; }
    /* Verification authenticates all expected context, even if Android omits
     * or tampers with redundant metadata in its forwarded response. */
#define MUTATE_ARRAY(obj, field) do { \
    for (size_t i = 0; i < sizeof (obj).field; i++) { \
        (obj).field[i] ^= 1; assert(!sh_pad_grant_verify(ledger, &c, &g)); (obj).field[i] ^= 1; \
    } \
} while (0)
    MUTATE_ARRAY(c, transport_pk); MUTATE_ARRAY(c, pad_pk);
    MUTATE_ARRAY(c, model_digest); MUTATE_ARRAY(c, calib_digest); MUTATE_ARRAY(c, request_nonce);
    MUTATE_ARRAY(g, seed_id); MUTATE_ARRAY(g, epk); MUTATE_ARRAY(g, nonce); MUTATE_ARRAY(g, box);
    MUTATE_ARRAY(g, sig);
    const char name0 = c.name[0]; c.name[0] = name0 == 'x' ? 'y' : 'x';
    assert(!sh_pad_grant_verify(ledger, &c, &g)); c.name[0] = name0;
    const uint64_t epoch = g.epoch;
    g.epoch = epoch == 1 ? 2 : 1; assert(!sh_pad_grant_verify(ledger, &c, &g));
    g.epoch = 0; assert(!sh_pad_grant_verify(ledger, &c, &g));
    g.epoch = UINT64_MAX; assert(!sh_pad_grant_verify(ledger, &c, &g)); g.epoch = epoch;
    ledger[0] ^= 1; assert(!sh_pad_grant_verify(ledger, &c, &g)); ledger[0] ^= 1;
    assert(!sh_pad_grant_verify(NULL, &c, &g));
    assert(!sh_pad_grant_verify(ledger, NULL, &g));
    assert(!sh_pad_grant_verify(ledger, &c, NULL));
    const sh_pad_grant_context saved = c;
    for (size_t i = 0; i < sizeof c.name; i++) c.name[i] = 'a';
    assert(!sh_pad_grant_verify(ledger, &c, &g));
    c = saved; c.name[0] = '\n'; assert(!sh_pad_grant_verify(ledger, &c, &g));
    c = saved; c.name[0] = 0; assert(!sh_pad_grant_verify(ledger, &c, &g)); c = saved;
    for (size_t cap = 0; cap <= n; cap++) assert(!sh_pad_grant_message(msg, cap, &c, &g));
    assert(sh_pad_grant_message(msg, n+1, &c, &g) == n);
    assert(!sh_pad_grant_message(NULL, sizeof msg, &c, &g));
    puts(msg);
    return 0;
}
