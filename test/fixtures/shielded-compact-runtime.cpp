#include "../../wasm/ggml-shielded/shielded-compact.cpp"
#include <cassert>
#include <cstdio>
#include <thread>
static thread_local bool deny_refill_allocation;
static thread_local unsigned denied_refill_allocations;
extern "C" void *__real_aligned_alloc(size_t, size_t);
extern "C" void *__wrap_aligned_alloc(size_t alignment, size_t n) {
  if (deny_refill_allocation) { ++denied_refill_allocations; return nullptr; }
  return __real_aligned_alloc(alignment,n);
}
static void assert_no_wx() {
  FILE *f=fopen("/proc/self/maps","r");assert(f);char line[4096],perm[5];
  while(fgets(line,sizeof line,f))if(sscanf(line,"%*s %4s",perm)==1)
    assert(!(perm[1]=='w' && perm[2]=='x'));
  assert(!ferror(f));fclose(f);
}
static void check_read_window(sh_compact_store *s, const std::vector<int8_t> &w,
                              size_t off, size_t n) {
  std::vector<uint8_t> out(n + 2, 0xa5);
  assert(sh_compact_read(s, off, out.data() + 1, n) == SH_OK);
  assert(!memcmp(out.data() + 1, w.data() + off, n));
  assert(out.front() == 0xa5 && out.back() == 0xa5);
}
static unsigned read_window_cases() {
  unsigned cases = 0;
  const size_t chunk = 384 * 65;
  for (unsigned bits = 0; bits <= 8; ++bits) {
    std::vector<int8_t> w(385 * 65);
    for (size_t i = 0; i < w.size(); ++i)
      w[i] = bits == 0 ? -7 : bits == 8 ? (int)((i * 17) % 239) - 119 :
          (int)((i * 17) % (1u << bits)) - (int)(1u << (bits - 1));
    auto *s = sh_compact_create(w.data(), 65, 385); assert(s);
    assert(s->chunks[0][0] == (bits == 8 ? 255 : bits));
    for (size_t off : {size_t(0), size_t(1), size_t(63), size_t(64), size_t(65),
                       chunk - 1, chunk, chunk + 1, w.size() - 1, w.size()}) {
      for (size_t n : {size_t(0), size_t(1), size_t(2), size_t(63), size_t(64),
                       size_t(65), size_t(127), w.size() - off}) {
        if (n > w.size() - off) continue;
        check_read_window(s, w, off, n); ++cases;
      }
    }
    uint8_t untouched = 0xa5;
    assert(sh_compact_read(nullptr, 0, &untouched, 1) == SH_ERR_RANGE);
    assert(sh_compact_read(s, 0, nullptr, 0) == SH_ERR_RANGE);
    assert(sh_compact_read(s, UINT64_MAX, &untouched, 0) == SH_ERR_RANGE);
    assert(sh_compact_read(s, w.size() + 1, &untouched, 0) == SH_ERR_RANGE);
    assert(sh_compact_read(s, w.size(), &untouched, 1) == SH_ERR_RANGE);
    assert(untouched == 0xa5);
    // Reads of one early byte must still reject malformed later frames in
    // that chunk. The requested output is wiped, with both guards intact.
    const auto saved = s->chunks[0];
    for (int fault = 0; fault < 3; ++fault) {
      if (fault == 0) s->chunks[0][saved.size() - (bits == 8 ? 65 : 2 + bits * 8)] = 254;
      if (fault == 1) s->chunks[0].pop_back();
      if (fault == 2) s->chunks[0].push_back(0);
      uint8_t out[] = {0xa5, 0x5a, 0xa5};
      assert(sh_compact_read(s, 1, out + 1, 1) == SH_ERR_VERIFY);
      assert(out[0] == 0xa5 && out[1] == 0 && out[2] == 0xa5);
      s->chunks[0] = saved;
    }
    std::vector<std::thread> readers;
    for (size_t t = 0; t < 4; ++t) readers.emplace_back([&, t] {
      for (size_t i = 0; i < 16; ++i) check_read_window(s, w, 63 + t + i, 127);
    });
    for (auto &reader : readers) reader.join();
    s->chunks.back().clear();
    uint8_t out[] = {0xa5, 0x5a, 0x5a, 0xa5};
    assert(sh_compact_read(s, chunk - 1, out + 1, 2) == SH_ERR_VERIFY);
    assert(out[0] == 0xa5 && out[1] == 0 && out[2] == 0 && out[3] == 0xa5);
    sh_compact_free(s);
  }
  return cases;
}
static void scratch_shapes() {
  unsigned cases=0;
  for (int N : {1,16,32,48,383,384,385}) for (int b : {1,4,16,31,32,64}) {
    // Fresh worker: retained scratch from an earlier wider matrix must not
    // hide over-allocation in this shape. Thread exit also checks its wipe.
    std::thread worker([=] {
      const int K=65, stride=N+3;
      std::vector<int8_t> w(K*N);
      for (size_t i=0; i<w.size(); ++i) w[i]=(int)((i*17)%239)-119;
      auto *s=sh_compact_create(w.data(),K,N); assert(s);
      std::vector<int32_t> r(b*K),u(b*stride,INT32_MIN),want(b*stride,INT32_MIN);
      for (size_t i=0; i<r.size(); ++i) r[i]=(i*7919+12345)%SH_M_MOD;
      for (int row=0; row<b; ++row) for (int j=0; j<N; ++j) {
        int64_t sum=0;
        for (int k=0; k<K; ++k) sum+=(int64_t)r[row*K+k]*w[j*K+k];
        want[row*stride+j]=sh_balanced(sum);
      }
      omp_set_num_threads(3);
      assert(sh_compact_refill(s,r.data(),b,u.data(),stride)==SH_OK);
      assert(omp_get_max_threads()==3 && u==want);
      const size_t rows=std::min(N,384);
      assert(scratch.block.size()==384*K && scratch.block.capacity()==384*K);
      const size_t accum=(b>=32?3*b:12)*rows;
      assert(scratch.accum.size()==accum && scratch.accum.capacity()==accum);
      assert(scratch.planes.size()==(size_t)3*b*K);
      if (b>4 && b<32) {
        // The native CRT fallback must remain exact with only 12*rows scratch.
        std::fill(u.begin(),u.end(),INT32_MIN); denied_refill_allocations=0; deny_refill_allocation=true;
        const int rc=sh_compact_refill(s,r.data(),b,u.data(),stride);
        deny_refill_allocation=false;
        assert(rc==SH_OK && u==want && omp_get_max_threads()==3 && denied_refill_allocations>0);
      }
      for (int32_t invalid : {int32_t(-1),int32_t(SH_M_MOD)}) {
        r[0]=invalid; assert(sh_compact_refill(s,r.data(),b,u.data(),stride)==SH_ERR_VERIFY);
        for (int row=0; row<b; ++row) {
          for (int j=0; j<N; ++j) assert(u[row*stride+j]==0);
          for (int j=N; j<stride; ++j) assert(u[row*stride+j]==INT32_MIN);
        }
        assert(omp_get_max_threads()==3);
      }
      sh_compact_free(s);
    });
    worker.join(); ++cases;
  }
  printf("compact-runtime: %u bounded scratch shapes, native OOM fallback and invalid-mask wipes passed\n",cases);
}
static void admission_comparisons() {
  unsigned cases=0;
  for (size_t n : {size_t(1),size_t(2),size_t(63),size_t(64),size_t(65),size_t(127),size_t(384*65),size_t(385*65)})
    for (unsigned bits=0; bits<=8; ++bits) {
      std::vector<int8_t> w(n);
      for (size_t i=0; i<n; ++i)
        w[i]=bits==0?-7:bits==8?(int)((i*17)%239)-119:
             (int)((i*17)%(1u<<bits))-(int)(1u<<(bits-1));
      auto packed=pack_bits(w.data(),n);
      assert((unpack_bits<false,true>(packed.data(),packed.size(),w.data(),n)));
      for (size_t at : {size_t(0),n/2,n-1}) {
        w[at]^=1;
        assert((!unpack_bits<false,true>(packed.data(),packed.size(),w.data(),n)));
        w[at]^=1;
      }
      const auto good=packed;
      packed[0]=254;
      assert((!unpack_bits<false,true>(packed.data(),packed.size(),w.data(),n)));
      packed=good; packed.pop_back();
      assert((!unpack_bits<false,true>(packed.data(),packed.size(),w.data(),n)));
      packed=good; packed.push_back(0);
      assert((!unpack_bits<false,true>(packed.data(),packed.size(),w.data(),n)));
      ++cases;
    }
  printf("compact-runtime: %u direct admission comparisons, source mismatches and malformed frames passed\n",cases);
}
int main(){
  __builtin_cpu_init();if(!__builtin_cpu_supports("avx512vnni"))return 77;
  admission_comparisons();
  printf("compact-runtime: %u guarded read windows, all bit widths, malformed tails and shared-store readers passed\n",read_window_cases());
  scratch_shapes();
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
