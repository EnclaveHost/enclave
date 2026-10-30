#define _GNU_SOURCE
#include "shielded-tee.h"
#include <assert.h>
#include <inttypes.h>
#include <malloc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <time.h>

static double us(void) {
    struct timespec t; assert(!clock_gettime(CLOCK_MONOTONIC,&t));
    return t.tv_sec*1e6+t.tv_nsec/1e3;
}
static long rss(void) {
    FILE *f=fopen("/proc/self/status","r"); assert(f);
    char line[256]; long n=-1;
    while(fgets(line,sizeof line,f))if(sscanf(line,"VmRSS: %ld kB",&n)==1)break;
    fclose(f);assert(n>=0);return n;
}
static long peak(void) {struct rusage r;assert(!getrusage(RUSAGE_SELF,&r));return r.ru_maxrss;}
static size_t allocated(void) {struct mallinfo2 m=mallinfo2();return m.uordblks+m.hblkhd;}
static int cmp(const void *a,const void *b) {double x=*(const double*)a,y=*(const double*)b;return (x>y)-(x<y);}
static void verify(sh_link *l,int count,const int64_t *x,const int64_t *y,int m) {
    for(int i=0;i<count;i++)assert(sh_link_verify(l,i,x,y,m));
}
int main(int argc,char **argv) {
    assert(argc==4);
    const int K=atoi(argv[1]),N=atoi(argv[2]),count=atoi(argv[3]),m=4;
    assert(K>0 && K<=17408 && N>0 && N<=17408 && count>0 && count<=256);
    int8_t *w=malloc((size_t)K*N);
    int64_t *x=malloc((size_t)m*K*sizeof *x),*y=malloc((size_t)m*N*sizeof *y);
    assert(w && x && y);
    for(size_t i=0;i<(size_t)K*N;i++)w[i]=(int8_t)(i%15)-7;
    for(int i=0;i<m*K;i++)x[i]=i%5-2;
    for(int row=0;row<m;row++)for(int j=0;j<N;j++) {
        int64_t sum=0;for(int k=0;k<K;k++)sum+=x[row*K+k]*w[(size_t)j*K+k];
        y[row*N+j]=sum;
    }
    int err=0;sh_link *l=sh_link_open("127.0.0.1",1,true,&err);assert(l && !err);
    (void)rss();const long r0=rss(),p0=peak();const size_t a0=allocated();
    double start=us();
    for(int i=0;i<count;i++) {
        char name[64];snprintf(name,sizeof name,"fixture.%d.weight",i);
        assert(sh_link_add_weight(l,name,w,K,N,m,-1)==i);
    }
    const double admission=us()-start;
    const size_t a1=allocated();const long r1=rss(),p1=peak();
    verify(l,count,x,y,m);
    y[0]++;assert(!sh_link_verify(l,0,x,y,m));y[0]--;
    for(int i=0;i<3;i++)verify(l,count,x,y,m);
    start=us();verify(l,count,x,y,m);const double estimate=us()-start;
    int inner=estimate>0?(int)(2000/estimate)+1:1000;if(inner>1000)inner=1000;
    double times[15];
    for(int i=0;i<15;i++) {
        start=us();for(int j=0;j<inner;j++)verify(l,count,x,y,m);
        times[i]=(us()-start)/inner/count;
    }
    qsort(times,15,sizeof *times,cmp);
    printf("{\"K\":%d,\"N\":%d,\"nodes\":%d,\"rows\":%d,\"dealt\":%s,\"admission_us\":%.3f,"
           "\"retained_allocator_bytes\":%" PRId64 ",\"retained_rss_kib\":%ld,\"admission_peak_delta_kib\":%ld,"
           "\"warm_verify_us_per_node\":%.3f,\"exact_products_verified\":true}\n",
           K,N,count,m,sh_link_is_dealt(l)?"true":"false",admission,(int64_t)a1-(int64_t)a0,r1-r0,p1-p0,times[7]);
    sh_link_close(l);free(w);free(x);free(y);
}
