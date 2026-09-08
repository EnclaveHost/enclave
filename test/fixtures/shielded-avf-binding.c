#include "shielded-avf-binding.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
    uint8_t tpk[32], ppk[32], nonce[32], bound[SH_AVF_PAD_BINDING_LEN];
    memset(tpk, 0x11, sizeof tpk);
    memset(ppk, 0x22, sizeof ppk);
    memset(nonce, 0x33, sizeof nonce);
    sh_avf_pad_binding(bound, tpk, ppk, nonce);
    assert(sh_avf_pad_binding_valid(bound, sizeof bound, tpk, ppk));
    assert(!sh_avf_pad_binding_valid(NULL, sizeof bound, tpk, ppk));
    assert(!sh_avf_pad_binding_valid(bound, sizeof bound, NULL, ppk));
    assert(!sh_avf_pad_binding_valid(bound, sizeof bound, tpk, NULL));
    for (size_t n = 0; n < sizeof bound; n++)
        assert(!sh_avf_pad_binding_valid(bound, n, tpk, ppk));
    assert(!sh_avf_pad_binding_valid(bound, sizeof bound + 1, tpk, ppk));
    /* Every byte of the domain, DER prefix and BOTH public keys is checked. */
    for (size_t i = 0; i < sizeof bound - 32; i++) {
        bound[i] ^= 1;
        assert(!sh_avf_pad_binding_valid(bound, sizeof bound, tpk, ppk));
        bound[i] ^= 1;
    }
    tpk[0] ^= 1;
    assert(!sh_avf_pad_binding_valid(bound, sizeof bound, tpk, ppk));
    tpk[0] ^= 1; ppk[0] ^= 1;
    assert(!sh_avf_pad_binding_valid(bound, sizeof bound, tpk, ppk));
    ppk[0] ^= 1;
    /* Challenge freshness belongs to the relay, not the untrusted app. */
    bound[sizeof bound - 1] ^= 1;
    assert(sh_avf_pad_binding_valid(bound, sizeof bound, tpk, ppk));
    bound[sizeof bound - 1] ^= 1;
    for (size_t i = 0; i < sizeof bound; i++) printf("%02x", bound[i]);
    puts("");
    return 0;
}
