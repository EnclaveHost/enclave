/* Exercise the real seed opener with every source-level allocation disabled. */
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <assert.h>
static unsigned allocations;
static void *forbidden_alloc(size_t n) { (void)n; allocations++; return NULL; }
#define malloc forbidden_alloc
#include "shielded-pads.c"
#undef malloc
int main(int argc, char **argv) {
    assert(argc == 8);
    uint8_t sk[32], pk[32], epk[32], nonce[12], box[48], wanted[32], out[32];
    assert(sh_pads_hex2bin(argv[1], sk, 32)); assert(sh_pads_hex2bin(argv[2], pk, 32));
    assert(sh_pads_hex2bin(argv[3], epk, 32)); assert(sh_pads_hex2bin(argv[4], nonce, 12));
    assert(sh_pads_hex2bin(argv[5], box, 48)); assert(sh_pads_hex2bin(argv[6], wanted, 32));
    int expect = atoi(argv[7]); memset(out, 0xa5, sizeof out);
    int rc = sh_pads_seed_open(epk, nonce, box, sizeof box, sk, pk, out);
    assert(rc == expect); assert(allocations == 0);
    if (rc == SH_OK) assert(memcmp(out, wanted, sizeof out) == 0);
    else for (size_t i=0;i<sizeof out;i++) assert(out[i] == 0);
    memset(out,0xa5,sizeof out);
    assert(sh_pads_seed_open(epk,nonce,box,47,sk,pk,out) == SH_ERR_RANGE);
    for (size_t i=0;i<sizeof out;i++) assert(out[i] == 0);
    assert(sh_pads_seed_open(NULL,nonce,box,48,sk,pk,out) == SH_ERR_RANGE);
    assert(sh_pads_seed_open(epk,nonce,box,48,sk,pk,NULL) == SH_ERR_RANGE);
    puts("pad-seed-open: ok");
}
