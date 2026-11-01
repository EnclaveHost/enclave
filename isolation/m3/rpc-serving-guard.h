/* Private measured broker capability protocol. No host pathname, public socket,
 * signature verifier, lease renewal, or reconstructed authority lives here.
 * PREPARE pins the live owner's proof digest without changing originalD.
 * COMMIT/RENEW require the trusted broker's coordinated serving decision. */
#ifndef ENCLAVE_RPC_SERVING_GUARD_H
#define ENCLAVE_RPC_SERVING_GUARD_H
#include <stdint.h>
#include <string.h>
#define RPC_SERVING_FRAME 88
#define RPC_SERVING_FRESH_NS UINT64_C(4000000000)
#define RPC_SERVING_PERMIT_NS UINT64_C(30000000000)
struct rpc_serving_guard {
    uint64_t origin, original_deadline, until, observed, sequence;
    unsigned char digest[32];
    unsigned int phase;
};
static uint64_t rpc_serving_u64(const unsigned char *p) {
    uint64_t n=0; for(unsigned int i=0;i<8;i++) n |= (uint64_t)p[i] << (i*8); return n;
}
/* Caller treats ANY refusal as terminal. State is never reset/reconstructed. */
static int rpc_serving_accept(struct rpc_serving_guard *s,
                              const unsigned char b[RPC_SERVING_FRAME], uint64_t now) {
    if (now<s->origin || now>=s->until || now>INT64_MAX || memcmp(b,"ERPCSV01",8)) return -1;
    for(unsigned int i=9;i<16;i++) if(b[i])return -1;
    uint64_t origin=rpc_serving_u64(b+16), deadline=rpc_serving_u64(b+24);
    uint64_t observed=rpc_serving_u64(b+32), until=rpc_serving_u64(b+40), seq=rpc_serving_u64(b+48);
    if(origin!=s->origin || deadline!=s->original_deadline) return -1;
    if(b[8]==1) {
        unsigned int nonzero=0; for(unsigned int i=56;i<88;i++)nonzero|=b[i];
        if(s->phase || seq || until || !nonzero || observed<origin || observed>now ||
           now-observed>=RPC_SERVING_FRESH_NS || now>=deadline) return -1;
        s->observed=observed;memcpy(s->digest,b+56,32);s->phase=1;return 0;
    }
    if(observed!=s->observed || memcmp(s->digest,b+56,32) || !seq ||
       seq!=s->sequence+1 || s->sequence==UINT64_MAX || until<=now ||
       until>INT64_MAX || until-now>RPC_SERVING_PERMIT_NS) return -1;
    if(b[8]==2) {
        if(s->phase!=1 || seq!=1 || now>=deadline || observed>now ||
           now-observed>=RPC_SERVING_FRESH_NS) return -1;
    } else if(b[8]==3) {
        if(s->phase!=2 || until<=s->until) return -1;
    } else return -1;
    s->phase=2;s->sequence=seq;s->until=until;return 0;
}
#endif
