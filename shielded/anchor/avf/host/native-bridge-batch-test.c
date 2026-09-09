#define _GNU_SOURCE
#include "native-bridge.c"
#include <assert.h>
#include <pthread.h>
#include <signal.h>

typedef struct {int a,b,c,idle;size_t cap,limit,batch;anchor_bridge_stats stats;int rc;} run_args;
static void *bridge(void *v) {run_args *r=v;r->rc=anchor_bridge_run_profile_trace_batch(r->a,r->b,r->c,r->idle,r->cap,&r->stats,0,r->limit,-1,r->batch);return NULL;}
static void write_exact(int fd,const uint8_t *p,size_t n) {while(n){ssize_t z=send(fd,p,n,MSG_NOSIGNAL);if(z<0&&errno==EINTR)continue;assert(z>0);p+=z;n-=(size_t)z;}}
static void read_exact(int fd,uint8_t *p,size_t n) {while(n){ssize_t z=read(fd,p,n);if(z<0&&errno==EINTR)continue;assert(z>0);p+=z;n-=(size_t)z;}}
static void header(uint8_t *p,uint64_t n) {p[0]=0;for(unsigned i=0;i<8;i++)p[1+i]=(uint8_t)(n>>(8*i));}
typedef struct {int fd;uint8_t *data;size_t bytes;} writer_args;
static void *worker(void *v) {writer_args *w=v;uint8_t request[257];read_exact(w->fd,request,sizeof request);for(unsigned i=0;i<sizeof request;i++)assert(request[i]==(uint8_t)i);
    const size_t fragments[]={1,7,1448,8192,32768,65536};size_t p=0,k=0;
    while(p<w->bytes){size_t n=fragments[k++%6];if(n>w->bytes-p)n=w->bytes-p;write_exact(w->fd,w->data+p,n);p+=n;}
    assert(!shutdown(w->fd,SHUT_WR));return NULL;
}
static void full_stream(size_t cap,size_t limit,size_t batch,int truncation) {
    const size_t sizes[]={0,1,15,65520,65536,65537,1048609};size_t n=0;
    for(unsigned i=0;i<sizeof sizes/sizeof *sizes;i++)n+=9+sizes[i];
    n+=truncation==1?5:truncation==2?46:0;
    uint8_t *expected=malloc(n),*actual=malloc(n);assert(expected&&actual);size_t p=0;
    for(unsigned i=0;i<sizeof sizes/sizeof *sizes;i++){header(expected+p,sizes[i]);p+=9;for(size_t j=0;j<sizes[i];j++)expected[p++]=(uint8_t)(j*19+i);}
    if(truncation==1){memset(expected+p,0x13,5);p+=5;}
    if(truncation==2){header(expected+p,100);p+=9;memset(expected+p,0x55,37);p+=37;}
    assert(p==n);int a[2],b[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,a));assert(!socketpair(AF_UNIX,SOCK_STREAM,0,b));
    int small=8192;assert(!setsockopt(a[0],SOL_SOCKET,SO_SNDBUF,&small,sizeof small));
    int fa=fcntl(a[0],F_GETFL),fb=fcntl(b[0],F_GETFL);run_args r={.a=a[0],.b=b[0],.c=-1,.idle=2000,.cap=cap,.limit=limit,.batch=batch};
    pthread_t bt,wt;writer_args w={b[1],expected,n};assert(!pthread_create(&bt,NULL,bridge,&r));assert(!pthread_create(&wt,NULL,worker,&w));
    uint8_t request[257];for(unsigned i=0;i<sizeof request;i++)request[i]=(uint8_t)i;write_exact(a[1],request,sizeof request);assert(!shutdown(a[1],SHUT_WR));
    p=0;while(p<n){size_t want=n-p<997?n-p:997;ssize_t z=read(a[1],actual+p,want);assert(z>0);p+=(size_t)z;}
    uint8_t extra;assert(read(a[1],&extra,1)==0);assert(!memcmp(expected,actual,n));
    assert(!pthread_join(wt,NULL));assert(!pthread_join(bt,NULL));assert(r.rc==0 && r.stats.a_to_b==257 && r.stats.b_to_a==n);
    assert(fcntl(a[0],F_GETFL)==fa && fcntl(b[0],F_GETFL)==fb);
    for(int i=0;i<2;i++){close(a[i]);close(b[i]);}free(expected);free(actual);
}
static void blocked(int cancel,int partial_header) {
    int a[2],b[2],c[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,a));assert(!socketpair(AF_UNIX,SOCK_STREAM,0,b));assert(!pipe(c));
    run_args r={.a=a[0],.b=b[0],.c=c[0],.idle=100,.cap=4096,.batch=65536};pthread_t bt;assert(!pthread_create(&bt,NULL,bridge,&r));
    uint8_t h[9];header(h,1000);write_exact(b[1],h,partial_header?5:9);
    struct timespec wait={0,20000000};nanosleep(&wait,NULL);
    uint8_t ch;assert(recv(a[1],&ch,1,MSG_DONTWAIT)<0 && (errno==EAGAIN||errno==EWOULDBLOCK));
    if(cancel)assert(write(c[1],"x",1)==1);
    assert(!pthread_join(bt,NULL));assert(r.rc==(cancel?-ECANCELED:-ETIMEDOUT));assert(r.stats.b_to_a==0 && r.stats.polls<50);
    for(int i=0;i<2;i++){close(a[i]);close(b[i]);close(c[i]);}
}
static void batch_and_tail(void) {
    int a[2],b[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,a));assert(!socketpair(AF_UNIX,SOCK_STREAM,0,b));
    struct timeval timeout={1,0};assert(!setsockopt(a[1],SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof timeout));
    run_args r={.a=a[0],.b=b[0],.c=-1,.idle=2000,.batch=65536};pthread_t bt;assert(!pthread_create(&bt,NULL,bridge,&r));
    uint8_t *data=malloc(100009),*out=malloc(100009);assert(data&&out);header(data,100000);for(size_t i=9;i<100009;i++)data[i]=(uint8_t)i;
    write_exact(b[1],data,10000);struct timespec pause={0,20000000};nanosleep(&pause,NULL);
    uint8_t ch;assert(recv(a[1],&ch,1,MSG_DONTWAIT)<0 && (errno==EAGAIN||errno==EWOULDBLOCK));
    write_exact(b[1],data+10000,65536-10000);read_exact(a[1],out,65536);assert(!memcmp(data,out,65536));
    write_exact(b[1],data+65536,100009-65536);read_exact(a[1],out+65536,100009-65536);assert(!memcmp(data,out,100009));
    /* A subsequent tiny frame must also flush while the sender remains open. */
    uint8_t tiny[10];header(tiny,1);tiny[9]=0xab;write_exact(b[1],tiny,sizeof tiny);read_exact(a[1],out,sizeof tiny);assert(!memcmp(tiny,out,sizeof tiny));
    assert(!shutdown(a[1],SHUT_WR));assert(!shutdown(b[1],SHUT_WR));assert(!pthread_join(bt,NULL));assert(r.rc==0 && r.stats.b_to_a==100019);
    for(int i=0;i<2;i++){close(a[i]);close(b[i]);}free(data);free(out);
}
static void oversized(void) {
    int a[2],b[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,a));assert(!socketpair(AF_UNIX,SOCK_STREAM,0,b));
    uint8_t h[9];header(h,UINT64_MAX);write_exact(b[1],h,9);
    run_args r={.a=a[0],.b=b[0],.c=-1,.idle=100,.cap=4096,.batch=65536};bridge(&r);assert(r.rc==-EMSGSIZE && r.stats.b_to_a==0);
    r.batch=123;bridge(&r);assert(r.rc==-EINVAL);
    for(int i=0;i<2;i++){close(a[i]);close(b[i]);}
}
int main(void) {signal(SIGPIPE,SIG_IGN);full_stream(4096,0,65536,0);full_stream(0,0,65536,0);full_stream(0,4096,65536,1);full_stream(0,0,65536,2);full_stream(0,0,0,0);blocked(1,0);blocked(1,1);blocked(0,0);batch_and_tail();oversized();puts("framed reply batching: PASS");}
