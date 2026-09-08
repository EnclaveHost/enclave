#include "../../wasm/ggml-shielded/shielded-simd.h"
#include "../../wasm/ggml-shielded/shielded-field.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static int deny_allocations, aligned_attempts, malloc_attempts;
void *__real_malloc(size_t);
void *__real_aligned_alloc(size_t,size_t);
void *__wrap_malloc(size_t n) {
    if(deny_allocations){++malloc_attempts;return NULL;}
    return __real_malloc(n);
}
void *__wrap_aligned_alloc(size_t alignment,size_t n) {
    if(deny_allocations){++aligned_attempts;return NULL;}
    return __real_aligned_alloc(alignment,n);
}
static uint32_t state=721;
static uint32_t next(void){return state=state*1664525u+1013904223u;}
static void check(int K,int N,int b) {
    const int stride=N+3;
    int8_t *w=malloc((size_t)K*N);
    int32_t *r=malloc((size_t)b*K*sizeof*r);
    uint8_t *planes=malloc((size_t)3*b*K);
    int32_t *u=malloc((size_t)b*stride*sizeof*u);
    int32_t *acc=malloc((size_t)12*N*sizeof*acc);
    assert(w&&r&&planes&&u&&acc);
    for(size_t i=0;i<(size_t)K*N;++i)w[i]=(int)(next()%239)-119;
    for(size_t i=0;i<(size_t)b*K;++i)r[i]=(int64_t)(next()%SH_M_MOD)-SH_HALF_M;
    sh_simd_avx512_pad_planes(r,(size_t)b*K,planes,planes+(size_t)b*K,planes+(size_t)2*b*K);
    for(int mode=0;mode<2;++mode) {
        for(int i=0;i<b*stride;++i)u[i]=INT32_MIN;
        aligned_attempts=malloc_attempts=0;deny_allocations=mode;
        sh_simd_avx512_refill(planes,b,w,K,N,u,stride,acc);
        deny_allocations=0;
        for(int row=0;row<b;++row) {
            for(int j=0;j<N;++j) {
                int64_t exact=0;
                for(int k=0;k<K;++k)exact+=(int64_t)r[(size_t)row*K+k]*w[(size_t)j*K+k];
                assert(u[row*stride+j]==sh_balanced(exact));
            }
            for(int j=N;j<stride;++j)assert(u[row*stride+j]==INT32_MIN);
        }
        if(mode){assert(aligned_attempts==1);assert(malloc_attempts==0);}
    }
    free(w);free(r);free(planes);free(u);free(acc);
}
int main(void) {
    __builtin_cpu_init();
    if(!__builtin_cpu_supports("avx512vnni")||!__builtin_cpu_supports("avx512bw")||
       !__builtin_cpu_supports("avx512dq")||!__builtin_cpu_supports("avx512vl"))return 77;
    const int sizes[]={63,64,65,2048,5120,17408},widths[]={1,17,35},batches[]={5,8,9,16,33};
    unsigned cases=0;
    for(unsigned k=0;k<sizeof sizes/sizeof*sizes;++k)
        for(unsigned n=0;n<sizeof widths/sizeof*widths;++n)
            for(unsigned b=0;b<sizeof batches/sizeof*batches;++b){check(sizes[k],widths[n],batches[b]);++cases;}
    printf("refill-oom: %u normal and forced-OOM shape pairs PASS\n",cases);
}
