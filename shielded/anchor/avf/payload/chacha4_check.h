#ifndef ASTRA_CHACHA4_CHECK_H
#define ASTRA_CHACHA4_CHECK_H
#include <stdio.h>
#include <string.h>
#include "chacha4.h"
static uint32_t a4_check_state=0x721fad3u;
static uint32_t a4_check_next(void) { a4_check_state^=a4_check_state<<13; a4_check_state^=a4_check_state>>17; a4_check_state^=a4_check_state<<5; return a4_check_state; }
static int astra_chacha4_check(void) {
    const uint64_t counters[]={0,1,UINT32_MAX-2ull,UINT32_MAX,UINT64_MAX-3,UINT64_MAX-1};
    const int widths[]={1,7,8,9,31,32,33,63,64,65,5120,34816,248320};
    int checks=0;
    for (int seedcase=0;seedcase<8;seedcase++) {
        uint32_t key[8]; uint8_t seed[32];
        for (int i=0;i<8;i++) { key[i]=a4_check_next(); for (int j=0;j<4;j++) seed[4*i+j]=(uint8_t)(key[i]>>(8*j)); }
        for (unsigned c=0;c<sizeof counters/sizeof counters[0];c++) {
            uint32_t got[4][16],want[16]; astra_chacha4(key,counters[c],got);
            for (int b=0;b<4;b++) { sh_chacha20_block(key,counters[c]+(uint64_t)b,want); if (memcmp(got[b],want,sizeof want)) return 2; checks++; }
        }
        int32_t *got=malloc(248320*sizeof *got), *want=malloc(248320*sizeof *want);
        if (!got || !want) return 3;
        for (unsigned w=0;w<sizeof widths/sizeof widths[0];w++) for (int scope=0;scope<4;scope++) {
            const uint32_t group=(scope&1)?SH_PADS_GROUP_LIMIT-1:0;
            const uint64_t index=(scope&2)?SH_PADS_INDEX_LIMIT-1:0;
            sh_pad_r(seed,group,index,widths[w],want); astra_pad_r4(seed,group,index,widths[w],got);
            if (memcmp(got,want,(size_t)widths[w]*sizeof *got)) { fprintf(stderr,"mismatch seed=%d width=%d scope=%d\n",seedcase,widths[w],scope); return 4; }
            checks++;
        }
        free(got); free(want);
    }
    return checks;
}
#endif
