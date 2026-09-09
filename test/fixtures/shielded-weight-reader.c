#include "../../wasm/ggml-shielded/shielded-wire.c"
#include "../../wasm/ggml-shielded/shielded-tee.c"
#include <assert.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <signal.h>
enum { K=64,N=17003,M=3 };
static int8_t expected[K*N];
typedef struct { int calls,fail,fail_at; } reader_state;   /* fail: every read; fail_at: the N-th read of this run */
static int reader(void *ctx,uint64_t off,uint8_t *out,size_t n) {
    reader_state *s=ctx;s->calls++;assert(off<=sizeof expected && n<=sizeof expected-off);
    if(s->fail || (s->fail_at && s->calls==s->fail_at))return -1;
    memcpy(out,expected+off,n);return 0;
}
static void exact_read(int fd,void *p,size_t n) {
    while(n){ssize_t r=read(fd,p,n);assert(r>0);p=(uint8_t*)p+r;n-=(size_t)r;}
}
static void reply(int fd,uint8_t status,const char *body) {
    uint8_t h[9];h[0]=status;put_u64(h+1,strlen(body));assert(write(fd,h,9)==9);
    if(*body)assert(write(fd,body,strlen(body))==(ssize_t)strlen(body));
}
typedef struct { int listener,uploads,drop_turn; size_t bytes; } worker_state;   /* drop_turn: close after the first SET_TENSOR of that turn */
static void *worker(void *opaque) {
    worker_state *s=opaque;
    for(int turn=0;turn<6;turn++) {
        int fd=accept(s->listener,NULL,NULL);assert(fd>=0);
        for(;;) {
            uint8_t h[9];ssize_t r=read(fd,h,1);if(!r)break;assert(r==1);exact_read(fd,h+1,8);
            size_t n=(size_t)get_u64(h+1);assert(n<(2u<<20));uint8_t *p=malloc(n?n:1);assert(p);exact_read(fd,p,n);
            if(h[0]==SH_CMD_HELLO)reply(fd,0,"{\"version\":[1,2]}");
            else if(h[0]==SH_CMD_ALLOC_BUFFER)reply(fd,0,"");
            else if(h[0]==SH_CMD_SET_TENSOR) {
                uint64_t off=get_u64(p+8),nb=get_u64(p+16);assert(get_u64(p)==1 && nb==n-24 && off+nb<=sizeof expected);
                assert(!memcmp(p+24,expected+off,nb));s->uploads++;s->bytes+=(size_t)nb;reply(fd,0,"");
                if(turn==s->drop_turn){free(p);break;}   /* worker gone mid-upload: the link must join its reader and fail cleanly */
            } else {assert(h[0]==SH_CMD_GRAPH_INSTALL);reply(fd,1,"end of upload fixture");free(p);break;}
            free(p);
        }
        close(fd);
    }
    return NULL;
}
static int start_checked(sh_link *l,int expected_rc) {
    int rc=sh_link_start(l);
    if(rc!=expected_rc)fprintf(stderr,"weight-reader start: got %d expected %d: %s\n",rc,expected_rc,sh_link_last_error(l));
    assert(rc==expected_rc);return rc;
}
int main(void) {
    signal(SIGPIPE,SIG_IGN);setenv("SHIELDED_NO_SIMD","1",1);setenv("SHIELDED_PAD_CHECK","1",1);setenv("SHIELDED_PREP_THREADS","1",1);
    for(size_t i=0;i<sizeof expected;i++)expected[i]=(int8_t)(i%31-15);
    /* A dealt start now binds delivered shipments before upload. This upload-only
     * fixture needs a real empty bank, so it exercises that gate without pads. */
    char bank[]="/tmp/shielded-weight-reader-bank-XXXXXX";assert(mkdtemp(bank));
    int err; sh_link *l=sh_link_open("127.0.0.1",1,true,&err);assert(l && !err);
    snprintf(l->pad_dir,sizeof l->pad_dir,"%s",bank);
    int8_t *original=malloc(sizeof expected);assert(original);memcpy(original,expected,sizeof expected);
    assert(sh_link_add_weight(l,"cached.weight",original,K,N,M,-1)==0);
    reader_state rs={0,0};assert(sh_link_set_weight_reader(l,0,reader,&rs)==SH_ERR_RANGE); // not dealt
    l->dealt=true;l->verify=false;assert(sh_link_set_weight_reader(l,0,reader,&rs)==SH_ERR_RANGE);l->verify=true;
    int32_t *sM=l->nodes[0].sM;l->nodes[0].sM=NULL;assert(sh_link_set_weight_reader(l,0,reader,&rs)==SH_ERR_RANGE);l->nodes[0].sM=sM;
    assert(sh_link_set_weight_reader(l,0,reader,&rs)==SH_OK);free(original);assert(sh_link_weight(l,0)==NULL);
    assert(sh_link_set_weight_reader(l,0,reader,&rs)==SH_ERR_RANGE);
    int node=0;int64_t x[M*K],*out=malloc((size_t)M*N*sizeof *out);assert(out);
    for(int i=0;i<M*K;i++)x[i]=i%7-3;
    assert(sh_link_gemm_local(l,&node,1,x,M,&out)==SH_OK && rs.calls==2);
    for(int row=0;row<M;row++)for(int j=0;j<N;j++){int64_t v=0;for(int k=0;k<K;k++)v+=x[row*K+k]*expected[j*K+k];assert(out[row*N+j]==sh_balanced(v));}
    assert(sh_link_verify(l,0,x,out,M));out[13]++;assert(!sh_link_verify(l,0,x,out,M));
    rs.fail=1;assert(sh_link_gemm_local(l,&node,1,x,M,&out)==SH_ERR_VERIFY);rs.fail=0;
    uint8_t zero[32]={0};assert(sh_link_mint_shipment(l,zero,zero,zero,0,1,zero,"/must-not-create-cached-mint")==SH_ERR_RANGE);
    int listener=socket(AF_INET,SOCK_STREAM,0);assert(listener>=0);struct sockaddr_in a={.sin_family=AF_INET,.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
    assert(bind(listener,(void*)&a,sizeof a)==0 && listen(listener,3)==0);socklen_t al=sizeof a;assert(getsockname(listener,(void*)&a,&al)==0);
    l->port=ntohs(a.sin_port);l->vsock_port=0;
    worker_state ws={listener,0,5,0};pthread_t th;assert(pthread_create(&th,NULL,worker,&ws)==0);
    start_checked(l,SH_ERR_VIOLATION);start_checked(l,SH_ERR_VIOLATION); // same bytes on reconnect
    rs.fail=1;start_checked(l,SH_ERR_VERIFY);rs.fail=0;
    assert(ws.uploads==4 && ws.bytes==2*sizeof expected);   /* default: 1 MiB chunks, serial: 2 per start */
    /* pipelined upload (SHIELDED_UPLOAD_PREFETCH=<MiB>): the next chunk is read + authenticated on a helper
     * thread while the current one is in flight. 1 MiB chunks here so the 1.04 MiB weight takes two. */
    setenv("SHIELDED_UPLOAD_PREFETCH","1",1);
    rs.calls=0;start_checked(l,SH_ERR_VIOLATION);assert(rs.calls==2 && ws.uploads==6 && ws.bytes==3*sizeof expected);   // same bytes, both chunks
    rs.calls=0;rs.fail_at=2;start_checked(l,SH_ERR_VERIFY);rs.fail_at=0;   // the prefetched second chunk fails its read: joined, refused, never sent
    assert(rs.calls==2 && ws.uploads==7 && ws.bytes==3*sizeof expected+(1u<<20));
    rs.calls=0;int rc=sh_link_start(l);   // turn 5: the worker closes after the first chunk; the in-flight prefetch is joined, the error is the pipe's
    assert(rc!=SH_OK && rc!=SH_ERR_VERIFY && rs.calls==2 && ws.uploads==8);
    unsetenv("SHIELDED_UPLOAD_PREFETCH");sh_link_close(l);
    assert(pthread_join(th,NULL)==0);close(listener);assert(rmdir(bank)==0);
    free(out);puts("weight-reader: released source, exact fallback, Freivalds, upload/reconnect, failures, pipelined upload (+read failure, worker gone) passed");
}
