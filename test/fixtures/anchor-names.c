/* anchor-names: what the pVM's pads port accepts under a name (shielded/anchor/avf/payload/anchor_names.c). */
#include "anchor_names.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#define H32 "0123456789abcdef0123456789abcdef"
int main(void) {
    char sid[33]; uint64_t i0, c;
    assert(anchor_name_classify(H32 "-0-64.pads", sid, &i0, &c) == ANCHOR_NAME_SHIPMENT && !strcmp(sid, H32) && i0 == 0 && c == 64);
    assert(anchor_name_classify(H32 "-18446744073709551551-64.pads", sid, &i0, &c) == ANCHOR_NAME_SHIPMENT && i0 == 18446744073709551551ULL);
    /* the prefix assets, exactly */
    assert(anchor_name_classify("prefix.kv", sid, &i0, &c) == ANCHOR_NAME_PREFIX && sid[0] == 0 && i0 == 0 && c == 0);
    assert(anchor_name_classify("prefix.kv.sig", NULL, NULL, NULL) == ANCHOR_NAME_PREFIX);
    assert(anchor_name_classify("prefix.txt", NULL, NULL, NULL) == ANCHOR_NAME_PREFIX);
    /* refused shapes */
    const char *bad[] = { "prefix.kv.bak", "Prefix.kv", "prefix.kv/", "../prefix.kv", "prefix.txt.pads",
        H32 "-0-0.pads",                    /* empty range */
        H32 "-00-64.pads",                  /* non-canonical decimal */
        H32 "-0-064.pads",
        H32 "-+0-64.pads",
        H32 "-0-64.pad", H32 "-0-64.pads.tmp", "." H32 "-0-64.pads.tmp",
        "0123456789ABCDEF0123456789abcdef-0-64.pads",          /* uppercase hex */
        "0123456789abcdef0123456789abcde-0-64.pads",           /* 31 hex */
        H32 "-0-18446744073709551616.pads",                    /* count overflows */
        H32 "-18446744073709551615-1.pads",                    /* index0 + count overflows */
        H32 "-0-64.pads/x", H32 "-a-64.pads", H32 "--64.pads", H32 "-0-.pads", "", "model.gguf", NULL };
    for (int i = 0; bad[i]; i++) assert(anchor_name_classify(bad[i], sid, &i0, &c) == ANCHOR_NAME_REFUSED);
    assert(anchor_name_classify(NULL, sid, &i0, &c) == ANCHOR_NAME_REFUSED);
    printf("anchor-names: ok\n");
    return 0;
}
