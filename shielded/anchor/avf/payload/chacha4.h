/* Standalone speed candidate: four independent blocks, identical existing stream.
 * No production call sites or sampling rules are changed by this header. */
#ifndef ASTRA_CHACHA4_H
#define ASTRA_CHACHA4_H
#include <stdint.h>
#include <stdlib.h>
#include "shielded-pads.h"
#include "shielded-field.h"
typedef uint32_t astra_u32x4 __attribute__((vector_size(16)));
#define A4_SPLAT(v) ((astra_u32x4){(v),(v),(v),(v)})
#define A4_ROL(v,n) (((v) << (n)) | ((v) >> (32-(n))))
#define A4_QR(a,b,c,d) do { a+=b; d^=a; d=A4_ROL(d,16); c+=d; b^=c; b=A4_ROL(b,12); a+=b; d^=a; d=A4_ROL(d,8); c+=d; b^=c; b=A4_ROL(b,7); } while (0)
static __attribute__((noinline)) void astra_chacha4(const uint32_t key[8], uint64_t ctr, uint32_t out[4][16]) {
    astra_u32x4 x[16];
    x[0]=A4_SPLAT(0x61707865u); x[1]=A4_SPLAT(0x3320646eu);
    x[2]=A4_SPLAT(0x79622d32u); x[3]=A4_SPLAT(0x6b206574u);
    for (int i=0;i<8;i++) x[4+i]=A4_SPLAT(key[i]);
    const astra_u32x4 lo={(uint32_t)ctr,(uint32_t)(ctr+1),(uint32_t)(ctr+2),(uint32_t)(ctr+3)};
    const astra_u32x4 hi={(uint32_t)(ctr>>32),(uint32_t)((ctr+1)>>32),(uint32_t)((ctr+2)>>32),(uint32_t)((ctr+3)>>32)};
    x[12]=lo; x[13]=hi; x[14]=A4_SPLAT(0u); x[15]=A4_SPLAT(0u);
    for (int i=0;i<10;i++) {
        A4_QR(x[0],x[4],x[8],x[12]); A4_QR(x[1],x[5],x[9],x[13]);
        A4_QR(x[2],x[6],x[10],x[14]); A4_QR(x[3],x[7],x[11],x[15]);
        A4_QR(x[0],x[5],x[10],x[15]); A4_QR(x[1],x[6],x[11],x[12]);
        A4_QR(x[2],x[7],x[8],x[13]); A4_QR(x[3],x[4],x[9],x[14]);
    }
    x[0]+=A4_SPLAT(0x61707865u); x[1]+=A4_SPLAT(0x3320646eu);
    x[2]+=A4_SPLAT(0x79622d32u); x[3]+=A4_SPLAT(0x6b206574u);
    for (int i=0;i<8;i++) x[4+i]+=A4_SPLAT(key[i]);
    x[12]+=lo; x[13]+=hi;
    for (int w=0;w<16;w++) for (int b=0;b<4;b++) out[b][w]=x[w][b];
}

static __attribute__((noinline)) void astra_pad_r4(const uint8_t seed[32], uint32_t group, uint64_t index, int64_t K, int32_t *out) {
    if (!seed || !out || group>=SH_PADS_GROUP_LIMIT || index>=SH_PADS_INDEX_LIMIT || K<=0 || K>SH_PADS_K_LIMIT) abort();
    uint32_t key[8];
    for (int i=0;i<8;i++) key[i]=(uint32_t)seed[4*i] | ((uint32_t)seed[4*i+1]<<8) | ((uint32_t)seed[4*i+2]<<16) | ((uint32_t)seed[4*i+3]<<24);
    uint64_t ctr=((uint64_t)group<<48) | (index<<24);
    int64_t n=0;
    for (;n+32<=K;n+=32,ctr+=4) {
        uint32_t blocks[4][16]; astra_chacha4(key,ctr,blocks);
        for (int b=0;b<4;b++) for (int j=0;j<8;j++) {
            const uint64_t v=((uint64_t)blocks[b][2*j+1]<<32) | blocks[b][2*j];
            out[n+8*b+j]=(int32_t)(v%(uint64_t)SH_M_MOD);
        }
    }
    while (n<K) {
        uint32_t block[16]; sh_chacha20_block(key,ctr++,block);
        for (int j=0;j<8 && n<K;j++,n++) {
            const uint64_t v=((uint64_t)block[2*j+1]<<32) | block[2*j];
            out[n]=(int32_t)(v%(uint64_t)SH_M_MOD);
        }
    }
}
#undef A4_SPLAT
#undef A4_ROL
#undef A4_QR
#endif
