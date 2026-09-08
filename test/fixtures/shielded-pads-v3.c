#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int fault_write, short_writes, fault_sync, fault_close, fault_link, fault_unlink;
static int sync_calls, write_calls;
static int fault_alloc, alloc_calls;
static int allocation_fails(void) {
    int call = __atomic_add_fetch(&alloc_calls, 1, __ATOMIC_RELAXED);
    return fault_alloc && call == fault_alloc;
}
static void *test_malloc(size_t n) { return allocation_fails() ? NULL : malloc(n); }
static void *test_calloc(size_t n, size_t size) { return allocation_fails() ? NULL : calloc(n, size); }
static ssize_t test_pwrite(int fd, const void *p, size_t n, off_t off) {
    const int call = __atomic_add_fetch(&write_calls, 1, __ATOMIC_RELAXED);
    if (fault_write && call == fault_write) { errno = EIO; return -1; }
    if (short_writes && call % 3 == 1) { errno = EINTR; return -1; }
    if (short_writes && n > 7) n = 7;
    return pwrite(fd, p, n, off);
}
static int test_fsync(int fd) {
    if (fault_sync && ++sync_calls == fault_sync) { errno = EIO; return -1; }
    return fsync(fd);
}
static int test_close(int fd) {
    const int rc = close(fd);
    if (fault_close) { fault_close = 0; errno = EIO; return -1; }
    return rc;
}
static int test_linkat(int a, const char *b, int c, const char *d, int flags) {
    if (fault_link) { errno = EIO; return -1; }
    return linkat(a, b, c, d, flags);
}
static int test_unlinkat(int fd, const char *name, int flags) {
    if (fault_unlink) { fault_unlink = 0; errno = EIO; return -1; }
    return unlinkat(fd, name, flags);
}
#define pwrite test_pwrite
#define fsync test_fsync
#define close test_close
#define linkat test_linkat
#define unlinkat test_unlinkat
#define malloc test_malloc
#define calloc test_calloc
#include "../../wasm/ggml-shielded/shielded-pads.c"
#undef malloc
#undef calloc
#undef pwrite
#undef fsync
#undef close
#undef linkat
#undef unlinkat

static uint8_t seed[32] = {7}, pk[32], sk[32];
static sh_pads_manifest_group groups[3] = {
    {{0,32,5,"a"},0,2}, {{1,64,4,"c"},2,1}, {{2,32,2,"d"},3,1}
};
static sh_pads_member members[4] = {{"a",3},{"b",2},{"c",4},{"d",2}};
static sh_pads_manifest manifest = {{1},{2},{3},groups,members,3,4};
static sh_pads_span spans[3] = {{7,3},{8,2},{0,0}};
static sh_pads_v3_policy policy = {&manifest,{4},7,12,1<<20,1<<16};

