#include "../../wasm/ggml-shielded/shielded-pad-layout.h"
#include <assert.h>
#include <stdio.h>

static sh_pads_group canonical[3] = {
    {0, 5120, 17408, "blk.0.ffn_gate.weight"},
    {1, 5120, 5120, "blk.64.attn_q.weight"},
    {2, 5120, 248320, "output.weight"},
};
static unsigned cases;
static void check(const sh_pads_group *expect, const sh_pads_group *in,
                  const sh_pads_span *spans, uint32_t count,
                  uint64_t lo, uint64_t hi, uint64_t cap, size_t capacity, int want) {
    uint64_t offsets[3] = {UINT64_MAX, UINT64_MAX, UINT64_MAX};
    const sh_pads_sparse_extent untouched = {UINT64_MAX, UINT64_MAX, UINT64_MAX};
    sh_pads_sparse_extent got = untouched;
    int rc = sh_pads_sparse_layout(expect, 3, in, spans, count, lo, hi, cap,
                                  offsets, capacity, &got);
    assert(rc == want);
    if (rc != SH_OK) {
        assert(!memcmp(&got, &untouched, sizeof got));
        for (int i=0; i<3; i++) assert(offsets[i] == UINT64_MAX);
    } else {
        /* Independent wide-integer arithmetic; no sparse helper used. */
        __int128 position = 4096, cells = 0;
        for (int g=0; g<3; g++) {
            assert(offsets[g] == position);
            position += (__int128)spans[g].count * (16 + (__int128)3 * expect[g].u_len);
            cells += spans[g].count;
        }
        assert(got.data_off == 4096 && got.file_bytes == position && got.cells == cells);
        assert(position <= cap);
    }
    cases++;
}
static uint32_t rng=0x85abc197;
static uint32_t next(void) { rng^=rng<<13; rng^=rng>>17; rng^=rng<<5; return rng; }
int main(void) {
    sh_pads_group in[3]; memcpy(in, canonical, sizeof in);
    sh_pads_span spans[3] = {{64,4},{64,7},{64,7}};
    const uint64_t cap = UINT64_C(1)<<30;
    check(canonical,in,spans,3,64,128,cap,3,SH_OK);
    uint64_t exact=4096;
    for (int g=0;g<3;g++) exact+=spans[g].count*(16+3*canonical[g].u_len);
    check(canonical,in,spans,3,64,128,exact,3,SH_OK);
    check(canonical,in,spans,3,64,128,exact-1,3,SH_ERR_RANGE);
    check(canonical,in,spans,3,64,128,0,3,SH_ERR_RANGE);
    check(canonical,in,spans,3,64,128,UINT64_MAX,3,SH_ERR_RANGE);
    check(canonical,in,spans,3,64,128,4095,3,SH_ERR_RANGE);
    check(canonical,in,spans,3,64,128,cap,2,SH_ERR_RANGE);
    check(canonical,in,spans,2,64,128,cap,3,SH_ERR_VERIFY);
    check(canonical,in,spans,3,128,128,cap,3,SH_ERR_RANGE);
    check(canonical,in,spans,3,0,SH_PADS_INDEX_LIMIT+1,cap,3,SH_ERR_RANGE);
    for (int field=0;field<5;field++) {
        memcpy(in,canonical,sizeof in);
        if (field==0) in[2].group=0;
        if (field==1) in[2].K++;
        if (field==2) in[2].u_len++;
        if (field==3) in[2].name[0]='x';
        if (field==4) in[2].name[63]='x';
        check(canonical,in,spans,3,64,128,cap,3,SH_ERR_VERIFY);
    }
    memcpy(in,canonical,sizeof in);
    spans[2].index0=63; check(canonical,in,spans,3,64,128,cap,3,SH_ERR_RANGE);
    spans[2].index0=128; check(canonical,in,spans,3,64,128,cap,3,SH_ERR_RANGE);
    spans[2].index0=64; spans[2].count=UINT64_MAX;
    check(canonical,in,spans,3,64,128,cap,3,SH_ERR_RANGE);
    spans[2].count=0; check(canonical,in,spans,3,64,128,cap,3,SH_ERR_RANGE);
    spans[2].index0=0; check(canonical,in,spans,3,64,128,cap,3,SH_OK);
    spans[0]=(sh_pads_span){0,0}; spans[1]=(sh_pads_span){0,0};
    check(canonical,in,spans,3,64,128,cap,3,SH_ERR_RANGE);
    spans[2]=(sh_pads_span){SH_PADS_INDEX_LIMIT-1,1};
    check(canonical,in,spans,3,SH_PADS_INDEX_LIMIT-1,SH_PADS_INDEX_LIMIT,cap,3,SH_OK);
    spans[2].count=2;
    check(canonical,in,spans,3,SH_PADS_INDEX_LIMIT-1,SH_PADS_INDEX_LIMIT,cap,3,SH_ERR_RANGE);

    sh_pads_group huge[3]; memcpy(huge,canonical,sizeof huge);
    for (int g=0;g<3;g++) {
        huge[g].u_len=(UINT64_C(64)*UINT32_MAX)/3;
        spans[g]=(sh_pads_span){0,SH_PADS_INDEX_LIMIT};
    }
    /* Each cell is within the AEAD limit, but the combined file overflows a
     * signed file offset. The prior two valid groups must not publish offsets. */
    check(huge,huge,spans,3,0,SH_PADS_INDEX_LIMIT,INT64_MAX,3,SH_ERR_RANGE);
    spans[1]=(sh_pads_span){0,0}; spans[2]=(sh_pads_span){0,0};
    check(huge,huge,spans,3,0,SH_PADS_INDEX_LIMIT,INT64_MAX,3,SH_OK);
    huge[0].u_len++; check(huge,huge,spans,3,0,SH_PADS_INDEX_LIMIT,INT64_MAX,3,SH_ERR_RANGE);

    for (int round=0;round<4096;round++) {
        __int128 size=4096; uint64_t cells=0;
        for (int g=0;g<3;g++) {
            if (next()%4==0) spans[g]=(sh_pads_span){0,0};
            else { uint64_t start=128+next()%128; spans[g]=(sh_pads_span){start,1+next()%(256-start)}; }
            size+=(__int128)spans[g].count*(16+(__int128)3*canonical[g].u_len);
            cells+=spans[g].count;
        }
        const uint64_t limit=(uint64_t)size - (round%2 ? 0 : 1);
        check(canonical,in,spans,3,128,256,limit,3,
              cells && size<=limit ? SH_OK : SH_ERR_RANGE);
    }
    /* Metadata alignment for a full 262-group manifest, including empty spans. */
    sh_pads_group many[262]; sh_pads_span ranges[262]; uint64_t offsets[262];
    memset(many,0,sizeof many); memset(ranges,0,sizeof ranges);
    for (uint32_t i=0;i<262;i++) { many[i].group=i; many[i].K=32; many[i].u_len=64; snprintf(many[i].name,64,"group.%u",i); }
    ranges[261]=(sh_pads_span){8,1}; sh_pads_sparse_extent ex;
    assert(sh_pads_sparse_layout(many,262,many,ranges,262,8,9,cap,offsets,262,&ex)==SH_OK);
    assert(ex.data_off==28672 && ex.file_bytes==28672+16+3*64 && ex.cells==1);
    for (int i=0;i<262;i++) assert(offsets[i]==28672);
    printf("sparse-layout: %u cases, private canonical identity, reservation bounds, empty spans, caps, overflow and atomic outputs PASS\n",cases+1);
}
