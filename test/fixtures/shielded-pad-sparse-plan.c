#include <stdlib.h>
#include <assert.h>
static int fail_alloc;
static void *plan_calloc(size_t n, size_t size) { return fail_alloc ? NULL : calloc(n,size); }
#define calloc plan_calloc
#include "../../wasm/ggml-shielded/shielded-pad-sparse-plan.h"
#undef calloc
#include <stdio.h>

enum { GROUPS=4, WIDTH=32, COVER=48, OUT=GROUPS+COVER };
static sh_pads_manifest_group groups[GROUPS];
static sh_pads_member members[GROUPS];
static sh_pads_manifest manifest;
static uint32_t rng = 419283;
static uint32_t next(void) { rng = rng * UINT32_C(1664525) + UINT32_C(1013904223); return rng; }
static void init(void) {
    for (unsigned g=0; g<GROUPS; g++) {
        groups[g].identity.group=g; groups[g].identity.K=64; groups[g].identity.u_len=17+g;
        snprintf(groups[g].identity.name, SH_PADS_NAME_MAX, "group.%u",g);
        memcpy(members[g].name,groups[g].identity.name,SH_PADS_NAME_MAX); members[g].N=17+g;
        groups[g].member0=g; groups[g].member_count=1;
    }
    manifest.groups=groups; manifest.members=members; manifest.group_count=GROUPS; manifest.member_count=GROUPS;
}
static void refuse(const sh_pads_span *d, const sh_pads_interval *c, size_t cn,
        uint64_t lo, uint64_t hi, uint64_t cells, uint64_t bytes, size_t cap, int want) {
    sh_pads_interval out[OUT], before[OUT]; memset(out,0xa5,sizeof out); memcpy(before,out,sizeof out);
    sh_pads_missing_totals t, old; memset(&t,0x5a,sizeof t); memcpy(&old,&t,sizeof t);
    assert(sh_pads_sparse_missing(&manifest,d,GROUPS,lo,hi,c,cn,cells,bytes,out,cap,&t)==want);
    assert(!memcmp(out,before,sizeof out) && !memcmp(&t,&old,sizeof t));
}
int main(void) {
    init();
    sh_pads_span demand[GROUPS]={{0,12},{3,14},{0,0},{21,11}};
    sh_pads_interval cover[]={{0,6,4},{0,2,4},{0,3,7},{1,0,5},{1,15,17},{3,0,32},{0,2,4}};
    const sh_pads_interval expected[]={{0,0,2},{0,10,2},{1,5,10}};
    sh_pads_interval out[OUT]; sh_pads_missing_totals t;
    assert(sh_pads_sparse_missing(&manifest,demand,GROUPS,0,32,cover,7,1000,100000,out,OUT,&t)==SH_OK);
    assert(t.intervals==3 && t.cells==14 && t.payload_bytes==4*(16+3*17)+10*(16+3*18));
    for (size_t i=0;i<t.intervals;i++) assert(out[i].group==expected[i].group && out[i].index0==expected[i].index0 && out[i].count==expected[i].count);
    refuse(demand,cover,7,0,32,13,100000,OUT,SH_ERR_RANGE);
    refuse(demand,cover,7,0,32,14,t.payload_bytes-1,OUT,SH_ERR_RANGE);
    refuse(demand,cover,7,0,32,14,t.payload_bytes,2,SH_ERR_RANGE);
    assert(sh_pads_sparse_missing(&manifest,demand,GROUPS,0,32,cover,7,14,t.payload_bytes,out,3,&t)==SH_OK);
    // Complete coverage is successful and can use a NULL, zero-capacity output.
    sh_pads_interval complete[GROUPS];
    for (unsigned g=0;g<GROUPS;g++) complete[g]=(sh_pads_interval){g,0,32};
    assert(sh_pads_sparse_missing(&manifest,demand,GROUPS,0,32,complete,GROUPS,1,1,NULL,0,&t)==SH_OK);
    assert(!t.intervals && !t.cells && !t.payload_bytes);
    // Independent finite-set oracle. Ordering, duplicates, empty desired groups,
    // nested coverage and disjoint gaps vary independently of the implementation.
    for (unsigned trial=0;trial<2000;trial++) {
        unsigned char need[GROUPS][WIDTH]={{0}}, seen[GROUPS][WIDTH]={{0}};
        for (unsigned g=0;g<GROUPS;g++) {
            uint64_t lo=next()%WIDTH, n=next()%(WIDTH-lo+1);
            demand[g]=(sh_pads_span){n?lo:0,n};
            for (uint64_t j=lo;j<lo+n;j++) need[g][j]=1;
        }
        sh_pads_interval cov[COVER]; size_t nc=next()%(COVER+1);
        for (size_t i=0;i<nc;i++) {
            unsigned g=next()%GROUPS, lo=next()%WIDTH, n=1+next()%(WIDTH-lo);
            cov[i]=(sh_pads_interval){g,lo,n};
            for (unsigned j=lo;j<lo+n;j++) need[g][j]=0;
        }
        assert(sh_pads_sparse_missing(&manifest,demand,GROUPS,0,WIDTH,cov,nc,1000,100000,out,OUT,&t)==SH_OK);
        uint64_t cells=0, bytes=0;
        for (size_t i=0;i<t.intervals;i++) {
            const sh_pads_interval *x=&out[i]; assert(x->group<GROUPS && x->count && x->index0+x->count<=WIDTH);
            if (i) assert(out[i-1].group<x->group || (out[i-1].group==x->group && out[i-1].index0+out[i-1].count<x->index0));
            for (uint64_t j=x->index0;j<x->index0+x->count;j++) { assert(!seen[x->group][j]); seen[x->group][j]=1; }
            cells+=x->count; bytes+=x->count*(16+3*groups[x->group].identity.u_len);
        }
        assert(!memcmp(need,seen,sizeof need)); assert(cells==t.cells && bytes==t.payload_bytes);
    }
    memset(demand,0,sizeof demand); demand[0]=(sh_pads_span){SH_PADS_INDEX_LIMIT-1,1};
    assert(sh_pads_sparse_missing(&manifest,demand,GROUPS,SH_PADS_INDEX_LIMIT-1,SH_PADS_INDEX_LIMIT,NULL,0,1,67,out,OUT,&t)==SH_OK && t.cells==1);
    demand[0].count=2; refuse(demand,NULL,0,0,SH_PADS_INDEX_LIMIT,100,10000,OUT,SH_ERR_RANGE);
    demand[0]=(sh_pads_span){UINT64_MAX,2}; refuse(demand,NULL,0,0,32,100,10000,OUT,SH_ERR_RANGE);
    demand[0]=(sh_pads_span){1,0}; refuse(demand,NULL,0,0,32,100,10000,OUT,SH_ERR_RANGE);
    demand[0]=(sh_pads_span){0,1};
    const sh_pads_interval bad[]={{GROUPS,0,1},{0,0,0},{0,SH_PADS_INDEX_LIMIT,1},{0,UINT64_MAX,2}};
    for (size_t i=0;i<sizeof bad/sizeof bad[0];i++) refuse(demand,&bad[i],1,0,32,100,10000,OUT,SH_ERR_RANGE);
    refuse(demand,cover,SH_PADS_SPARSE_MAX_COVERAGE+1,0,32,100,10000,OUT,SH_ERR_RANGE); // cap before any input read
    refuse(demand,NULL,1,0,32,100,10000,OUT,SH_ERR_RANGE);
    refuse(demand,NULL,0,0,SH_PADS_INDEX_LIMIT+1,100,10000,OUT,SH_ERR_RANGE);
    refuse(demand,NULL,0,0,0,100,10000,OUT,SH_ERR_RANGE);
    refuse(demand,NULL,0,0,32,0,10000,OUT,SH_ERR_RANGE);
    fail_alloc=1; refuse(demand,NULL,0,0,32,100,10000,OUT,SH_ERR_NOMEM); fail_alloc=0;
    groups[1].identity.group=0; refuse(demand,NULL,0,0,32,100,10000,OUT,SH_ERR_RANGE); groups[1].identity.group=1;
    // A maximum admitted coverage set is accepted with bounded scratch.
    sh_pads_interval *many=calloc(SH_PADS_SPARSE_MAX_COVERAGE,sizeof *many); assert(many);
    for (size_t i=0;i<SH_PADS_SPARSE_MAX_COVERAGE;i++) many[i]=(sh_pads_interval){0,0,1};
    assert(sh_pads_sparse_missing(&manifest,demand,GROUPS,0,32,many,SH_PADS_SPARSE_MAX_COVERAGE,1,1,NULL,0,&t)==SH_OK && !t.cells);
    free(many);
    // Worst-case gap count: every interval splits group zero once, while
    // every other canonical group contributes one missing interval.
    sh_pads_manifest_group *mg=calloc(SH_PADS_MANIFEST_MAX_GROUPS,sizeof *mg);
    sh_pads_member *mm=calloc(SH_PADS_MANIFEST_MAX_GROUPS,sizeof *mm);
    sh_pads_span *md=calloc(SH_PADS_MANIFEST_MAX_GROUPS,sizeof *md);
    many=calloc(SH_PADS_SPARSE_MAX_COVERAGE,sizeof *many);
    const size_t max_gaps=SH_PADS_MANIFEST_MAX_GROUPS+SH_PADS_SPARSE_MAX_COVERAGE;
    sh_pads_interval *mo=calloc(max_gaps,sizeof *mo); assert(mg && mm && md && many && mo);
    for (unsigned g=0;g<SH_PADS_MANIFEST_MAX_GROUPS;g++) {
        mg[g].identity.group=g; mg[g].identity.K=64; mg[g].identity.u_len=17;
        snprintf(mg[g].identity.name,SH_PADS_NAME_MAX,"group.%u",g);
        memcpy(mm[g].name,mg[g].identity.name,SH_PADS_NAME_MAX); mm[g].N=17;
        mg[g].member0=g; mg[g].member_count=1; md[g]=(sh_pads_span){0,1};
    }
    md[0].count=2*SH_PADS_SPARSE_MAX_COVERAGE+1;
    for (unsigned i=0;i<SH_PADS_SPARSE_MAX_COVERAGE;i++)
        many[i]=(sh_pads_interval){0,2*(SH_PADS_SPARSE_MAX_COVERAGE-i)-1,1};
    sh_pads_manifest maxm={0}; maxm.groups=mg; maxm.members=mm;
    maxm.group_count=maxm.member_count=SH_PADS_MANIFEST_MAX_GROUPS;
    assert(sh_pads_sparse_missing(&maxm,md,maxm.group_count,0,SH_PADS_INDEX_LIMIT,many,SH_PADS_SPARSE_MAX_COVERAGE,
        max_gaps,max_gaps*67,mo,max_gaps,&t)==SH_OK);
    assert(t.intervals==max_gaps && t.cells==max_gaps && t.payload_bytes==max_gaps*67);
    for (size_t i=0;i<=SH_PADS_SPARSE_MAX_COVERAGE;i++)
        assert(mo[i].group==0 && mo[i].index0==2*i && mo[i].count==1);
    for (size_t i=SH_PADS_SPARSE_MAX_COVERAGE+1;i<max_gaps;i++)
        assert(mo[i].group==i-SH_PADS_SPARSE_MAX_COVERAGE && mo[i].index0==0 && mo[i].count==1);
    free(mg); free(mm); free(md); free(many); free(mo);
    puts("shielded-pad-sparse-plan: PASS");
}
