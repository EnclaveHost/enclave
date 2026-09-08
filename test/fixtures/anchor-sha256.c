#define _GNU_SOURCE
#include <assert.h>
#include <fcntl.h>
#include <time.h>
#include "anchor_pins.c"

static void hex(const uint8_t d[32]) { for(int i=0;i<32;i++) printf("%02x",d[i]); }
static double now(void) { struct timespec t; assert(clock_gettime(CLOCK_MONOTONIC,&t)==0); return t.tv_sec+t.tv_nsec/1e9; }
static const char *impl(sha256_ctx *c) {
#ifdef ANCHOR_SHA2_ARM
    if(c->blocks==sha_blocks_arm)return "arm_sha2";
#endif
    return "scalar";
}
int main(int argc,char **argv) {
    const size_t cap=4<<20;
    uint8_t *data=malloc(cap+32); assert(data);
    for(size_t i=0;i<cap+32;i++)data[i]=(uint8_t)(i*131+i/7);
    if(argc==2 && !strcmp(argv[1],"--bench")) {
        for(int run=0;run<4;run++) {
            sha256_ctx c;sha_init(&c);if(run==1||run==2)c.blocks=sha_blocks_scalar;
            const double start=now();
            for(int i=0;i<32;i++)sha_update(&c,data,cap);
            uint8_t out[32];sha_final(&c,out);const double elapsed=now()-start;
            printf("%s %.3f MiB/s %.6f s ",impl(&c),128.0/elapsed,elapsed);hex(out);puts("");
        }
        free(data);return 0;
    }
    sha256_ctx selected;sha_init(&selected);assert(!strcmp(anchor_sha256_backend(),impl(&selected)));
    printf("implementation %s\n",anchor_sha256_backend());
    for(size_t test=0;test<180;test++) {
        const size_t n=test<130?test:((test*7919)%((1<<20)+1)),offset=test%32;
        uint8_t fast[32],scalar[32],fragmented[32];sha256_ctx c;
        anchor_sha256(data+offset,n,fast);
        sha_init(&c);c.blocks=sha_blocks_scalar;sha_update(&c,data+offset,n);sha_final(&c,scalar);
        assert(!memcmp(fast,scalar,32));
        sha_init(&c);
        for(size_t at=0;at<n;) {size_t take=(at*17+1)%137+1;if(take>n-at)take=n-at;sha_update(&c,data+offset+at,take);sha_update(&c,NULL,0);at+=take;}
        sha_final(&c,fragmented);assert(!memcmp(fast,fragmented,32));
        // Public incremental contexts may be unaligned and interleaved.
        uint8_t opaque[sizeof(anchor_sha256_ctx)+2], other[sizeof(anchor_sha256_ctx)];
        memset(opaque,0xa5,sizeof opaque);anchor_sha256_init(opaque+1);anchor_sha256_init(other);
        for(size_t at=0;at<n;) {
            size_t take=(at*19+3)%257+1;if(take>n-at)take=n-at;
            anchor_sha256_update(opaque+1,data+offset+at,take);
            anchor_sha256_update(opaque+1,NULL,0);
            anchor_sha256_update(other,data+offset+at,take);at+=take;
        }
        anchor_sha256_final(opaque+1,fragmented);assert(!memcmp(fast,fragmented,32));
        anchor_sha256_final(other,fragmented);assert(!memcmp(fast,fragmented,32));
        assert(opaque[0]==0xa5 && opaque[sizeof opaque-1]==0xa5);
        for(size_t j=1;j+1<sizeof opaque;j++)assert(opaque[j]==0);
        printf("%zu %zu ",n,offset);hex(fast);puts("");
    }
    if(argc==2) {
        char file[1024];snprintf(file,sizeof file,"%s/anchor-sha-XXXXXX",argv[1]);int fd=mkstemp(file);assert(fd>=0);
        assert(write(fd,data,cap)==(ssize_t)cap);assert(lseek(fd,17,SEEK_SET)==17);
        uint8_t expected[32],got[32];uint64_t bytes;
        anchor_sha256(data,cap,expected);assert(anchor_sha256_fd(fd,got,&bytes)==0 && bytes==cap && !memcmp(got,expected,32));
        assert(lseek(fd,0,SEEK_CUR)==17);
        assert(anchor_sha256_file(file,got,&bytes)==0 && bytes==cap && !memcmp(got,expected,32));
        close(fd);unlink(file);
    }
    free(data);puts("anchor-sha256: ok");
}
