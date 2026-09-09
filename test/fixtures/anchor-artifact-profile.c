#define _GNU_SOURCE
#include "anchor_artifacts.h"
#include "check_hash.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static int checks;
#define CHECK(c) do { checks++; if (!(c)) { fprintf(stderr, "check %d failed at %d\n", checks, __LINE__); exit(1); } } while (0)
static const anchor_hash_ops HASH = {hi,hu,hf};
typedef struct { const uint8_t *data; size_t size, offset; unsigned calls; int delay, fail; } source;
static ssize_t read_source(void *ctx, void *buffer, size_t want) {
    source *s=ctx; s->calls++;
    if (s->fail && s->calls==2) { errno=EAGAIN; return -1; }
    if (s->delay) { struct timespec delay={0,10000000}; while (nanosleep(&delay,&delay)<0 && errno==EINTR) {} }
    size_t n=s->size-s->offset; if (n>want) n=want;
    memcpy(buffer,s->data+s->offset,n); s->offset+=n; return (ssize_t)n;
}
static uint64_t phases(const anchor_artifact_profile *p) {
    return p->read_ns+p->write_ns+p->hash_ns+p->file_sync_ns+p->publish_ns;
}
int main(void) {
    char dir[]="/tmp/anchor-artifact-profile-XXXXXX"; CHECK(mkdtemp(dir)!=NULL);
    int dfd=open(dir,O_RDONLY|O_DIRECTORY|O_CLOEXEC); CHECK(dfd>=0);
    const size_t bytes=2*65536+123;
    uint8_t *data=malloc(bytes),*actual=malloc(bytes); CHECK(data && actual);
    for (size_t i=0;i<bytes;i++) data[i]=(uint8_t)(i*73+19);
    uint8_t digest[32]; check_sha256(data,bytes,digest);
    anchor_encoded_entry entry={0}; entry.bytes=bytes; entry.blocks=1; entry.block_sha256=digest; memcpy(entry.encoded_sha256,digest,32);
    char name[ANCHOR_ARTIFACT_NAME_LEN+1]; anchor_artifact_name(digest,name);
    anchor_artifact_receipt receipt; anchor_artifact_profile profile;
    source s={data,bytes,0,0,0,0};
    CHECK(anchor_artifact_receive(dfd,name,&entry,&HASH,read_source,&s,1000,&receipt)==ANCHOR_ARTIFACT_OK);
    int fd=openat(dfd,name,O_RDONLY); CHECK(fd>=0);
    CHECK(read(fd,actual,bytes)==(ssize_t)bytes && memcmp(data,actual,bytes)==0); close(fd);
    CHECK(unlinkat(dfd,name,0)==0);
    s=(source){data,bytes,0,0,1,0};
    CHECK(anchor_artifact_receive_profiled(dfd,name,&entry,&HASH,read_source,&s,1000,&receipt,&profile)==ANCHOR_ARTIFACT_OK);
    CHECK(receipt.got==bytes && profile.read_bytes==bytes && profile.read_calls==3 && profile.write_batches==3);
    CHECK(profile.clock_errors==0 && profile.read_ns>=30000000 && profile.read_ns<=profile.body_total_ns);
    CHECK(profile.hash_ns>0 && profile.write_ns>0 && phases(&profile)<=profile.body_total_ns);
    fd=openat(dfd,name,O_RDONLY); CHECK(fd>=0);
    CHECK(read(fd,actual,bytes)==(ssize_t)bytes && memcmp(data,actual,bytes)==0); close(fd);
    CHECK(unlinkat(dfd,name,0)==0);
    s=(source){data,bytes,0,0,0,1};
    CHECK(anchor_artifact_receive_profiled(dfd,name,&entry,&HASH,read_source,&s,1000,&receipt,&profile)==ANCHOR_ARTIFACT_E_READ);
    CHECK(receipt.err_no==EAGAIN && receipt.got==65536 && profile.read_calls==2 && profile.write_batches==1);
    CHECK(profile.file_sync_ns==0 && profile.publish_ns==0 && phases(&profile)<=profile.body_total_ns);
    CHECK(anchor_artifact_have(dfd,name,bytes)==0);
    data[0]^=1; s=(source){data,bytes,0,0,0,0};
    CHECK(anchor_artifact_receive_profiled(dfd,name,&entry,&HASH,read_source,&s,1000,&receipt,&profile)==ANCHOR_ARTIFACT_E_BLOCK);
    CHECK(profile.hash_ns>0 && profile.file_sync_ns==0 && anchor_artifact_have(dfd,name,bytes)==0);
    memset(&profile,0xff,sizeof profile);
    CHECK(anchor_artifact_receive_profiled(-1,name,&entry,&HASH,read_source,&s,1000,&receipt,&profile)==ANCHOR_ARTIFACT_E_ARGS);
    anchor_artifact_profile zero={0}; CHECK(memcmp(&profile,&zero,sizeof profile)==0);
    free(actual); free(data); close(dfd); CHECK(rmdir(dir)==0);
    printf("{\"status\":\"PASS\",\"executed_checks\":%d}\n",checks);
    return 0;
}
