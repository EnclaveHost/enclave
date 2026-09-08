#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <unistd.h>

static int alloc_call, fail_alloc, rng_fail, rng_zero, rng_intr;
static uint64_t rng_word;
static size_t rng_bytes;
static void *test_malloc(size_t n) { return ++alloc_call == fail_alloc ? NULL : malloc(n); }
static void *test_calloc(size_t n, size_t z) { return ++alloc_call == fail_alloc ? NULL : calloc(n,z); }
static void *test_realloc(void *p,size_t n) { return ++alloc_call == fail_alloc ? NULL : realloc(p,n); }
static ssize_t test_random(void *p, size_t n, unsigned flags) {
    (void)flags;
    if (rng_intr) { rng_intr=0; errno=EINTR; return -1; }
    if (rng_fail) { errno=EIO; return -1; }
    if (rng_zero) return 0;
    assert(n%8==0); rng_bytes+=n;
    for(size_t i=0;i<n/8;i++) {uint64_t x=rng_word++;memcpy((char*)p+i*8,&x,8);}
    return (ssize_t)n;
}
static int create_call, inject_thread, made, joined;
static pthread_t handles[16];
static int test_create(pthread_t *t,const pthread_attr_t *a,void *(*fn)(void*),void *arg) {
    if(inject_thread && create_call++==1)return EAGAIN;
    int rc=pthread_create(t,a,fn,arg);
    if(inject_thread && rc==0)handles[made++]=*t;
    return rc;
}
static int test_join(pthread_t t,void **result) {
    if(inject_thread) {
        int found=0;for(int i=0;i<made;i++)if(pthread_equal(t,handles[i]))found=1;
        assert(found);joined++;
    }
    return pthread_join(t,result);
}
#include "../../wasm/ggml-shielded/shielded-wire.c"
#define malloc test_malloc
#define calloc test_calloc
#define realloc test_realloc
#define getrandom test_random
#define pthread_create test_create
#define pthread_join test_join
#include "../../wasm/ggml-shielded/shielded-tee.c"
#undef malloc
#undef calloc
#undef realloc
#undef getrandom
#undef pthread_create
#undef pthread_join

static void reference_prepare(const int8_t *w,int64_t k,int64_t n,const int64_t *s,int reps,int64_t *out) {
    for(int64_t col=0;col<k;col++)for(int rep=0;rep<reps;rep++) {
        int64_t sum=0;for(int64_t row=0;row<n;row++)sum+=(int64_t)w[row*k+col]*s[row*reps+rep];
        out[col*reps+rep]=(sum%SH_FV_P2+SH_FV_P2)%SH_FV_P2;
    }
}
static const sh_simd test_simd={.fv_prepare=reference_prepare};
static sh_link *new_link(bool verify) {
    sh_link *l=calloc(1,sizeof *l);assert(l);l->verify=verify;l->simd=&test_simd;
    pthread_mutex_init(&l->pool_mu,NULL);pthread_mutex_init(&l->bank.mu,NULL);
    pthread_cond_init(&l->need_refill,NULL);pthread_cond_init(&l->pool_filled,NULL);
    return l;
}
enum {K=32,N=4};
static int8_t weights[K*513];
static void reset_faults(void) {alloc_call=fail_alloc=rng_fail=rng_zero=rng_intr=0;rng_bytes=0;rng_word=17;}

