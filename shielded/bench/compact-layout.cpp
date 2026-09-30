// OFFLINE only: deterministic public masks are reused for timing, never for
// inference.
#define main fixture_unused_main
#include "streamed-refill.cpp"
#undef main
#include "../../wasm/ggml-shielded/shielded-compact.h"
#include <atomic>
#include <barrier>
#include <thread>
#define API(P)                                                                 \
  extern "C" void *P##_compact_create(const int8_t *, int64_t, int64_t);       \
  extern "C" void P##_compact_free(void *);                                    \
  extern "C" int P##_compact_refill(void *, const int32_t *, int, int32_t *,   \
                                    int64_t);
API(base) API(prepack) API(primitive) struct api {
  const char *name;
  void *(*create)(const int8_t *, int64_t, int64_t);
  void (*free)(void *);
  int (*refill)(void *, const int32_t *, int, int32_t *, int64_t);
};
#define ROW(P) {#P, P##_compact_create, P##_compact_free, P##_compact_refill}
int main(int argc, char **argv) {
  try {
    __builtin_cpu_init();
    if (!__builtin_cpu_supports("avx512vnni") ||
        !__builtin_cpu_supports("avx512bw") ||
        !__builtin_cpu_supports("avx512dq") ||
        !__builtin_cpu_supports("avx512vl"))
      return 77;
    require(argc == 6, "PUBLIC_MODEL TENSOR WORKERS REPS COLUMN_SPLIT(1|2)");
    int nt = std::stoi(argv[3]), reps = std::stoi(argv[4]);
    require(nt >= 1 && nt <= 8 && reps > 0 && reps <= 30, "bounds");
    int split = std::stoi(argv[5]);
    require(split == 1 || split == 2, "split");
    const int b = 64;
    std::vector<int8_t> w;
    int64_t K, N;
    encode_model(argv[1], argv[2], w, K, N);
    require(w.size() * (3 * nt + 2) / split < (uint64_t(7) << 30),
            "bounded fixture");
    require(K % split == 0, "even split");
    int64_t oldK = K;
    K /= split;
    for (int64_t row = 0; row < N; ++row)
      memmove(w.data() + row * K, w.data() + row * oldK, K);
    w.resize((size_t)K * N);
    api modes[] = {ROW(base), ROW(prepack), ROW(primitive)};
    struct fixture {
      void *stores[3];
      std::vector<int32_t> r, want, got;
    };
    std::vector<fixture> fixtures(nt);
    for (auto &f : fixtures) {
      for (int a = 0; a < 3; a++) {
        f.stores[a] = modes[a].create(w.data(), K, N);
        require(f.stores[a], "admit");
      }
      f.r.resize((size_t)b * K);
      f.want.resize((size_t)b * N);
      f.got.resize(f.want.size());
      for (auto &x : f.r)
        x = next32() % SH_M_MOD;
      std::vector<uint8_t> planes(f.r.size() * 3);
      std::vector<int32_t> acc(12 * N);
      sh_simd_avx512_pad_planes(f.r.data(), f.r.size(), planes.data(),
                                planes.data() + f.r.size(),
                                planes.data() + 2 * f.r.size());
      sh_simd_avx512_refill_vector_crt(planes.data(), b, w.data(), K, N,
                                       f.want.data(), N, acc.data());
    }
    std::barrier sync(nt + 1);
    std::atomic<bool> exact{true};
    std::vector<std::thread> th;
    for (int t = 0; t < nt; t++)
      th.emplace_back([&, t] {
        auto &f = fixtures[t];
        for (int rep = 0; rep < reps; rep++)
          for (int q = 0; q < 3; q++) {
            int a = (q + rep) % 3;
            sync.arrive_and_wait();
            int rc =
                modes[a].refill(f.stores[a], f.r.data(), b, f.got.data(), N);
            if (rc != SH_OK)
              exact = false;
            sync.arrive_and_wait();
            if (f.got != f.want)
              exact = false;
            sync.arrive_and_wait();
          }
      });
    for (int rep = 0; rep < reps; rep++)
      for (int q = 0; q < 3; q++) {
        int a = (q + rep) % 3;
        double t = now(), c = cpu_now();
        sync.arrive_and_wait();
        sync.arrive_and_wait();
        double wall = now() - t, cpu = cpu_now() - c;
        sync.arrive_and_wait();
        require(exact, "exact mismatch");
        std::cout << "{\"mode\":\"" << modes[a].name << "\",\"tensor\":\""
                  << argv[2] << "\",\"workers\":" << nt << ",\"rep\":" << rep
                  << ",\"seconds\":" << wall << ",\"cpu_s\":" << cpu
                  << ",\"exact\":true}" << std::endl;
      }
    for (auto &t : th)
      t.join();
    for (auto &f : fixtures)
      for (int a = 0; a < 3; a++)
        modes[a].free(f.stores[a]);
  } catch (const std::exception &e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}
