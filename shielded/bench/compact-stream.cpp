// Paired public-model component benchmark; not an application tok/s result.
#define main fixture_unused_main
#include "streamed-refill.cpp"
#undef main
#include "../../wasm/ggml-shielded/shielded-compact.h"
static const char *spill_dir;
static sh_compact_store *disk_create(const int8_t *w,int64_t K,int64_t N){return sh_compact_create_streamed(w,K,N,spill_dir);}
struct api {const char *name;sh_compact_store *(*create)(const int8_t*,int64_t,int64_t);sh_compact_store *store;};
int main(int argc,char**argv){try{
 require(argc==6,"MODEL TENSOR BATCH REPS DIR");spill_dir=argv[5];int b=std::stoi(argv[3]),reps=std::stoi(argv[4]);require(b>0&&b<=256&&reps>0&&reps<=30,"bounds");
 std::vector<int8_t>w;int64_t K,N;encode_model(argv[1],argv[2],w,K,N);
 require(N%64==0,"aligned column split");N/=2;w.resize((size_t)K*N); api modes[]={{"resident",sh_compact_create,nullptr},{"streamed",disk_create,nullptr}};
 std::vector<uint8_t>read(w.size());for(auto&m:modes){m.store=m.create(w.data(),K,N);require(m.store,"admit");require(sh_compact_read(m.store,0,read.data(),read.size())==SH_OK&&!memcmp(read.data(),w.data(),read.size()),"byte roundtrip");}
 std::vector<int32_t>r((size_t)b*K),want((size_t)b*N),got(want.size()),acc(12*N);for(auto&v:r)v=next32()%SH_M_MOD;
 std::vector<uint8_t>planes(r.size()*3);sh_simd_avx512_pad_planes(r.data(),r.size(),planes.data(),planes.data()+r.size(),planes.data()+2*r.size());
 sh_simd_avx512_refill_vector_crt(planes.data(),b,w.data(),K,N,want.data(),N,acc.data());
 for(int rep=0;rep<reps;rep++) for(int q=0;q<2;q++){auto&m=modes[(q+rep)%2];double t=now(),c=cpu_now();require(sh_compact_refill(m.store,r.data(),b,got.data(),N)==SH_OK,"refill");double wall=now()-t,cpu=cpu_now()-c;require(got==want,"exact mismatch");std::cout<<"{\"mode\":\""<<m.name<<"\",\"tensor\":\""<<argv[2]<<"\",\"batch\":"<<b<<",\"rep\":"<<rep<<",\"seconds\":"<<wall<<",\"cpu_s\":"<<cpu<<",\"packed_bytes\":"<<sh_compact_bytes(m.store)<<",\"exact\":true}"<<std::endl;}
 for(auto&m:modes)sh_compact_free(m.store);
}catch(const std::exception&e){std::cerr<<e.what()<<std::endl;return 1;}}
