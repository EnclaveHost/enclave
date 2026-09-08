#include "../../wasm/ggml-shielded/shielded-tee.c"
#include "../../wasm/ggml-shielded/tweetnacl.h"
#include <assert.h>
#include <fcntl.h>
#include <sys/stat.h>

enum { G=5, FIRST=7, COUNT=39, MAX_K=160, MAX_N=31 };
static int8_t weights[G][MAX_K*MAX_N], extra[64*7];
static const int K[G]={32,64,96,128,160}, N[G]={3,11,17,31,9};
static uint8_t seed[32]={7}, pk[32], sk[32];
static sh_pads_v3_source source={{1},{2},{3}};
static sh_pads_manifest_group groups[G];
static sh_pads_member members[G+1];
static sh_pads_manifest manifest={{1},{2},{3},groups,members,G,G+1};
static sh_pads_span spans[G]={{FIRST,37},{FIRST+3,33},{0,0},{FIRST+1,2},{FIRST+7,19}};
static sh_pads_v3_policy policy={&manifest,{4},FIRST,FIRST+COUNT,1<<20,1<<16};
static int fail_threads, attempts;
static int fail_allocation, allocation_calls, fail_write, write_calls;
void *__real_malloc(size_t);
void *__real_calloc(size_t,size_t);
void *__wrap_malloc(size_t bytes) {
    int call=__atomic_add_fetch(&allocation_calls,1,__ATOMIC_RELAXED);
    return fail_allocation && call==fail_allocation ? NULL : __real_malloc(bytes);
}
void *__wrap_calloc(size_t count,size_t bytes) {
    int call=__atomic_add_fetch(&allocation_calls,1,__ATOMIC_RELAXED);
    return fail_allocation && call==fail_allocation ? NULL : __real_calloc(count,bytes);
}
ssize_t __real_pwrite(int,const void *,size_t,off_t);
ssize_t __wrap_pwrite(int fd,const void *data,size_t bytes,off_t offset) {
    int call=__atomic_add_fetch(&write_calls,1,__ATOMIC_RELAXED);
    if (fail_write && call==fail_write) { errno=EIO; return -1; }
    return __real_pwrite(fd,data,bytes,offset);
}
int __real_pthread_create(pthread_t *,const pthread_attr_t *,void *(*)(void *),void *);
int __wrap_pthread_create(pthread_t *t,const pthread_attr_t *a,void *(*fn)(void *),void *ctx) {
    attempts++;
    if (fail_threads==2 || (fail_threads==1 && attempts%2==0)) return EAGAIN;
    return __real_pthread_create(t,a,fn,ctx);
}
static sh_link *make_link(const int *order,int count) {
    int err; sh_link *l=sh_link_open("127.0.0.1",1,false,&err); assert(l && err==SH_OK);
    for (int i=0;i<count;i++) {
        int g=order[i]; char name[64]; snprintf(name,sizeof name,"group.%d.weight",g);
        int node=sh_link_add_weight(l,name,weights[g],K[g],N[g],8,-1); assert(node>=0);
        if (g==1) assert(sh_link_add_weight(l,"group.1.shared.weight",extra,K[g],7,8,node)>=0);
    }
    return l;
}
static int mint(sh_link *l,int dir,const char *name,int threads,uint64_t scratch,bool *published) {
    return sh_link_mint_sparse_v3(l,&source,&policy,spans,seed,pk,dir,name,(uint32_t)threads,scratch,published);
}
static void scalar(uint32_t g,uint64_t index,int32_t *u) {
    int32_t r[MAX_K]; sh_pad_r(seed,g,index,K[g],r);
    int count=N[g]+(g==1?7:0);
    for (int j=0;j<count;j++) {
        const int8_t *w=j<N[g]?weights[g]+j*K[g]:extra+(j-N[g])*K[g];
        int64_t sum=0;for (int k=0;k<K[g];k++) sum+=(int64_t)r[k]*w[k];
        u[j]=(int32_t)sh_balanced(sum);
    }
}
static void check(int dir,const char *name,sh_pads_reader *v2) {
    int fd=openat(dir,name,O_RDONLY|O_CLOEXEC);assert(fd>=0);
    int err; sh_pads_v3_reader *r=sh_pads_v3_reader_open(fd,&policy,sk,&err);close(fd);assert(r && err==SH_OK);
    for (uint32_t g=0;g<G;g++) {
        int count=N[g]+(g==1?7:0); sh_pads_span seen;
        assert(sh_pads_v3_reader_span(r,g,&seen)==SH_OK && seen.index0==spans[g].index0 && seen.count==spans[g].count);
        for (uint64_t i=FIRST;i<FIRST+COUNT;i++) {
            int32_t actual[MAX_N],want[MAX_N],old[MAX_N];
            for (int j=0;j<MAX_N;j++)actual[j]=123;
            int rc=sh_pads_v3_reader_cell(r,g,i,actual,(size_t)count);
            if (i<spans[g].index0 || i-spans[g].index0>=spans[g].count) {
                assert(rc==SH_ERR_RANGE);for (int j=0;j<MAX_N;j++)assert(actual[j]==123);
            } else {
                assert(rc==SH_OK);scalar(g,i,want);assert(!memcmp(actual,want,(size_t)count*sizeof *actual));
                assert(sh_pads_reader_cell(v2,g,i,old)==SH_OK);assert(!memcmp(old,actual,(size_t)count*sizeof *actual));
            }
        }
    }
    sh_pads_v3_reader_close(r);
}
static void refuse(sh_link *l,int dir,const char *name,int threads,uint64_t scratch) {
    bool published=true;assert(mint(l,dir,name,threads,scratch,&published)!=SH_OK && !published);
    assert(faccessat(dir,name,F_OK,0)!=0);
}
int main(int argc,char **argv) {
    assert(argc==2);int dir=open(argv[1],O_DIRECTORY|O_RDONLY|O_CLOEXEC);assert(dir>=0);
    assert(crypto_box_keypair(pk,sk)==0);
    for (int g=0;g<G;g++) for (int i=0;i<K[g]*N[g];i++) weights[g][i]=(int8_t)((i*17+g*23)%239-119);
    for (unsigned i=0;i<sizeof extra;i++)extra[i]=(int8_t)((i*19)%239-119);
    const int ordered[G]={0,1,2,3,4},reordered[G]={4,2,1,0,3};
    sh_link *canonical=make_link(ordered,G),*permuted=make_link(reordered,G);
    uint32_t ng=0,nm=0;assert(sh_link_manifest_geometry(canonical,groups,G,members,G+1,&ng,&nm)==SH_OK && ng==G && nm==G+1);
    char bank[1024],baseline[1100];snprintf(bank,sizeof bank,"%s/baseline",argv[1]);assert(!mkdir(bank,0700));
    snprintf(baseline,sizeof baseline,"%s/rect.pads",bank);
    setenv("SHIELDED_MINT_THREADS","1",1);setenv("SHIELDED_MINT_BALANCE","0",1);
    assert(sh_link_mint_shipment(canonical,seed,policy.seed_id,source.calib_digest,FIRST,COUNT,pk,baseline)==SH_OK);
    int err;sh_pads_reader *v2=sh_pads_reader_open(bank,policy.seed_id,sk,&err);assert(v2);
    sh_pads_group table[G];for (int g=0;g<G;g++)table[g]=groups[g].identity;
    assert(sh_pads_reader_bind(v2,table,G)==SH_OK);
    for (int mode=0;mode<5;mode++) {
        char name[32];snprintf(name,sizeof name,"mode-%d.pads3",mode);
        attempts=0;fail_threads=mode>=3?mode-2:0;
        bool published=false;
        assert(mint(mode?permuted:canonical,dir,name,mode>=2?64:1,1<<20,&published)==SH_OK && published);
        assert(attempts==(mode>=2?4:0));fail_threads=0;
        check(dir,name,v2);
    }
    /* Exactly one active group clamps the requested thread budget to one. */
    sh_pads_span saved[G];memcpy(saved,spans,sizeof spans);
    memset(spans,0,sizeof spans);spans[4]=saved[4];attempts=0;bool published=false;
    assert(mint(permuted,dir,"one.pads3",64,1<<20,&published)==SH_OK && published && attempts==0);check(dir,"one.pads3",v2);
    memset(spans,0,sizeof spans);refuse(permuted,dir,"empty",3,1<<20);memcpy(spans,saved,sizeof spans);
    refuse(permuted,dir,"small-scratch",3,1);refuse(permuted,dir,"threads-zero",0,1<<20);refuse(permuted,dir,"threads-many",65,1<<20);
    /* Aggregate cap includes four task buffers AND the writer's two buffers.
     * Active maxima K=160, u_len=N=31; each cell is 16+3*31 = 109 bytes. */
    const uint64_t exact_scratch=4*(16*160*4+16*31*4+12*31*4+3*16*160+2*109)+2*109;
    refuse(permuted,dir,"budget-short",64,exact_scratch-1);
    assert(mint(permuted,dir,"budget-exact",64,exact_scratch,&published)==SH_OK && published);check(dir,"budget-exact",v2);
    int all_allocations_tested=0;
    for (int point=1;point<256;point++) {
        allocation_calls=0;fail_allocation=point;published=true;
        int rc=mint(permuted,dir,"oom",1,1<<20,&published);
        fail_allocation=0;
        if (rc==SH_OK) { assert(allocation_calls<point && published);all_allocations_tested=1;check(dir,"oom",v2);break; }
        assert(rc==SH_ERR_NOMEM && !published && faccessat(dir,"oom",F_OK,0)!=0);
    }
    assert(all_allocations_tested);
    for (int point=1;point<=3;point++) {
        write_calls=0;fail_write=point;refuse(permuted,dir,"write-failed",4,1<<20);fail_write=0;
    }
    for (int k=0;k<3;k++) {
        uint8_t *d=k==0?source.model_digest:k==1?source.calib_digest:source.encoding_digest;
        d[0]^=1;refuse(permuted,dir,"wrong-source",1,1<<20);d[0]^=1;
    }
    spans[0].index0=FIRST-1;refuse(permuted,dir,"outside",1,1<<20);spans[0]=saved[0];
    policy.max_cell_bytes=UINT64_MAX;refuse(permuted,dir,"cell-cap",1,1<<20);policy.max_cell_bytes=1<<16;
    sh_link *partial=make_link(ordered,G-1);refuse(partial,dir,"missing-group",1,1<<20);sh_link_close(partial);
    /* Keep totals valid but swap ordered members of the fused group. */
    uint32_t first=groups[1].member0;sh_pads_member swap=members[first];members[first]=members[first+1];members[first+1]=swap;
    refuse(permuted,dir,"member-order",1,1<<20);swap=members[first];members[first]=members[first+1];members[first+1]=swap;
    /* Wrong registered metadata/state, absent CPU weights, retired link. */
    int local_group=2; assert(permuted->groups[local_group].n_nodes==2);
    int node=permuted->groups[local_group].nodes[1];int64_t offset=permuted->nodes[node].u_off;
    permuted->nodes[node].u_off++;refuse(permuted,dir,"member-offset",1,1<<20);permuted->nodes[node].u_off=offset;
    const int8_t *stored=permuted->nodes[node].w;permuted->nodes[node].w=NULL;refuse(permuted,dir,"no-cpu-weights",1,1<<20);permuted->nodes[node].w=stored;
    permuted->threads_running=1;refuse(permuted,dir,"running",1,1<<20);permuted->threads_running=0;
    assert(sh_link_mint_sparse_v3(permuted,&source,&policy,spans,seed,pk,dir,"null-published",1,1<<20,NULL)==SH_ERR_RANGE);
    permuted->verify_fail=1;refuse(permuted,dir,"retired",1,1<<20);
    sh_pads_reader_close(v2);sh_link_close(permuted);sh_link_close(canonical);close(dir);
    puts("sparse-mint: canonical reorder, scalar/v2 equality, sparse cells, thread fallback and admission failures PASS");
}
