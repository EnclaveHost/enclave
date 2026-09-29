#include "../../wasm/llama-shim/shield-original-source.hpp"
#include "../../wasm/ggml-shielded/shielded-source-bytes.h"
#include <cassert>
#include <sys/stat.h>
#include <sys/mman.h>
#include <cstdio>
int main(int argc, char **argv) {
    assert(argc == 2);
    // Scratch copies move without duplicating their mapping and return every
    // page to the kernel instead of leaving a large free chunk in malloc.
    sh_source_bytes scratch(32u << 20, 0x5a);
    auto *address = scratch.data();
    sh_source_bytes moved = std::move(scratch);
    assert(moved.data() == address && moved.front() == 0x5a && moved.back() == 0x5a);
    sh_source_bytes().swap(moved);
    unsigned char residency;
    errno = 0;
    assert(mincore(address, 4096, &residency) == -1 && errno == ENOMEM);
    bool overflow = false;
    try { sh_source_allocator<uint64_t>().allocate(SIZE_MAX); }
    catch (const std::bad_array_new_length &) { overflow = true; }
    assert(overflow);
    std::string base = argv[1];
    shield_original_source s;
    s.page = sysconf(_SC_PAGESIZE); s.file_size = s.page*1024;
    s.private_fd = open((base+"/private").c_str(), O_RDWR|O_CREAT|O_EXCL, 0600);
    s.backing_fd = open((base+"/backing").c_str(), O_RDWR|O_CREAT|O_EXCL, 0600);
    assert(s.private_fd>=0 && s.backing_fd>=0);
    std::vector<unsigned char> bytes(s.file_size);
    for (size_t i=0;i<bytes.size();i++) bytes[i] = (i*37+19)%251;
    assert(write(s.private_fd,bytes.data(),bytes.size()) == (ssize_t)bytes.size());
    assert(write(s.backing_fd,bytes.data(),bytes.size()) == (ssize_t)bytes.size());
    auto *private_map=(const unsigned char *)mmap(nullptr,bytes.size(),PROT_READ,MAP_SHARED,s.private_fd,0);
    assert(private_map!=MAP_FAILED);
    // Fault private CPU-weight pages before reclaiming an adjacent GPU tensor.
    assert(!memcmp(private_map,bytes.data(),s.page));
    const uint64_t off=s.page+32, n=s.page*100+128;
    int64_t ne[4]={32,100,1,1};
    s.add("blk.0.attn_q.weight", 8, ne, off, n);
    struct stat before{},after{}; assert(!fstat(s.private_fd,&before));
    std::vector<unsigned char> out(n), neighbour(64);
    assert(!s.read(&s,"blk.0.attn_q.weight",8,ne,out.data(),n));
    assert(out == std::vector<unsigned char>(bytes.begin()+off,bytes.begin()+off+n));
    assert(!s.verify(&s,"blk.0.attn_q.weight",8,ne,out.data(),n));
    assert(!fstat(s.private_fd,&after));
    assert(before.st_blocks>after.st_blocks && (before.st_blocks-after.st_blocks)*512 == (int64_t)s.released_bytes);
    assert(s.released_bytes==s.page*99 && s.reread_bytes==0);
    assert(!memcmp(private_map,bytes.data(),s.page));
    assert(!memcmp(private_map+off-32,bytes.data()+off-32,32));
    assert(!memcmp(private_map+off+n,bytes.data()+off+n,s.page));
    assert(s.read_at(s.private_fd,neighbour.data(),64,off-32));
    assert(!memcmp(neighbour.data(),bytes.data()+off-32,64));
    assert(s.read_at(s.private_fd,neighbour.data(),64,off+n-32));
    assert(!memcmp(neighbour.data(),bytes.data()+off+n-32,64));
    auto released=s.released_bytes;
    assert(!s.read(&s,"blk.0.attn_q.weight",8,ne,out.data(),n));
    assert(!s.verify(&s,"blk.0.attn_q.weight",8,ne,out.data(),n));
    assert(s.released_bytes==released && s.reread_bytes==n);
    // Host mutation after trusted staging cannot silently change weights.
    unsigned char evil=bytes[off]^0xff; assert(pwrite(s.backing_fd,&evil,1,off)==1);
    assert(!s.read(&s,"blk.0.attn_q.weight",8,ne,out.data(),n));
    assert(s.verify(&s,"blk.0.attn_q.weight",8,ne,out.data(),n)<0);
    int64_t wrong[4]={32,99,1,1};
    assert(s.read(&s,"blk.0.attn_q.weight",8,wrong,out.data(),n)<0);
    assert(s.verify(&s,"blk.0.attn_q.weight",9,ne,out.data(),n)<0);
    assert(s.verify(&s,"unknown",8,ne,out.data(),n)<0);
    assert(ftruncate(s.backing_fd,off+1)==0);
    assert(s.read(&s,"blk.0.attn_q.weight",8,ne,out.data(),n)<0);
    // Hole-punch failure must be explicit and never counted as reclaimed RAM.
    close(s.private_fd); s.private_fd=open((base+"/private").c_str(),O_RDONLY);
    assert(!s.retire(0,s.page)); assert(s.released_bytes==released);
    assert(munmap((void *)private_map,bytes.size())==0);
    puts("source reclamation: real blocks freed, boundaries intact, rereads authenticated");
}
