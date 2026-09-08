#include <algorithm>
#include <array>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <unistd.h>
#include <vector>
#include <cassert>
#include <dirent.h>
static int last_fd=-1, read_interrupt=0, write_interrupt=0, zero_write=0, bad_sync=0, short_io=0, mutate_after_read=0;
static int tracked_temp(char *p) { return last_fd=mkstemp(p); }
static ssize_t checked_read(int fd,void *p,size_t n,off_t off) {
    if (read_interrupt) { read_interrupt=0; errno=EINTR; return -1; }
    ssize_t r=pread(fd,p,short_io ? std::min(n,size_t(317)) : n,off);
    if (r>0 && mutate_after_read) { mutate_after_read=0; uint8_t bad=((uint8_t*)p)[0]^1; assert(pwrite(fd,&bad,1,off)==1); }
    return r;
}
static ssize_t checked_write(int fd,const void *p,size_t n,off_t off) {
    if (write_interrupt) { write_interrupt=0; errno=EINTR; return -1; }
    if (zero_write) return 0;
    return pwrite(fd,p,short_io ? std::min(n,size_t(511)) : n,off);
}
static int checked_sync(int fd) { if(bad_sync) {errno=EIO;return -1;}return fdatasync(fd); }
#define mkstemp tracked_temp
#define pread checked_read
#define pwrite checked_write
#define fdatasync checked_sync
#include "shielded-weight-cache.h"
#undef mkstemp
#undef pread
#undef pwrite
#undef fdatasync
extern "C" void randombytes(unsigned char *p,unsigned long long n) { memset(p,0,n); }
static int fd_count() { DIR *d=opendir("/proc/self/fd");assert(d);int n=0;while(readdir(d))n++;closedir(d);return n; }
int main(int argc,char **argv) {
    assert(argc==2); const size_t B=sh_weight_cache::block_bytes, N=3*B+23;
    std::vector<int8_t> source(N); for(size_t i=0;i<N;i++) source[i]=(int8_t)((i*13+i/37)%251-125);
    const int fds=fd_count();
    short_io=1;write_interrupt=1;
    const char *mode=getenv("SHIELDED_WEIGHT_CACHE_SHA256");
    const bool sha256=mode && !strcmp(mode,"1");
    auto cache=sh_weight_cache::create(argv[1],source.data(),source.size());assert(cache);
    assert(!strcmp(cache->hash_algorithm(),sha256?"sha256":"sha512"));
    // Algorithm selection is pinned when this private cache is created.
    setenv("SHIELDED_WEIGHT_CACHE_SHA256",sha256?"0":"1",1);
    int fd=last_fd; assert(cache->hash_bytes()==4*64);assert(fcntl(fd,F_GETFD)&FD_CLOEXEC);
    char link[64],target[4096];snprintf(link,sizeof link,"/proc/self/fd/%d",fd);
    ssize_t z=readlink(link,target,sizeof target-1);assert(z>0);target[z]=0;assert(strstr(target,"(deleted)"));
    std::vector<uint8_t> got(N,0);read_interrupt=1;
    assert(cache->read(0,got.data(),N)==0);assert(!memcmp(got.data(),source.data(),N));
    for(size_t off: {size_t(1),B-19,B+3,2*B-1,N-1}) {
        size_t n=std::min(N-off,B+29);assert(cache->read(off,got.data(),n)==0);assert(!memcmp(got.data(),source.data()+off,n));
    }
    assert(cache->read(N,got.data(),0)==0);assert(cache->read(N,got.data(),1)!=0);assert(cache->read(UINT64_MAX,got.data(),1)!=0);
    short_io=0;
    // The host mutates the file after the read: the private verified bytes, not
    // a second file read, must be the bytes delivered to the caller.
    mutate_after_read=1;assert(cache->read(0,got.data(),B)==0);assert(!memcmp(got.data(),source.data(),B));
    assert(cache->read(0,got.data(),B)!=0);assert(pwrite(fd,source.data(),B,0)==(ssize_t)B);
    // Block reordering, corruption outside the requested subrange, truncation.
    assert(pwrite(fd,source.data()+B,B,0)==(ssize_t)B);assert(cache->read(11,got.data(),1)!=0);
    assert(pwrite(fd,source.data(),B,0)==(ssize_t)B);
    uint8_t bad=(uint8_t)source[1000]^1;assert(pwrite(fd,&bad,1,1000)==1);assert(cache->read(11,got.data(),1)!=0);
    assert(pwrite(fd,source.data(),B,0)==(ssize_t)B);assert(ftruncate(fd,N-1)==0);assert(cache->read(N-2,got.data(),1)!=0);
    cache.reset();assert(fd_count()==fds);
    zero_write=1;assert(!sh_weight_cache::create(argv[1],source.data(),N));zero_write=0;assert(fd_count()==fds);
    bad_sync=1;assert(!sh_weight_cache::create(argv[1],source.data(),N));bad_sync=0;assert(fd_count()==fds);
    assert(!sh_weight_cache::create("/no-such-weight-cache-dir",source.data(),N));assert(fd_count()==fds);
    puts("weight-cache: authenticated reads, tamper/race rejection, I/O failure cleanup passed");
}
