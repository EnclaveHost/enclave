#include "../../wasm/ggml-shielded/shielded-tee.c"
#include <assert.h>

/* The linker wraps malloc after compilation; volatile keeps compiler builtin
 * assumptions from folding reads of counters changed by that wrapper. */
static volatile int tracking, attempts, fail_at;
static volatile size_t allocated;
void *__real_malloc(size_t);
void *__wrap_malloc(size_t n) {
    if (tracking) {
        allocated += n;
        if (++attempts == fail_at) return NULL;
    }
    return __real_malloc(n);
}
static void begin(int fail) { attempts=0; allocated=0; fail_at=fail; tracking=1; }
static void finish(void) { tracking=0; }

typedef struct { const int8_t *w; int64_t K,N; int calls, fail; } source;
static void oracle(const int8_t *w, int64_t K, int64_t N, const int32_t *r,
                   int b, int32_t *u, int64_t stride) {
    for (int row=0; row<b; ++row) for (int64_t j=0; j<N; ++j) {
        int64_t sum=0;
        for (int64_t k=0; k<K; ++k) sum+=(int64_t)r[(int64_t)row*K+k]*w[j*K+k];
        u[(int64_t)row*stride+j]=sh_balanced(sum);
    }
}
static int provider(void *ctx, const int32_t *r, int b, int32_t *u, int64_t stride) {
    source *s=ctx; s->calls++;
    if (s->fail) { u[0]=123; return SH_ERR_IO; }
    oracle(s->w,s->K,s->N,r,b,u,stride); return SH_OK;
}
static void check(const sh_simd *simd, int K, int b, int mode) {
    source src[3]={{.K=K,.N=5},{.K=K,.N=7},{.K=K+64,.N=19}};
    sh_node nodes[3]={0};
    for (int i=0; i<3; ++i) {
        int8_t *w=malloc((size_t)src[i].K*src[i].N); assert(w);
        for (int64_t j=0; j<src[i].K*src[i].N; ++j) w[j]=(int8_t)(j%239-119);
        src[i].w=w;
        nodes[i].w=w; nodes[i].K=src[i].K; nodes[i].N=src[i].N;
        nodes[i].u_off=i==1?5:0;
        if (mode==1 || (mode==2 && i!=1) || (mode==3 && i!=0)) {
            nodes[i].w=NULL; nodes[i].w_refill=provider; nodes[i].w_ctx=&src[i];
        }
    }
    sh_group groups[2]={{.K=K,.nodes={0,1},.n_nodes=2,.u_len=12},
                         {.K=K+64,.nodes={2},.n_nodes=1,.u_len=19}};
    sh_link l={0}; l.nodes=nodes; l.n_nodes=3; l.groups=groups; l.n_groups=2;
    l.Kmax=K+64; l.Nmax=19; l.simd=simd;
    gen_scratch s;
    begin(0); assert(gen_scratch_init(&l,&s,b)==SH_OK); finish();
    const size_t expected=mode==1?0:(size_t)3*b*(mode?K:K+64)+(size_t)48*(mode==2?7:mode==3?5:19);
    assert(allocated==expected && attempts==(mode==1?0:2));
    if (mode==1) assert(!s.planes && !s.acc);
    for (int gi=0; gi<2; ++gi) {
        const sh_group *g=&groups[gi];
        const size_t rn=(size_t)b*g->K, un=(size_t)b*g->u_len;
        int32_t *r=malloc(rn*sizeof *r), *out=malloc((un+2)*sizeof *out), *want=malloc(un*sizeof *want);
        assert(r && out && want);
        for (size_t i=0; i<rn; ++i) r[i]=(int32_t)(i%3==0?SH_M_MOD-1:i%3==1?0:(i*7919)%SH_M_MOD);
        out[0]=out[un+1]=INT32_MIN;
        for (int i=0; i<g->n_nodes; ++i) {
            int ni=g->nodes[i];
            oracle(src[ni].w,src[ni].K,src[ni].N,r,b,want+nodes[ni].u_off,g->u_len);
        }
        assert(generate_products(&l,g,b,r,s.planes,out+1,s.acc)==SH_OK);
        assert(!memcmp(out+1,want,un*sizeof *want));
        assert(out[0]==INT32_MIN && out[un+1]==INT32_MIN);
        for (int i=0; i<g->n_nodes; ++i) {
            int ni=g->nodes[i];
            if (!nodes[ni].w_refill) continue;
            src[ni].fail=1;
            assert(generate_products(&l,g,b,r,s.planes,out+1,s.acc)==SH_ERR_VERIFY);
            assert(sh_integrity_failed(&l));
            for (size_t j=1; j<=un; ++j) assert(out[j]==0);
            assert(out[0]==INT32_MIN && out[un+1]==INT32_MIN);
            src[ni].fail=0;
        }
        free(r); free(out); free(want);
    }
    free(s.planes); free(s.acc);
    for (int failure=1; failure<=2; ++failure) {
        begin(failure);
        const int rc=gen_scratch_init(&l,&s,b);
        finish();
        assert(rc==(mode==1?SH_OK:SH_ERR_NOMEM));
        assert(!s.planes && !s.acc);
    }
    for (int i=0; i<3; ++i) free((void *)src[i].w);
}
int main(void) {
    const sh_simd *tables[]={sh_simd_generic(),sh_simd_get()};
    const int batches[]={1,4,16,64}, widths[]={65,129};
    int cases=0;
    for (int t=0; t<2; ++t) for (int k=0; k<2; ++k)
        for (int b=0; b<4; ++b) for (int mode=0; mode<4; ++mode) {
            check(tables[t],widths[k],batches[b],mode); cases++;
        }
    // No native weights (including a read-only dealt source) needs no kernel scratch.
    sh_node node={.K=5120,.N=248320};
    sh_link l={0}; l.nodes=&node; l.n_nodes=1; l.Kmax=node.K; l.Nmax=node.N;
    gen_scratch s;
    begin(1); assert(gen_scratch_init(&l,&s,64)==SH_OK); finish();
    assert(!attempts && !s.planes && !s.acc);
    printf("refill-scratch: %d exact native/provider/mixed cases; allocation failures and provider-error wipes passed (%s)\n",cases,tables[1]->name);
}
