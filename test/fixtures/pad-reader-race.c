#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static pthread_barrier_t ready, proceed;
static atomic_int pause_cell, fail_dup, interrupt_dup;
static ssize_t racing_pread(int fd, void *p, size_t n, off_t off) {
    if (atomic_load(&pause_cell)) {
        pthread_barrier_wait(&ready); pthread_barrier_wait(&proceed);
    }
    return pread(fd,p,n,off);
}
static int checked_fcntl(int fd, int op, ...) {
    va_list ap; va_start(ap,op); int arg=va_arg(ap,int); va_end(ap);
    assert(op==F_DUPFD_CLOEXEC);
    if (atomic_exchange(&interrupt_dup,0)) { errno=EINTR; return -1; }
    if (atomic_load(&fail_dup)) { errno=EMFILE; return -1; }
    return fcntl(fd,op,arg);
}
#define pread racing_pread
#define fcntl checked_fcntl
#include "shielded-pads.c"
#undef pread
#undef fcntl

typedef struct { sh_pads_reader *r; int32_t out[3]; int rc; uint32_t ordinal; } job;
static void *read_cell(void *arg) { job *j=arg;j->rc=sh_pads_reader_cell_ordinal(j->r,0,0,j->out,&j->ordinal);return NULL; }
int main(int argc,char **argv) {
    assert(argc==2);
    uint8_t pk[32],sk[32],sid[16]={2},digest[32]={3}; crypto_box_keypair(pk,sk);
    sh_pads_group group={.group=0,.K=2,.u_len=3};strcpy(group.name,"race.weight");
    char path[1024],replacement[1024];snprintf(path,sizeof path,"%s/test.pads",argv[1]);snprintf(replacement,sizeof replacement,"%s/decoy",argv[1]);
    int err; const int32_t expected[3]={1,-2,3};
    sh_pads_writer *w=sh_pads_writer_open(path,digest,sid,&group,1,0,1,pk,&err); assert(w && err==SH_OK);
    assert(sh_pads_writer_cell(w,0,0,expected)==SH_OK);assert(sh_pads_writer_close(w)==SH_OK);
    sh_pads_reader *r=sh_pads_reader_open(argv[1],sid,sk,&err);assert(r && err==SH_OK);
    assert(sh_pads_reader_bind(r,&group,1)==SH_OK && r->n_files==1);
    int original=r->files[0].fd;
    job j={.r=r,.out={99,99,99},.rc=123,.ordinal=UINT32_MAX};
    atomic_store(&fail_dup,1);
    assert(sh_pads_reader_cell(r,0,0,j.out)==SH_ERR_IO);
    for(int i=0;i<3;i++)assert(j.out[i]==99);
    atomic_store(&fail_dup,0);atomic_store(&interrupt_dup,1);
    assert(sh_pads_reader_cell(r,0,0,j.out)==SH_OK && !memcmp(j.out,expected,sizeof expected));
    assert(pthread_barrier_init(&ready,NULL,2)==0 && pthread_barrier_init(&proceed,NULL,2)==0);
    atomic_store(&pause_cell,1);pthread_t t;assert(pthread_create(&t,NULL,read_cell,&j)==0);
    pthread_barrier_wait(&ready);   /* the importer has snapshotted its file and released reader.mu */
    assert(sh_pads_reader_prune_below(r,1,true)==1);
    assert(r->n_files==0 && sh_pads_reader_groups(r,NULL,1)==0);
    int decoy=open(replacement,O_RDWR|O_CREAT|O_TRUNC,0600);assert(decoy>=0);
    if(decoy!=original) { assert(dup2(decoy,original)==original);close(decoy);decoy=original; }
    assert(ftruncate(decoy,8192)==0);   /* old fd number now reads zeros from a different inode */
    pthread_barrier_wait(&proceed);
    assert(pthread_join(t,NULL)==0 && j.rc==SH_OK && j.ordinal==0 && !memcmp(j.out,expected,sizeof expected));
    atomic_store(&pause_cell,0);
    assert(sh_pads_reader_cell(r,0,0,j.out)==SH_ERR_EXHAUST);
    close(decoy);sh_pads_reader_close(r);
    pthread_barrier_destroy(&ready);pthread_barrier_destroy(&proceed);
    puts("pad-reader-race: ok");
}
