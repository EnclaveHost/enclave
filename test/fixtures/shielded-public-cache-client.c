/* Reuse the authenticated-reader fixture's real C link and test weights. */
#define main reader_base_main
#include "shielded-weight-reader.c"
#undef main

static void raw_reply(int fd,const void *body,size_t n) {
    uint8_t h[9]={0};put_u64(h+1,n);assert(write(fd,h,9)==9);
    if(n)assert(write(fd,body,n)==(ssize_t)n);
}
typedef struct { int fd,turn,lookups,admits,uploads; } peer;
static void *cache_peer(void *opaque) {
    peer *s=opaque;int fd=accept(s->fd,NULL,NULL);assert(fd>=0);
    for(;;) {
        uint8_t h[9];ssize_t rr=read(fd,h,1);if(!rr)break;assert(rr==1);exact_read(fd,h+1,8);
        size_t n=(size_t)get_u64(h+1);assert(n<(2u<<20));uint8_t *p=malloc(n?n:1);assert(p);exact_read(fd,p,n);
        if(h[0]==SH_CMD_HELLO) {
            const char *body="{\"version\":[1,4],\"public_weight_cache_bytes\":2097152}";
            if(s->turn==1)body="{\"version\":[1,3],\"public_weight_cache_bytes\":2097152}";
            if(s->turn==2)body="{\"version\":[1,4]}";
            if(s->turn==3)body="{\"version\":[1,4],\"public_weight_cache_bytes\":2097152garbage}";
            if(s->turn==4)body="{\"version\":[1,4],\"public_weight_cache_bytes\":1}";
            reply(fd,0,body);
        } else if(h[0]==SH_CMD_ALLOC_BUFFER)reply(fd,0,"");
        else if(h[0]==SH_CMD_PUBLIC_WEIGHT_CACHE) {
            assert(n==57 && get_u64(p+1)==1 && get_u64(p+9)==0 && get_u64(p+17)==sizeof expected);
            uint8_t d[32];sha256_ctx hash;sha_init(&hash);sha_update(&hash,(uint8_t*)expected,sizeof expected);sha_final(&hash,d);
            assert(!memcmp(d,p+25,32));uint8_t answer=0;
            if(p[0]==0) {
                s->lookups++;if(s->turn==6)answer=1;
                if(s->turn==7)answer=2;
                if(s->turn==8){raw_reply(fd,NULL,0);free(p);continue;}
            } else {assert(p[0]==1);s->admits++;answer=s->turn==10 ? 2 : s->turn==11 ? 0 : 1;}
            raw_reply(fd,&answer,1);
        } else if(h[0]==SH_CMD_SET_TENSOR) {
            uint64_t off=get_u64(p+8),nb=get_u64(p+16);
            assert(get_u64(p)==1 && nb==n-24 && off+nb<=sizeof expected && !memcmp(p+24,expected+off,nb));
            s->uploads++;reply(fd,0,"");
        } else {assert(h[0]==SH_CMD_GRAPH_INSTALL);reply(fd,1,"end of public cache fixture");free(p);break;}
        free(p);
    }
    close(fd);return NULL;
}
int main(int argc,char **argv) {
    signal(SIGPIPE,SIG_IGN);setenv("SHIELDED_NO_SIMD","1",1);setenv("SHIELDED_PAD_CHECK","1",1);
    setenv("SHIELDED_PUBLIC_WEIGHT_CACHE","1",1);
    char bank[]="/tmp/shielded-public-cache-bank-XXXXXX";assert(mkdtemp(bank));
    for(size_t i=0;i<sizeof expected;i++)expected[i]=(int8_t)(i%31-15);
    int err;sh_link *l=sh_link_open("127.0.0.1",1,true,&err);assert(l && !err);
    snprintf(l->pad_dir,sizeof l->pad_dir,"%s",bank);
    int8_t *original=malloc(sizeof expected);assert(original);memcpy(original,expected,sizeof expected);
    assert(sh_link_add_weight(l,"cached.weight",original,K,N,M,-1)==0 && l->nodes[0].public_digest_ready);
    l->dealt=true;reader_state rs={0};assert(sh_link_set_weight_reader(l,0,reader,&rs)==SH_OK);free(original);
    l->vsock_port=0;
    if(argc==2) {
        l->port=atoi(argv[1]);
        assert(sh_link_start(l)==SH_ERR_VIOLATION && rs.calls==2);
        rs.calls=0;rs.fail=1;assert(sh_link_start(l)==SH_ERR_VIOLATION && rs.calls==0);
        sh_link_close(l);assert(rmdir(bank)==0);puts("public-cache-client: actual CPU worker cold/warm negotiation PASS");return 0;
    }
    const char *bad[]={"{}","{\"public_weight_cache_bytes\":-1}","{\"public_weight_cache_bytes\":1.5}",
        "{\"public_weight_cache_bytes\":18446744073709551616}","{\"public_weight_cache_bytes\":\"1\"}"};
    for(size_t i=0;i<sizeof bad/sizeof *bad;i++)assert(hello_public_cache_bytes(bad[i])==0);
    assert(hello_public_cache_bytes("{ \"public_weight_cache_bytes\" : 2097152 }")==2097152);
    int listener=socket(AF_INET,SOCK_STREAM,0);assert(listener>=0);
    struct sockaddr_in a={.sin_family=AF_INET,.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
    assert(bind(listener,(void*)&a,sizeof a)==0 && listen(listener,3)==0);socklen_t al=sizeof a;
    assert(getsockname(listener,(void*)&a,&al)==0);l->port=ntohs(a.sin_port);
    for(int turn=0;turn<12;turn++) {
        if(!turn)unsetenv("SHIELDED_PUBLIC_WEIGHT_CACHE");else setenv("SHIELDED_PUBLIC_WEIGHT_CACHE","1",1);
        rs.calls=0;rs.fail=turn==6 || turn==9;
        peer s={listener,turn,0,0,0};pthread_t th;assert(pthread_create(&th,NULL,cache_peer,&s)==0);
        int rc=sh_link_start(l);sh_pipe_close(l->pipe);l->pipe=NULL;assert(pthread_join(th,NULL)==0);
        const int want=(turn==7 || turn==8 || turn==10) ? SH_ERR_PROTO : turn==9 ? SH_ERR_VERIFY : SH_ERR_VIOLATION;
        assert(rc==want);
        assert(s.lookups==(turn>=5));
        assert(s.admits==(turn==5 || turn==10 || turn==11));
        assert(s.uploads==((turn<=5 || turn==10 || turn==11)?2:0));
        if(turn==6 || turn==7 || turn==8)assert(rs.calls==0);
    }
    close(listener);sh_link_close(l);
    assert(rmdir(bank)==0);
    puts("public-cache-client: legacy/default fallback, authenticated hash, hits/misses, no warm reads and malformed reply refusal PASS");
}
