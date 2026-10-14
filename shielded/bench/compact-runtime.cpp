// Benchmark the linked production provider, not a copied experimental kernel.
#define main streamed_fixture_main
#include "streamed-refill.cpp"
#undef main
#include "../../wasm/ggml-shielded/shielded-compact.h"
int main(int argc,char **argv){try{
 require(argc==5,"usage: compact-runtime MODEL TENSOR BATCH REPS");
 int b=std::stoi(argv[3]),reps=std::stoi(argv[4]);require(b>0&&b<=64&&reps>0&&reps<=12,"bounds");
 std::vector<int8_t>w;int64_t K,N;encode_model(argv[1],argv[2],w,K,N);
 std::unique_ptr<sh_compact_store,decltype(&sh_compact_free)> packed(sh_compact_create(w.data(),K,N),sh_compact_free);require(bool(packed),"compact admission");
 std::vector<int32_t>r((size_t)b*K);for(auto &x:r)x=next32()%SH_M_MOD;
 std::vector<uint8_t>planes(r.size()*3);sh_simd_avx512_pad_planes(r.data(),r.size(),planes.data(),planes.data()+r.size(),planes.data()+2*r.size());
 std::vector<int32_t>a((size_t)b*N),z(a.size()),acc(12*N);
 for(int rep=0;rep<reps;rep++){
  double wall[2],cpu[2];for(int q=0;q<2;q++){int mode=rep%2?1-q:q;double t=now(),c=cpu_now();
   if(mode)require(sh_compact_refill(packed.get(),r.data(),b,z.data(),N)==SH_OK,"production refill");
   else sh_simd_avx512_refill_vector_crt(planes.data(),b,w.data(),K,N,a.data(),N,acc.data());
   wall[mode]=now()-t;cpu[mode]=cpu_now()-c;
  }require(a==z,"exact mismatch");
  std::cout<<"{\"tensor\":\""<<argv[2]<<"\",\"batch\":"<<b<<",\"rep\":"<<rep<<",\"resident_s\":"<<wall[0]<<",\"compact_s\":"<<wall[1]<<",\"resident_cpu_s\":"<<cpu[0]<<",\"compact_cpu_s\":"<<cpu[1]<<",\"encoded_bytes\":"<<w.size()<<",\"packed_bytes\":"<<sh_compact_bytes(packed.get())<<",\"exact\":true}"<<std::endl;
 }
}catch(const std::exception &e){std::cerr<<e.what()<<std::endl;return 1;}}
