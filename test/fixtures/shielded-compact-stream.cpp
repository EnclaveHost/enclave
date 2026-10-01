#include "../../wasm/ggml-shielded/shielded-compact.cpp"
#include <cassert>
#include <cstdio>
#include <thread>
int main(int argc, char **argv) {
  assert(argc == 2);
  const int K=256, N=833, stride=N+3;
  uint32_t rng=7;
  auto next=[&]{rng^=rng<<13;rng^=rng>>17;rng^=rng<<5;return rng;};
  std::vector<int8_t>w(K*N);
  for(auto &v:w)v=int(next()%239)-119;
  auto *s=sh_compact_create_streamed(w.data(),K,N,argv[1]);assert(s && s->fd>=0);
  assert(sh_compact_bytes(s)<8192 && s->disk_bytes>100000);
  for(auto &chunk:s->chunks)assert(chunk.empty());
  std::vector<uint8_t>read(w.size());
  assert(sh_compact_read(s,61,read.data(),read.size()-61)==SH_OK);
  assert(!memcmp(read.data(),w.data()+61,read.size()-61));
  for(int b:{1,16,32,64,65,128,255,256}) {
    std::vector<int32_t>r(b*K),u(b*stride,INT32_MIN);
    for(auto &v:r)v=next()%SH_M_MOD;
    assert(sh_compact_refill(s,r.data(),b,u.data(),stride)==SH_OK);
    for(int i=0;i<b;i++) {
      for(int n=0;n<N;n++) {
        int64_t sum=0;for(int k=0;k<K;k++)sum+=(int64_t)r[i*K+k]*w[n*K+k];
        assert(u[i*stride+n]==sh_balanced(sum));
      }
      for(int n=N;n<stride;n++)assert(u[i*stride+n]==INT32_MIN);
    }
  }
  std::vector<std::thread>threads;
  for(int t=0;t<4;t++)threads.emplace_back([&,t]{
    std::vector<int32_t>r(65*K,12345+t),u(65*N);
    assert(sh_compact_refill(s,r.data(),65,u.data(),N)==SH_OK);
    for(int n=0;n<N;n++) {
      int64_t sum=0;for(int k=0;k<K;k++)sum+=(int64_t)(12345+t)*w[n*K+k];
      for(int i=0;i<65;i++)assert(u[i*N+n]==sh_balanced(sum));
    }
  });
  for(auto &t:threads)t.join();
  // Late corruption/truncation must wipe earlier computed tiles and preserve
  // output stride canaries. Bytes are never interpreted before authentication.
  const auto last=s->disk.back();uint8_t byte;
  assert(pread(s->fd,&byte,1,last.offset)==1);byte^=1;
  assert(pwrite(s->fd,&byte,1,last.offset)==1);
  for(int truncated=0;truncated<2;truncated++) {
    if(truncated)assert(ftruncate(s->fd,last.offset+1)==0);
    std::vector<int32_t>r(256*K,SH_M_MOD-1),u(256*stride,INT32_MIN);
    assert(sh_compact_refill(s,r.data(),256,u.data(),stride)==SH_ERR_VERIFY);
    for(int i=0;i<256;i++) {
      for(int n=0;n<N;n++)assert(u[i*stride+n]==0);
      for(int n=N;n<stride;n++)assert(u[i*stride+n]==INT32_MIN);
    }
    std::fill(read.begin(),read.end(),255);
    assert(sh_compact_read(s,0,read.data(),read.size())==SH_ERR_VERIFY);
    for(auto v:read)assert(v==0);
  }
  sh_compact_free(s);
  assert(!sh_compact_create_streamed(w.data(),K,N,"/dev/shm"));
  assert(!sh_compact_create_streamed(w.data(),K,N,"/does-not-exist"));
  puts("streamed compact: exact batches 1..256, bounded weights, concurrent reads, corruption/truncation rejected");
}
