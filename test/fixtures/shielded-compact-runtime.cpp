#include "../../wasm/ggml-shielded/shielded-compact.cpp"
#include <cassert>
#include <cstdio>
#include <thread>
static void assert_no_wx() {
  FILE *f=fopen("/proc/self/maps","r");assert(f);char line[4096],perm[5];
  while(fgets(line,sizeof line,f))if(sscanf(line,"%*s %4s",perm)==1)
    assert(!(perm[1]=='w' && perm[2]=='x'));
  assert(!ferror(f));fclose(f);
}
int main(){
  __builtin_cpu_init();if(!__builtin_cpu_supports("avx512vnni"))return 77;
  unsigned cases=0;omp_set_num_threads(3);
  for(int K:{1,63,64,65,5120,17408,65536})for(int N:{1,17,385})for(int b:{1,16,32,64}){
    // Bound total fixture runtime while keeping both GEMM and tile-boundary cases.
    if(K>5120&&N>17)continue;
    std::vector<int8_t>w((size_t)K*N);for(size_t i=0;i<w.size();i++)w[i]=(i%3==0?119:i%3==1?-119:1);
    auto*s=sh_compact_create(w.data(),K,N);assert(s);
    std::vector<uint8_t> read(w.size());assert(sh_compact_read(s,0,read.data(),read.size())==SH_OK);assert(!memcmp(read.data(),w.data(),w.size()));
    if(w.size()>67){assert(sh_compact_read(s,63,read.data(),w.size()-63)==SH_OK);assert(!memcmp(read.data(),w.data()+63,w.size()-63));}
    assert(sh_compact_read(s,w.size(),read.data(),1)==SH_ERR_RANGE);
    std::vector<int32_t>r((size_t)b*K,SH_M_MOD-1),u((size_t)b*(N+3),INT32_MIN);
    assert(sh_compact_refill(s,r.data(),b,u.data(),N+3)==SH_OK);assert(omp_get_max_threads()==3);assert_no_wx();
    for(int i=0;i<b;i++){for(int j=0;j<N;j++){int64_t sum=0;for(int k=0;k<K;k++)sum+=(int64_t)r[(size_t)i*K+k]*w[(size_t)j*K+k];assert(u[(size_t)i*(N+3)+j]==sh_balanced(sum));}for(int j=N;j<N+3;j++)assert(u[(size_t)i*(N+3)+j]==INT32_MIN);}
    s->chunks.back().clear(); // A late decoder failure must wipe earlier tiles too.
    assert(sh_compact_refill(s,r.data(),b,u.data(),N+3)==SH_ERR_VERIFY);
    for(int i=0;i<b;i++)for(int j=0;j<N;j++)assert(u[(size_t)i*(N+3)+j]==0);
    assert(sh_compact_read(s,0,read.data(),read.size())==SH_ERR_VERIFY);
    for(auto x:read)assert(x==0);
    sh_compact_free(s);cases++;
  }
  std::vector<std::thread> workers;
  for(int t=0;t<4;t++) workers.emplace_back([t] {
    const int K=5120,N=17;std::vector<int8_t>w(K*N,t+1);
    auto*s=sh_compact_create(w.data(),K,N);assert(s);
    for(int b:{64,16,32}) {
      std::vector<int32_t>r(b*K,(t+1)*12345),u(b*N,0);
      assert(sh_compact_refill(s,r.data(),b,u.data(),N)==SH_OK);
      const auto expected=sh_balanced((int64_t)K*(t+1)*(t+1)*12345);
      for(auto x:u)assert(x==expected);
    }
    sh_compact_free(s);
  });
  for(auto &w:workers)w.join();assert_no_wx();
  int8_t bad=120;assert(!sh_compact_create(&bad,1,1));assert(!sh_compact_create(&bad,65537,1));
  printf("compact-runtime: %u exact cases, bounds, private reads, failure wipes, concurrent scratch, W^X and OpenMP restoration passed\n",cases);
}