int main(void) {
    setenv("SHIELDED_PAD_CHECK","1",1);
    for(size_t i=0;i<sizeof weights;i++)weights[i]=(int8_t)(i%15-7);
    /* Every required allocation must reject registration without publishing
     * a partial group or losing its allocated verification arrays. */
    for(int grouped=0;grouped<2;grouped++) {
        int failures=0;
        for(int nth=1;nth<=12;nth++) {
            reset_faults();sh_link *l=new_link(true);
            if(grouped)assert(sh_link_add_weight(l,"first.weight",weights,K,N,8,-1)==0);
            sh_group old={0};if(grouped)old=l->groups[0];
            int64_t wb=l->wbytes,ab=l->abytes;size_t nn=l->n_nodes,ng=l->n_groups;
            alloc_call=0;fail_alloc=nth;
            int rc=sh_link_add_weight(l,"next.weight",weights,K,N,8,grouped?0:-1);
            if(rc<0) {
                failures++;assert(rc==SH_ERR_NOMEM);
                assert(l->n_nodes==nn && l->n_groups==ng && l->wbytes==wb && l->abytes==ab);
                if(grouped)assert(!memcmp(&old,l->groups,sizeof old));
                reset_faults();assert(sh_link_add_weight(l,"next.weight",weights,K,N,8,grouped?0:-1)==(int)nn);
            }
            reset_faults();sh_link_close(l);
        }
        assert(failures==(grouped?7:9));
    }
    /* Zero/error entropy must never become predictable or absent checks.
     * EINTR is retried. Pad coefficients come directly from OS random words. */
    for(int verify=0;verify<=1;verify++)for(int kind=0;kind<3;kind++) {
        reset_faults();sh_link *l=new_link(verify);
        rng_fail=kind==0;rng_zero=kind==1;rng_intr=kind==2;
        int rc=sh_link_add_weight(l,"rng.weight",weights,K,N,8,-1);
        if(kind<2) {assert(rc==SH_ERR_IO);assert(l->n_nodes==0 && l->n_groups==0 && l->wbytes==0 && l->abytes==0);}
        else assert(rc==0 && l->nodes[0].sM && l->nodes[0].stM);
        reset_faults();sh_link_close(l);
    }
    reset_faults();sh_link *l=new_link(false);
    assert(sh_link_add_weight(l,"chunks.weight",weights,K,513,8,-1)==0);
    assert(rng_bytes==513*8);
    for(int j=0;j<513;j++)assert(l->nodes[0].sM[j]==1+(17+j)%(SH_FV_S_RANGE-1));
    for(int k=0;k<K;k++) {
        int64_t sum=0;for(int j=0;j<513;j++)sum+=(int64_t)weights[j*K+k]*l->nodes[0].sM[j];
        assert(l->nodes[0].stM[k]==(sum%SH_M_MOD+SH_M_MOD)%SH_M_MOD);
    }
    sh_link_close(l);
    /* A hole in successful pthread_create calls must not leave later workers
     * unjoined before their scratch arrays are read and freed. */
    reset_faults();l=new_link(true);int64_t s[256*2],got[K*2],want[K*2];
    for(size_t i=0;i<sizeof s/sizeof *s;i++)s[i]=(int64_t)i+1;
    inject_thread=1;
    fv_prepare_parallel(l,weights,K,256,s,2,got);
    inject_thread=0;assert(made==joined);
    if(sysconf(_SC_NPROCESSORS_ONLN)>1)assert(create_call>1 && made>0);
    reference_prepare(weights,K,256,s,2,want);assert(!memcmp(want,got,sizeof want));
    sh_link_close(l);
    /* Invalid shapes/offsets and sharing leave a valid prior group usable. */
    l=new_link(true);assert(sh_link_add_weight(l,"first.weight",weights,K,N,8,-1)==0);
    sh_group old=l->groups[0];int64_t wb=l->wbytes,ab=l->abytes;
    assert(sh_link_add_weight(l,"bad",weights,K,0,8,0)==SH_ERR_RANGE);
    assert(sh_link_add_weight(l,"bad",weights,K,-1,8,0)==SH_ERR_RANGE);
    assert(sh_link_add_weight(l,"bad",weights,K,INT64_MAX,8,0)==SH_ERR_RANGE);
    assert(sh_link_add_weight(l,"bad",weights,K,N,0,0)==SH_ERR_RANGE);
    assert(sh_link_add_weight(l,"bad",weights,K,N,8,7)==SH_ERR_PROTO);
    l->wbytes=INT64_MAX;assert(sh_link_add_weight(l,"bad",weights,K,N,8,0)==SH_ERR_RANGE);l->wbytes=wb;
    assert(l->n_nodes==1 && l->n_groups==1 && l->abytes==ab && !memcmp(&old,l->groups,sizeof old));
    sh_link_close(l);puts("shielded-register: ok");
}