static void values(uint32_t group, uint64_t index, int32_t *u) {
    int32_t r[64];
    sh_pad_r(seed, group, index, groups[group].identity.K, r);
    for (uint64_t j = 0; j < groups[group].identity.u_len; j++) {
        int64_t sum = 0;
        for (uint32_t k = 0; k < groups[group].identity.K; k++)
            sum += (int64_t)r[k] * ((int)((group+j*5+k*3)%15)-7);
        u[j] = (int32_t)sh_balanced(sum);
    }
}
static sh_pads_v3_writer *open_writer(int dir, const char *name) {
    int err = 123;
    sh_pads_v3_writer *w = sh_pads_v3_writer_open(dir,name,&policy,spans,pk,&err);
    assert(w && err == SH_OK);
    assert(sh_pads_v3_writer_scratch_bytes(w) == 31);
    return w;
}
static void fill(sh_pads_v3_writer *w) {
    /* Reverse delivery order and independent, overlapping group ranges. */
    for (int g = 2; g >= 0; g--) for (uint64_t n = spans[g].count; n; n--) {
        uint64_t index = spans[g].index0+n-1;
        int32_t u[5]; values((uint32_t)g,index,u);
        assert(sh_pads_v3_writer_cell(w,(uint32_t)g,index,u,groups[g].identity.u_len) == SH_OK);
    }
}
static int open_file(int dir, const char *name) {
    int fd = openat(dir,name,O_RDWR|O_CLOEXEC); assert(fd >= 0); return fd;
}
static sh_pads_v3_reader *open_reader(int fd) {
    int err = 123;
    sh_pads_v3_reader *r=sh_pads_v3_reader_open(fd,&policy,sk,&err);
    assert(r && err == SH_OK); return r;
}
static void check_cells(sh_pads_v3_reader *r, sh_pads_reader *baseline) {
    for (uint32_t g=0;g<3;g++) {
        sh_pads_span got; assert(sh_pads_v3_reader_span(r,g,&got) == SH_OK);
        assert(got.index0==spans[g].index0 && got.count==spans[g].count);
        for (uint64_t i=spans[g].index0;i<spans[g].index0+spans[g].count;i++) {
            int32_t u[5],want[5],old[5]; values(g,i,want);
            assert(sh_pads_v3_reader_cell(r,g,i,u,groups[g].identity.u_len)==SH_OK);
            assert(!memcmp(u,want,groups[g].identity.u_len*sizeof(int32_t)));
            if (baseline) {
                assert(sh_pads_reader_cell(baseline,g,i,old)==SH_OK);
                assert(!memcmp(u,old,groups[g].identity.u_len*sizeof(int32_t)));
            }
        }
    }
    int32_t sentinel[5]={123,123,123,123,123};
    assert(sh_pads_v3_reader_cell(r,0,6,sentinel,5)!=SH_OK);
    assert(sh_pads_v3_reader_cell(r,2,8,sentinel,2)!=SH_OK);
    assert(sh_pads_v3_reader_cell(r,0,7,sentinel,4)!=SH_OK);
    for(int i=0;i<5;i++) assert(sentinel[i]==123);
}

typedef struct {sh_pads_v3_writer *w; uint32_t group; uint64_t index; int rc;} write_job;
static void *write_one(void *opaque) {
    write_job *j=opaque; int32_t u[5]; values(j->group,j->index,u);
    uint8_t plain[31],box[31];
    j->rc=sh_pads_v3_writer_cell_with(j->w,j->group,j->index,u,groups[j->group].identity.u_len,plain,box,sizeof box);
    return NULL;
}
static void *read_all(void *opaque) { check_cells(opaque,NULL); return NULL; }

static void metadata_faults(int fd, const uint8_t *original, size_t bytes) {
    for(size_t i=0;i<bytes;i++) {
        uint8_t changed=original[i]^1; assert(pwrite(fd,&changed,1,(off_t)i)==1);
        int err; sh_pads_v3_reader *r=sh_pads_v3_reader_open(fd,&policy,sk,&err);
        assert(!r && err!=SH_OK);
        assert(pwrite(fd,original+i,1,(off_t)i)==1);
    }
}

static void allocation_faults(int dir, int fd) {
    int err, writer_done=0, reader_done=0, cell_done=0;
    /* Fail each allocation, including private helper allocations, then reach
     * one successful call beyond the last allocation. Sanitizers check cleanup. */
    for (int point=1;point<128;point++) {
        alloc_calls=0; fault_alloc=point;
        sh_pads_v3_writer *w=sh_pads_v3_writer_open(dir,"oom-writer",&policy,spans,pk,&err);
        fault_alloc=0;
        if (w) { assert(alloc_calls<point); sh_pads_v3_writer_abort(w); writer_done=1; break; }
        assert(err==SH_ERR_NOMEM);
        assert(faccessat(dir,"oom-writer",F_OK,0)!=0);
    }
    for (int point=1;point<128;point++) {
        alloc_calls=0; fault_alloc=point;
        sh_pads_v3_reader *r=sh_pads_v3_reader_open(fd,&policy,sk,&err);
        fault_alloc=0;
        if (r) { assert(alloc_calls<point); sh_pads_v3_reader_close(r); reader_done=1; break; }
        assert(err==SH_ERR_NOMEM);
    }
    sh_pads_v3_reader *r=open_reader(fd);
    for (int point=1;point<128;point++) {
        int32_t u[5]={123,123,123,123,123};
        alloc_calls=0; fault_alloc=point;
        int rc=sh_pads_v3_reader_cell(r,0,7,u,5);
        fault_alloc=0;
        if (rc==SH_OK) { assert(alloc_calls<point); cell_done=1; break; }
        assert(rc==SH_ERR_NOMEM);
        for (int j=0;j<5;j++) assert(u[j]==123);
    }
    sh_pads_v3_reader_close(r);
    assert(writer_done && reader_done && cell_done);
}

