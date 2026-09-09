#include "anchor_encoded_catalog.h"
#include "check_hash.h"
#include "shielded-weight-cache.h"
#include <sys/random.h>
#include <cassert>
#include <string>

extern "C" void randombytes(unsigned char *p,unsigned long long n) {
    while(n) {ssize_t r=getrandom(p,(size_t)n,0);if(r<0&&errno==EINTR)continue;if(r<=0)abort();p+=r;n-=(size_t)r;}
}
int main(int argc,char **argv) {
    if(argc!=10)return 2;
    uint8_t source_hash[32],model_hash[32],encoded_hash[32],calib[32],converter[32];
    if(!unhex(argv[3],source_hash)||!unhex(argv[4],model_hash)||!unhex(argv[6],encoded_hash)||
            !unhex(argv[7],calib)||!unhex(argv[8],converter))return 2;
    const anchor_hash_ops h={hi,hu,hf};char err[256];anchor_catalog_table source{};anchor_encoded_catalog c{};
    int mf=open(argv[1],O_RDONLY),sf=open(argv[2],O_RDONLY),ef=open(argv[5],O_RDONLY);
    if(!anchor_catalog_open(mf,sf,source_hash,model_hash,&h,&source,err,sizeof err)) {
        fprintf(stderr,"source REFUSED: %s\n",err);close(mf);close(sf);close(ef);return 3;
    }
    int ok=anchor_encoded_catalog_open(ef,encoded_hash,&source,calib,converter,&h,&c,err,sizeof err);
    close(mf);close(sf);close(ef);
    if(!ok) {
        assert(!c.raw&&!c.entries&&!c.authenticated);
        fprintf(stderr,"encoded REFUSED: %s\n",err);anchor_catalog_free(&source);return 4;
    }
    assert(c.authenticated&&c.count);
    uint64_t bytes_read=0;
    if(strcmp(argv[9],"-")) {
        int dir=open(argv[9],O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(dir<0)return 5;
        for(size_t i=0;i<c.count;i++) {
            auto &e=c.entries[i];char hex[65];
            for(size_t j=0;j<32;j++)snprintf(hex+2*j,3,"%02x",e.encoded_sha256[j]);
            std::string filename=std::string(hex)+".i8";
            int fd=openat(dir,filename.c_str(),O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
            std::vector<std::array<uint8_t,32>> hashes((size_t)e.blocks);
            for(size_t j=0;j<hashes.size();j++)memcpy(hashes[j].data(),e.block_sha256+32*j,32);
            auto reader=sh_weight_cache::open_catalog_sha256(fd,e.bytes,hashes);
            if(fd>=0)close(fd);
            if(!reader) {close(dir);anchor_encoded_catalog_free(&c);anchor_catalog_free(&source);return 5;}
            assert(reader->read_calls()==0&&reader->read_bytes()==0);
            // A full verified read before the same bytes could enter registration.
            std::vector<uint8_t> weights((size_t)e.bytes);
            if(reader->read(0,weights.data(),weights.size())) {close(dir);anchor_encoded_catalog_free(&c);anchor_catalog_free(&source);return 5;}
            uint8_t digest[32];check_sha256(weights.data(),weights.size(),digest);
            if(memcmp(digest,e.encoded_sha256,32)) {close(dir);anchor_encoded_catalog_free(&c);anchor_catalog_free(&source);return 5;}
            bytes_read+=reader->read_bytes();
            assert(anchor_encoded_find(&c,e.source->name)==&e);
        }
        close(dir);
    }
    printf("{\"status\":\"ENCODED_CATALOG_VALID\",\"entries\":%zu,\"verified_artifact_bytes\":%llu}\n",c.count,(unsigned long long)bytes_read);
    anchor_encoded_catalog_free(&c);anchor_catalog_free(&source);return 0;
}
