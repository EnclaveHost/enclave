// Offline public-model benchmark. Never connects to a GPU or reads live pads.
#include "streamed-refill.h"
#include "../../wasm/ggml-shielded/shielded-weight-cache.h"
#include "../../wasm/ggml-shielded/shielded-source-quant.h"
#include "../../wasm/ggml-shielded/shielded-simd.h"
#include "gguf.h"
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <chrono>
#include <fstream>
#include <iostream>
#include <malloc.h>
#include <sys/resource.h>

using namespace streamed_prototype;
static void require(bool v,const char *s) { if (!v) throw std::runtime_error(s); }
static double now() { return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
static double cpu_now() { rusage r{};require(getrusage(RUSAGE_SELF,&r)==0,"rusage");return r.ru_utime.tv_sec+r.ru_utime.tv_usec*1e-6+r.ru_stime.tv_sec+r.ru_stime.tv_usec*1e-6; }
static uint64_t disk_bytes() { std::ifstream f("/proc/self/io"); std::string k; uint64_t v; while(f>>k>>v) if(k=="read_bytes:")return v; return 0; }
static uint64_t rss_kib() { std::ifstream f("/proc/self/statm"); uint64_t a,b; f>>a>>b; return b*sysconf(_SC_PAGESIZE)/1024; }
static uint32_t rng=721;
static uint32_t next32(){rng=rng*1664525U+1013904223U;return rng;}
static std::array<uint8_t,32> digest(const uint8_t *p,size_t n) {
    std::array<uint8_t,32> d; unsigned len=0;
    require(EVP_Digest(p,n,d.data(),&len,EVP_sha256(),nullptr)==1 && len==32,"SHA256 failed");return d;
}
struct file_cache {
    int fd=-1,direct_fd=-1; size_t bytes=0;
    std::vector<std::array<uint8_t,32>> hashes;
    std::array<uint8_t,32> mac_key{};
    std::vector<std::array<uint8_t,16>> tags;
    std::unique_ptr<sh_weight_cache> scalar;
    ~file_cache(){if(fd>=0)close(fd);if(direct_fd>=0)close(direct_fd);OPENSSL_cleanse(mac_key.data(),mac_key.size());}
    std::array<uint8_t,16> mac(const uint8_t *p,size_t n,uint64_t index)const{
        // New random key per immutable cache; one nonce per block. Original
        // publisher/model admission remains SHA-256 outside this experiment.
        uint8_t iv[12]={'s','h','w','c'},meta[16]={};
        for(int i=0;i<8;i++){iv[4+i]=index>>(56-8*i);meta[i]=(uint64_t)bytes>>(56-8*i);meta[8+i]=(index*sh_weight_cache::block_bytes)>>(56-8*i);}
        std::unique_ptr<EVP_CIPHER_CTX,decltype(&EVP_CIPHER_CTX_free)> ctx(EVP_CIPHER_CTX_new(),EVP_CIPHER_CTX_free);
        require(bool(ctx),"GMAC allocation");int len=0;std::array<uint8_t,16>tag{};uint8_t tail[16];
        require(EVP_EncryptInit_ex(ctx.get(),EVP_aes_256_gcm(),nullptr,mac_key.data(),iv)==1&&
            EVP_EncryptUpdate(ctx.get(),nullptr,&len,meta,sizeof meta)==1&&
            EVP_EncryptUpdate(ctx.get(),nullptr,&len,p,n)==1&&
            EVP_EncryptFinal_ex(ctx.get(),tail,&len)==1&&len==0&&
            EVP_CIPHER_CTX_ctrl(ctx.get(),EVP_CTRL_GCM_GET_TAG,16,tag.data())==1,"GMAC failure");return tag;
    }
    void create(const std::string &dir,const std::vector<int8_t> &w) {
        auto path=dir+"/.streamed-prototype-XXXXXX"; fd=mkstemp(path.data());
        require(fd>=0,"create cache"); require(unlink(path.c_str())==0,"unlink cache");
        require(fcntl(fd,F_SETFD,FD_CLOEXEC)==0,"cloexec"); bytes=w.size();require(RAND_bytes(mac_key.data(),mac_key.size())==1,"cache key generation");
        for(size_t off=0;off<bytes;off+=sh_weight_cache::block_bytes){
            size_t n=std::min(sh_weight_cache::block_bytes,bytes-off),done=0;
            hashes.push_back(digest((const uint8_t *)w.data()+off,n));
            tags.push_back(mac((const uint8_t *)w.data()+off,n,off/sh_weight_cache::block_bytes));
            while(done<n){ssize_t r=pwrite(fd,w.data()+off+done,n-done,off+done);if(r<0&&errno==EINTR)continue;require(r>0,"write cache");done+=r;}
        }
        require(fdatasync(fd)==0,"sync cache");
        direct_fd=open(("/proc/self/fd/"+std::to_string(fd)).c_str(),O_RDONLY|O_CLOEXEC|O_DIRECT);
        scalar=sh_weight_cache::open_catalog_sha256(fd,bytes,hashes); require(bool(scalar),"open cache");
    }
    void cold(){require(posix_fadvise(fd,0,0,POSIX_FADV_DONTNEED)==0,"evict owned cache");}
    int read(uint64_t off,uint8_t *out,size_t n,bool fast,bool direct=false,bool gmac=false){
        if(off>bytes||n>bytes-off)return -1;
        if(!fast)return scalar->read(off,out,n);
        // Same private-buffer/hash contract as production cache; OpenSSL uses
        // CPU SHA instructions where available. Prototype dependency only.
        if(direct&&direct_fd<0)return -1;
        std::unique_ptr<uint8_t,decltype(&free)> block((uint8_t*)aligned_alloc(4096,sh_weight_cache::block_bytes),free);
        if(!block)return -1;
        while(n){
            size_t bi=off/sh_weight_cache::block_bytes,start=bi*sh_weight_cache::block_bytes;
            size_t count=std::min(sh_weight_cache::block_bytes,bytes-start),have=0;
            while(have<count){size_t want=direct ? ((count-have+4095)/4096)*4096 : count-have;
                // A short non-final direct read cannot safely advance aligned
                // I/O; refuse it. Buffered mode handles ordinary partial I/O.
                ssize_t r=pread(direct?direct_fd:fd,block.get()+have,want,start+have);if(r<0&&errno==EINTR)continue;if(r<=0||(size_t)r>count-have)return -1;have+=r;if(direct&&have<count)return -1;}
            if(gmac){auto tag=mac(block.get(),count,bi);if(CRYPTO_memcmp(tag.data(),tags[bi].data(),tag.size()))return -1;}
            else if(digest(block.get(),count)!=hashes[bi])return -1;
            size_t skip=off-start,take=std::min(n,count-skip);
            memcpy(out,block.get()+skip,take);out+=take;off+=take;n-=take;
        }
        return 0;
    }
};
static void encode_model(const char *path,const char *name,std::vector<int8_t> &w,int64_t &K,int64_t &N){
    ggml_context *ctx=nullptr; gguf_init_params params{true,&ctx};
    gguf_context *gf=gguf_init_from_file(path,params);require(gf&&ctx,"GGUF metadata");
    int64_t ti=gguf_find_tensor(gf,name);require(ti>=0,"tensor missing");
    auto t=ggml_get_tensor(ctx,name);require(t&&t->ne[2]==1&&t->ne[3]==1,"matrix required");
    K=t->ne[0];N=t->ne[1];require(K*N<=(2LL<<30),"prototype tensor exceeds 2 GiB");
    require(sh_source_type_ok(t->type)&&sh_source_geometry_ok(t->type,K),"unsupported encoding");
    w.resize((size_t)K*N);std::vector<int> fw(N);
    size_t rs=ggml_row_size(t->type,K);std::vector<uint8_t> src(rs*16);
    int fd=open(path,O_RDONLY|O_CLOEXEC);require(fd>=0,"model open");
    uint64_t base=gguf_get_data_offset(gf)+gguf_get_tensor_offset(gf,ti);
    for(int64_t j=0;j<N;j+=16){int64_t nr=std::min<int64_t>(16,N-j);size_t n=nr*rs,done=0;
        while(done<n){ssize_t r=pread(fd,src.data()+done,n-done,base+j*rs+done);if(r<0&&errno==EINTR)continue;require(r>0,"source read");done+=r;}
        require(sh_prepare_rows_any(src.data(),t->type,K,nr,0,nr,w.data()+j*K,fw.data()+j)==0,"encode rows");
    }
    close(fd);gguf_free(gf);ggml_free(ctx);
}
static void tests(const std::string &dir){
    size_t cases=0;
    for(int K:{63,64,65,5120})for(int N:{17,35})for(int b:{1,4,5,64,256,512}){
        std::vector<int8_t>w((size_t)K*N);for(auto &x:w)x=(int)(next32()%239)-119;
        file_cache f;f.create(dir,w);
        std::vector<int32_t>r((size_t)b*K);for(auto &x:r)x=(int64_t)(next32()%SH_M_MOD)-SH_HALF_M;
        std::vector<uint8_t>p(r.size()*3);sh_simd_avx512_pad_planes(r.data(),r.size(),p.data(),p.data()+r.size(),p.data()+2*r.size());
        int stride=N+3;std::vector<int32_t>u((size_t)b*stride,INT32_MIN);metrics m;
        for(int kind:{0,1,2,3})for(bool pf:{false,true}){
            require(refill([&](uint64_t o,uint8_t *d,size_t n){return f.read(o,d,n,kind>0,kind>=2,kind==3);},p.data(),b,K,N,u.data(),stride,K*16,sh_simd_avx512_refill_vector_crt,pf,m),"stream failed");
            for(int i=0;i<b;i++){for(int j=0;j<N;j++){int64_t sum=0;for(int k=0;k<K;k++)sum+=(int64_t)r[(size_t)i*K+k]*w[(size_t)j*K+k];require(u[(size_t)i*stride+j]==sh_balanced(sum),"oracle mismatch");}for(int j=N;j<stride;j++)require(u[(size_t)i*stride+j]==INT32_MIN,"stride overwrite");}
            cases++;
        }
        // Alter a byte on disk after private digests have been admitted.
        uint8_t bad=((uint8_t)w.back())^1;require(pwrite(f.fd,&bad,1,w.size()-1)==1,"tamper fixture");
        for(int kind:{0,1,2,3}){require(!refill([&](uint64_t o,uint8_t *d,size_t n){return f.read(o,d,n,kind>0,kind>=2,kind==3);},p.data(),b,K,N,u.data(),stride,K*16,sh_simd_avx512_refill_vector_crt,true,m),"tamper accepted");for(int i=0;i<b;i++)for(int j=0;j<N;j++)require(u[(size_t)i*stride+j]==0,"failed output retained");}
    }
    // More than one hash block: success, late tampering, truncation, read error,
    // exception, and subsequent invocation must reauthenticate the source.
    const int K=5120,N=512,b=5;std::vector<int8_t>w((size_t)K*N,119);file_cache f;f.create(dir,w);
    std::vector<int32_t>r((size_t)b*K,-1),u((size_t)b*N);std::vector<uint8_t>p(r.size()*3);
    sh_simd_avx512_pad_planes(r.data(),r.size(),p.data(),p.data()+r.size(),p.data()+2*r.size());metrics m;
    for(int kind:{0,1,2,3}){
        require(refill([&](uint64_t o,uint8_t*d,size_t n){return f.read(o,d,n,kind>0,kind>=2,kind==3);},p.data(),b,K,N,u.data(),N,1<<20,sh_simd_avx512_refill_vector_crt,true,m),"multi block");
        for(auto x:u)require(x==sh_balanced(-(int64_t)K*119),"extreme mismatch");
    }
    // GMAC's key and block position are part of admission, not host metadata.
    std::swap(f.tags[0],f.tags[1]);require(f.read(0,(uint8_t*)w.data(),32,true,true,true)!=0,"GMAC tag swap accepted");std::swap(f.tags[0],f.tags[1]);
    f.mac_key[0]^=1;require(f.read(0,(uint8_t*)w.data(),32,true,true,true)!=0,"GMAC wrong key accepted");f.mac_key[0]^=1;
    require(ftruncate(f.fd,w.size()-1)==0,"truncate");
    for(int kind:{0,1,2,3}){require(!refill([&](uint64_t o,uint8_t*d,size_t n){return f.read(o,d,n,kind>0,kind>=2,kind==3);},p.data(),b,K,N,u.data(),N,1<<20,sh_simd_avx512_refill_vector_crt,true,m),"truncated accepted");for(auto x:u)require(x==0,"late failure retained output");}
    require(!refill([](uint64_t,uint8_t*,size_t)->int{throw std::runtime_error("fixture");},p.data(),b,K,N,u.data(),N,1<<20,sh_simd_avx512_refill_vector_crt,true,m),"exception accepted");
    std::cout<<"{\"oracle_cases\":"<<cases<<",\"tamper_truncation_exception\":\"passed\"}\n";
}
int main(int argc,char **argv){try{
    __builtin_cpu_init();if(!__builtin_cpu_supports("avx512vnni") || !__builtin_cpu_supports("avx512bw") || !__builtin_cpu_supports("avx512dq") || !__builtin_cpu_supports("avx512vl"))return 77;
    require(argc>=3,"usage: bench --test DIRECTORY | bench DIRECTORY MODEL TENSOR BATCH REPS HASH");
    if(std::string(argv[1])=="--test"){tests(argv[2]);return 0;}
    require(argc==8,"benchmark arguments");int b=std::stoi(argv[5]),reps=std::stoi(argv[6]);std::string hash=argv[7];
    require(hash=="scalar"||hash=="openssl"||hash=="openssl-direct"||hash=="gmac-direct","hash mode");bool fast=hash!="scalar",direct=hash=="openssl-direct"||hash=="gmac-direct",gmac=hash=="gmac-direct";
    require(b>0&&b<=512&&reps>0&&reps<=10,"benchmark bounds");
    std::vector<int8_t>w;int64_t K,N;encode_model(argv[2],argv[3],w,K,N);
    // argv[4] reserved mode: allows separate resident/stream runs for RSS.
    std::string mode=argv[4];require(mode=="paired"||mode=="stream","mode");
    file_cache f;f.create(argv[1],w);
    std::vector<int32_t>r((size_t)b*K);for(auto &x:r)x=(int64_t)(next32()%SH_M_MOD)-SH_HALF_M;
    std::vector<uint8_t>p(r.size()*3);sh_simd_avx512_pad_planes(r.data(),r.size(),p.data(),p.data()+r.size(),p.data()+2*r.size());
    std::vector<int32_t>u((size_t)b*N),ref(u.size()),acc((size_t)12*N);
    sh_simd_avx512_refill_vector_crt(p.data(),b,w.data(),K,N,ref.data(),N,acc.data());
    const size_t wb=w.size();if(mode=="stream"){
        uint64_t before=rss_kib();std::vector<int8_t>().swap(w);malloc_trim(0);
        std::cerr<<"{\"memory_probe\":true,\"encoded_bytes\":"<<wb<<",\"before_release_kib\":"<<before<<",\"after_release_kib\":"<<rss_kib()<<"}"<<std::endl;
    }
    for(int rep=0;rep<reps;rep++){
        double resident=-1,elapsed=0,resident_cpu=-1,stream_cpu=0;uint64_t reads=0;metrics m;
        auto runResident=[&]{if(mode=="paired"){double c=cpu_now(),t=now();sh_simd_avx512_refill_vector_crt(p.data(),b,w.data(),K,N,u.data(),N,acc.data());resident=now()-t;resident_cpu=cpu_now()-c;require(u==ref,"resident mismatch");}};
        auto runStream=[&]{f.cold();uint64_t d0=disk_bytes();double c=cpu_now(),t=now();
            require(refill([&](uint64_t o,uint8_t*d,size_t n){int rc=f.read(o,d,n,fast,direct,gmac);if(rc==0&&!direct){size_t end=o+n;size_t lo=o/(1<<20)*(1<<20),hi=end/(1<<20)*(1<<20);if(hi>lo)posix_fadvise(f.fd,lo,hi-lo,POSIX_FADV_DONTNEED);}return rc;},p.data(),b,K,N,u.data(),N,8<<20,sh_simd_avx512_refill_vector_crt,true,m),"stream failure");
            elapsed=now()-t;stream_cpu=cpu_now()-c;reads=disk_bytes()-d0;require(u==ref,"stream differs from resident");};
        if(rep%2){runStream();runResident();}else{runResident();runStream();}
        std::cout<<"{\"tensor\":\""<<argv[3]<<"\",\"K\":"<<K<<",\"N\":"<<N<<",\"batch\":"<<b<<",\"rep\":"<<rep<<",\"hash\":\""<<argv[7]<<"\",\"mode\":\""<<mode<<"\",\"resident_s\":"<<resident<<",\"stream_s\":"<<elapsed<<",\"resident_cpu_s\":"<<resident_cpu<<",\"stream_cpu_s\":"<<stream_cpu<<",\"disk_read_bytes\":"<<reads<<",\"encoded_bytes\":"<<wb<<",\"weight_buffers\":"<<m.weight_buffer_bytes<<",\"rss_kib\":"<<rss_kib()<<",\"exact\":true}"<<std::endl;
    }
    return 0;
}catch(const std::exception &e){std::cerr<<e.what()<<"\n";return 1;}}