int main(int argc,char **argv) {
    assert(argc==2); int dir=open(argv[1],O_RDONLY|O_DIRECTORY|O_CLOEXEC); assert(dir>=0);
    assert(crypto_box_keypair(pk,sk)==0);
    assert(sh_pads_manifest_validate(&manifest)==SH_OK);
    bool published=true;
    sh_pads_v3_writer *w=open_writer(dir,"complete.pads3");
    assert(faccessat(dir,"complete.pads3",F_OK,0)!=0);
    short_writes=1; write_calls=0; fill(w); short_writes=0;
    uint8_t key[32]; memcpy(key,w->f.key,32);
    assert(sh_pads_v3_writer_finish(w,&published)==SH_OK && published);
    int fd=open_file(dir,"complete.pads3");
    struct stat st; assert(!fstat(fd,&st) && st.st_size==4245);
    allocation_faults(dir,fd);
    sh_pads_v3_reader *r=open_reader(fd);
    /* v2 rectangular baseline, independently opened and unboxed. */
    char base_dir[1024],base_path[1100];
    snprintf(base_dir,sizeof base_dir,"%s/baseline",argv[1]); assert(!mkdir(base_dir,0700));
    snprintf(base_path,sizeof base_path,"%s/rect.pads",base_dir);
    sh_pads_group rectangular[3]; for(int g=0;g<3;g++) rectangular[g]=groups[g].identity;
    int err;
    sh_pads_writer *old=sh_pads_writer_open(base_path,manifest.calib_digest,policy.seed_id,rectangular,3,7,4,pk,&err);
    assert(old && err==SH_OK);
    for(uint32_t g=0;g<3;g++) for(uint64_t i=7;i<11;i++) {int32_t u[5];values(g,i,u);assert(sh_pads_writer_cell(old,i,g,u)==SH_OK);}
    assert(sh_pads_writer_close(old)==SH_OK);
    sh_pads_reader *baseline=sh_pads_reader_open(base_dir,policy.seed_id,sk,&err);assert(baseline);
    assert(sh_pads_reader_bind(baseline,rectangular,3)==SH_OK);
    check_cells(r,baseline); sh_pads_reader_close(baseline);
    pthread_t threads[2]; for(int i=0;i<2;i++) assert(!pthread_create(&threads[i],NULL,read_all,r));
    for(int i=0;i<2;i++) pthread_join(threads[i],NULL);
    sh_pads_v3_reader_close(r);
    uint64_t lo=111,count=222;
    assert(sh_pads_shipment_check_fd(fd,policy.seed_id,sk,NULL,&lo,&count)!=SH_OK);
    int v2fd=open(base_path,O_RDONLY); assert(v2fd>=0);
    assert(!sh_pads_v3_reader_open(v2fd,&policy,sk,&err)); close(v2fd);
    /* Every header, descriptor and alignment-padding byte is authenticated or
     * canonical. Tampering never opens a reader. */
    uint8_t meta[4096]; assert(pread(fd,meta,sizeof meta,0)==sizeof meta);
    metadata_faults(fd,meta,sizeof meta);
    uint8_t wrong_sk[32]={19}; assert(!sh_pads_v3_reader_open(fd,&policy,wrong_sk,&err));
    policy.seed_id[0]^=1; assert(!sh_pads_v3_reader_open(fd,&policy,sk,&err)); policy.seed_id[0]^=1;
    for(int k=0;k<3;k++) {
        uint8_t *digest=k==0?manifest.model_digest:k==1?manifest.calib_digest:manifest.encoding_digest;
        digest[0]^=1;assert(!sh_pads_v3_reader_open(fd,&policy,sk,&err));digest[0]^=1;
    }
    policy.reserved_lo=8;assert(!sh_pads_v3_reader_open(fd,&policy,sk,&err));policy.reserved_lo=7;
    policy.max_cell_bytes=30;assert(!sh_pads_v3_reader_open(fd,&policy,sk,&err));policy.max_cell_bytes=1<<16;
    /* Cell corruption and a correctly tagged but non-field plaintext both
     * preserve all output elements. */
    r=open_reader(fd); uint8_t original[31];assert(pread(fd,original,31,4096)==31);
    int32_t untouched[5];for(int j=0;j<5;j++)untouched[j]=123;
    for(size_t i=0;i<sizeof original;i++) {
        uint8_t changed=original[i]^1;assert(pwrite(fd,&changed,1,4096+i)==1);
        assert(sh_pads_v3_reader_cell(r,0,7,untouched,5)==SH_ERR_VERIFY);
        for(int j=0;j<5;j++)assert(untouched[j]==123);
        assert(pwrite(fd,original+i,1,4096+i)==1);
    }
    uint8_t bad_plain[15]={0},bad_box[31],nonce[12];
    sh_pads_table_put(bad_plain,SH_M_MOD,3);cell_nonce(nonce,7,0);
    assert(aead_seal(key,nonce,bad_plain,sizeof bad_plain,bad_box)==SH_OK);
    assert(pwrite(fd,bad_box,sizeof bad_box,4096)==sizeof bad_box);
    assert(sh_pads_v3_reader_cell(r,0,7,untouched,5)==SH_ERR_VERIFY);
    for(int j=0;j<5;j++)assert(untouched[j]==123);
    assert(pwrite(fd,original,31,4096)==31);
    assert(!ftruncate(fd,4244));assert(sh_pads_v3_reader_cell(r,0,7,untouched,5)!=SH_OK);assert(!ftruncate(fd,4245));
    sh_pads_v3_reader_close(r);
    /* Restoring a truncated last byte restores the real complete file. */
    int32_t last_values[5]; values(1,9,last_values);
    uint8_t last_plain[12],last_box[28];
    for(int j=0;j<4;j++) sh_pads_table_put(last_plain+3*j,(uint64_t)((int64_t)last_values[j]+SH_HALF_M),3);
    cell_nonce(nonce,9,1);assert(aead_seal(key,nonce,last_plain,12,last_box)==SH_OK);assert(pwrite(fd,last_box,28,4217)==28);
    assert(!ftruncate(fd,4246));assert(!sh_pads_v3_reader_open(fd,&policy,sk,&err));assert(!ftruncate(fd,4245));
    r=open_reader(fd);close(fd);
    assert(!renameat(dir,"complete.pads3",dir,"retained.pads3"));
    int replacement=openat(dir,"complete.pads3",O_CREAT|O_EXCL|O_WRONLY,0600);assert(replacement>=0);assert(write(replacement,"bad",3)==3);close(replacement);
    check_cells(r,NULL);sh_pads_v3_reader_close(r);
    /* Incomplete/duplicate/invalid-cell files never publish. */
    w=open_writer(dir,"incomplete");assert(sh_pads_v3_writer_finish(w,&published)!=SH_OK && !published);assert(faccessat(dir,"incomplete",F_OK,0)!=0);
    w=open_writer(dir,"duplicate");write_job jobs[2]={{w,0,7,0},{w,0,7,0}};
    for(int i=0;i<2;i++)assert(!pthread_create(&threads[i],NULL,write_one,&jobs[i]));
    for(int i=0;i<2;i++)pthread_join(threads[i],NULL);
    assert((jobs[0].rc==SH_OK)!=(jobs[1].rc==SH_OK));assert(sh_pads_v3_writer_finish(w,&published)!=SH_OK && !published);
    w=open_writer(dir,"parallel");
    write_job distinct[5]={{w,0,7,0},{w,0,8,0},{w,0,9,0},{w,1,8,0},{w,1,9,0}};
    pthread_t parallel[5];
    for(int i=0;i<5;i++)assert(!pthread_create(&parallel[i],NULL,write_one,&distinct[i]));
    for(int i=0;i<5;i++){pthread_join(parallel[i],NULL);assert(distinct[i].rc==SH_OK);}
    assert(sh_pads_v3_writer_finish(w,&published)==SH_OK&&published);
    int parallel_fd=open_file(dir,"parallel");r=open_reader(parallel_fd);close(parallel_fd);check_cells(r,NULL);sh_pads_v3_reader_close(r);
    w=open_writer(dir,"invalid-cell");int32_t invalid[5]={0,0,0,0,INT32_MAX};
    assert(sh_pads_v3_writer_cell(w,0,7,invalid,5)==SH_ERR_RANGE);
    assert(sh_pads_v3_writer_finish(w,&published)!=SH_OK&&!published);
    /* Every publication failure distinguishes whether the final name exists. */
    for(int kind=0;kind<6;kind++) {
        char name[32];snprintf(name,sizeof name,"fault-%d",kind);w=open_writer(dir,name);fill(w);
        sync_calls=0;fault_sync=kind==0?1:kind==1?2:0;fault_close=kind==2;fault_link=kind==3;fault_unlink=kind==4;
        if(kind==5){int oldfd=openat(dir,name,O_CREAT|O_EXCL|O_WRONLY,0600);assert(oldfd>=0);assert(write(oldfd,"keep",4)==4);close(oldfd);}
        assert(sh_pads_v3_writer_finish(w,&published)!=SH_OK);
        assert(published==(kind==1||kind==4));fault_sync=fault_close=fault_link=fault_unlink=0;
        assert((faccessat(dir,name,F_OK,0)==0)==(published||kind==5));
        if(kind==5){char kept[4];int oldfd=open_file(dir,name);assert(read(oldfd,kept,4)==4&&!memcmp(kept,"keep",4));close(oldfd);}
    }
    w=open_writer(dir,"write-failed");write_calls=0;fault_write=1;int32_t u[5];values(0,7,u);
    assert(sh_pads_v3_writer_cell(w,0,7,u,5)==SH_ERR_IO);fault_write=0;assert(sh_pads_v3_writer_finish(w,&published)!=SH_OK&&!published);
    uint8_t zero_pk[32]={0};assert(!sh_pads_v3_writer_open(dir,"low-order",&policy,spans,zero_pk,&err));
    assert(!sh_pads_v3_writer_open(dir,"../escape",&policy,spans,pk,&err));
    sh_pads_span empty[3]={{0,0},{0,0},{0,0}};
    assert(!sh_pads_v3_writer_open(dir,"empty",&policy,empty,pk,&err) && err==SH_ERR_RANGE);
    assert(!sh_pads_v3_writer_open(dir,"complete.pads3",&policy,spans,pk,&err));
    assert(!symlinkat("retained.pads3",dir,"symlink"));assert(!sh_pads_v3_writer_open(dir,"symlink",&policy,spans,pk,&err));
    /* Anchoring publication to the opened directory survives path renaming. */
    assert(!mkdirat(dir,"before",0700));int sub=openat(dir,"before",O_RDONLY|O_DIRECTORY);assert(sub>=0);
    w=open_writer(sub,"anchored");fill(w);assert(!renameat(dir,"before",dir,"after"));
    assert(sh_pads_v3_writer_finish(w,&published)==SH_OK&&published);assert(faccessat(sub,"anchored",F_OK,0)==0);close(sub);
    close(dir);puts("sparse-v3 crypto/v2-equivalence, tamper, fd identity, nonce claims and publication failures PASS");
}
