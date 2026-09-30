// Research-only private-RAM representation. Reuse the offline model encoder.
#define main streamed_fixture_main
#include "streamed-refill.cpp"
#undef main
#include <immintrin.h>
#include <lz4.h>
#include <set>
#include <sstream>
#include <unordered_map>
#include <zstd.h>
#ifdef COMPACT_DNNL
#include <oneapi/dnnl/dnnl.h>
static void dnnl_refill(const uint8_t *p, int b, const int8_t *w, int64_t K,
                        int64_t N, int32_t *u, int64_t stride, int32_t *) {
  require(K > 0 && K <= 65536 && b > 0 && b <= 512 && N > 0 && stride >= N,
          "oneDNN radix bounds");
  std::vector<int32_t> tmp((size_t)3 * b * N);
  int32_t co = 0;
  require(dnnl_gemm_u8s8s32('N', 'T', 'F', 3 * b, N, K, 1.0f, p, K, 0, w, K, 0,
                            0.0f, tmp.data(), N, &co) == dnnl_success,
          "oneDNN gemm");
  for (int i = 0; i < b; i++)
    for (int64_t j = 0; j < N; j++) {
      int64_t x = (int64_t)tmp[(size_t)i * N + j] +
                  256 * (int64_t)tmp[(size_t)(b + i) * N + j] +
                  65536 * (int64_t)tmp[(size_t)(2 * b + i) * N + j];
      int64_t z = x % SH_M_MOD;
      z += (z < 0) * SH_M_MOD;
      u[(int64_t)i * stride + j] = (int32_t)(z - (z > SH_HALF_M) * SH_M_MOD);
    }
}
#endif

extern "C" void sh_simd_radix_refill_vector_crt(const uint8_t *, int,
                                                const int8_t *, int64_t,
                                                int64_t, int32_t *, int64_t,
                                                int32_t *);
// Byte-plane outer products: SIMD lanes are output columns, so no horizontal
// reduction is needed per result. All planes remain private radix-256 bytes.
static void outer_refill(const uint8_t *p, int b, const int8_t *w, int64_t K,
                         int64_t N, int32_t *u, int64_t stride,
                         int32_t *scratch) {
  if (K % 16 || N % 16 || b % 8) {
    sh_simd_radix_refill_vector_crt(p, b, w, K, N, u, stride, scratch);
    return;
  }
  const int64_t kp = (K + 3) & ~INT64_C(3);
  std::vector<int8_t> packed((size_t)kp * 16, 0);
  for (int64_t j = 0; j < N; j += 16) {
    constexpr int cols = 16;
    if (K % 16 == 0 && cols == 16) {
      for (int c = 0; c < 16; c += 4)
        for (int64_t k = 0; k < K; k += 16) {
          __m128i a = _mm_loadu_si128((const __m128i *)(w + (j + c) * K + k)),
                  bb = _mm_loadu_si128(
                      (const __m128i *)(w + (j + c + 1) * K + k));
          __m128i cc = _mm_loadu_si128(
                      (const __m128i *)(w + (j + c + 2) * K + k)),
                  d = _mm_loadu_si128(
                      (const __m128i *)(w + (j + c + 3) * K + k));
          __m128i t0 = _mm_unpacklo_epi32(a, bb),
                  t1 = _mm_unpackhi_epi32(a, bb),
                  t2 = _mm_unpacklo_epi32(cc, d),
                  t3 = _mm_unpackhi_epi32(cc, d);
          _mm_storeu_si128((__m128i *)(packed.data() + k * 16 + c * 4),
                           _mm_unpacklo_epi64(t0, t2));
          _mm_storeu_si128((__m128i *)(packed.data() + (k + 4) * 16 + c * 4),
                           _mm_unpackhi_epi64(t0, t2));
          _mm_storeu_si128((__m128i *)(packed.data() + (k + 8) * 16 + c * 4),
                           _mm_unpacklo_epi64(t1, t3));
          _mm_storeu_si128((__m128i *)(packed.data() + (k + 12) * 16 + c * 4),
                           _mm_unpackhi_epi64(t1, t3));
        }
    } else {
      std::fill(packed.begin(), packed.end(), 0);
      for (int64_t k = 0; k < K; k++)
        for (int c = 0; c < cols; c++)
          packed[(k / 4) * 64 + c * 4 + k % 4] = w[(j + c) * K + k];
    }
    for (int m = 0; m < b; m += 8) {
      __m512i sums[3][8];
      for (auto &plane : sums)
        for (auto &x : plane)
          x = _mm512_setzero_si512();
      for (int64_t k = 0; k < kp; k += 4) {
        __m512i weights = _mm512_loadu_si512(packed.data() + k * 16);
        for (int plane = 0; plane < 3; plane++)
          for (int row = 0; row < 8; row++) {
            int mr = m + row;
            uint32_t x;
            memcpy(&x, p + ((size_t)plane * b + mr) * K + k, 4);
            sums[plane][row] = _mm512_dpbusd_epi32(
                sums[plane][row], _mm512_set1_epi32(x), weights);
          }
      }
      alignas(64) int32_t tmp[3][16];
      for (int row = 0; row < 8 && m + row < b; row++) {
        for (int plane = 0; plane < 3; plane++)
          _mm512_store_si512(tmp[plane], sums[plane][row]);
        for (int c = 0; c < cols; c++) {
          int64_t x = (int64_t)tmp[0][c] + 256 * (int64_t)tmp[1][c] +
                      65536 * (int64_t)tmp[2][c];
          int64_t z = x % SH_M_MOD;
          z += (z < 0) * SH_M_MOD;
          u[(int64_t)(m + row) * stride + j + c] =
              (int32_t)(z - (z > SH_HALF_M) * SH_M_MOD);
        }
      }
    }
  }
}
static void radix_planes(const int32_t *r, size_t n, uint8_t *p) {
  for (size_t i = 0; i < n; i++) {
    uint32_t v = (uint32_t)((int64_t)r[i] + (r[i] < 0 ? SH_M_MOD : 0));
    p[i] = v;
    p[n + i] = v >> 8;
    p[2 * n + i] = v >> 16;
  }
}
static std::vector<uint8_t> pack_bits(const int8_t *w, size_t n) {
  std::vector<uint8_t> out;
  out.reserve(n);
  for (size_t i = 0; i < n; i += 64) {
    size_t len = std::min<size_t>(64, n - i);
    int lo = 127, hi = -128;
    for (size_t j = 0; j < len; j++) {
      lo = std::min(lo, (int)w[i + j]);
      hi = std::max(hi, (int)w[i + j]);
    }
    unsigned bits = 0;
    while ((1u << bits) <= (unsigned)(hi - lo))
      bits++;
    __mmask64 mask = len == 64 ? UINT64_MAX : ((1ULL << len) - 1);
    __m512i v = _mm512_maskz_loadu_epi8(mask, w + i);
    if (bits == 8) {
      out.push_back(255);
      size_t off = out.size();
      out.resize(off + 64);
      _mm512_storeu_si512(out.data() + off, v);
      continue;
    }
    out.push_back(bits);
    out.push_back((uint8_t)lo);
    v = _mm512_sub_epi8(v, _mm512_set1_epi8(lo));
    for (unsigned b = 0; b < bits; b++) {
      uint64_t plane =
          _mm512_movepi8_mask(_mm512_sllv_epi64(v, _mm512_set1_epi64(7 - b)));
      size_t off = out.size();
      out.resize(off + 8);
      memcpy(out.data() + off, &plane, 8);
    }
  }
  out.shrink_to_fit();
  return out;
}
static bool unpack_bits(const uint8_t *src, size_t size, int8_t *w, size_t n) {
  size_t pos = 0;
  for (size_t i = 0; i < n; i += 64) {
    if (pos == size)
      return false;
    unsigned bits = src[pos++];
    __m512i v;
    if (bits == 255) {
      if (size - pos < 64)
        return false;
      v = _mm512_loadu_si512(src + pos);
      pos += 64;
    } else {
      if (bits > 7 || size - pos < 1 + bits * 8)
        return false;
      int8_t base = (int8_t)src[pos++];
      v = _mm512_setzero_si512();
      for (unsigned b = 0; b < bits; b++) {
        uint64_t plane;
        memcpy(&plane, src + pos, 8);
        pos += 8;
        v = _mm512_or_si512(v, _mm512_maskz_set1_epi8(plane, (char)(1 << b)));
      }
      v = _mm512_add_epi8(v, _mm512_set1_epi8(base));
    }
    size_t len = std::min<size_t>(64, n - i);
    __mmask64 mask = len == 64 ? UINT64_MAX : ((1ULL << len) - 1);
    _mm512_mask_storeu_epi8(w + i, mask, v);
  }
  return pos == size;
}
struct compact_weights {
  std::string codec;
  int64_t K, N, rows;
  size_t bytes = 0;
  std::vector<std::array<uint8_t, 16>> palettes;
  std::vector<std::vector<uint8_t>> chunks;
  compact_weights(const std::vector<int8_t> &w, int64_t k, int64_t n,
                  const std::string &c, int tile)
      : codec(c), K(k), N(n), rows(tile) {
    std::unordered_map<std::string, uint32_t> ids;
    for (int64_t j = 0; j < N; j += rows) {
      size_t len = std::min(rows, N - j) * K;
      const int8_t *src = w.data() + j * K;
      std::vector<uint8_t> dst;
      if (c == "bits")
        dst = pack_bits(src, len);
      else if (c == "lz4") {
        dst.resize(LZ4_compressBound((int)len));
        int z = LZ4_compress_default((const char *)src, (char *)dst.data(), len,
                                     dst.size());
        require(z > 0, "lz4 encode");
        dst.resize(z);
      } else if (c == "zstd") {
        dst.resize(ZSTD_compressBound(len));
        size_t z = ZSTD_compress(dst.data(), dst.size(), src, len, 1);
        require(!ZSTD_isError(z), "zstd encode");
        dst.resize(z);
      } else if (c == "palette") {
        for (size_t k = 0; k < len; k += 32) {
          size_t n = std::min<size_t>(32, len - k);
          std::array<int8_t, 32> vals{};
          memcpy(vals.data(), src + k, n);
          std::sort(vals.begin(), vals.begin() + n);
          auto end = std::unique(vals.begin(), vals.begin() + n);
          int count = end - vals.begin();
          if (count > 16) {
            dst.push_back(255);
            dst.insert(dst.end(), (const uint8_t *)src + k,
                       (const uint8_t *)src + k + n);
            continue;
          }
          int base = vals[0], g = 0;
          for (int t = 1; t < count; t++)
            g = std::gcd(g, (int)vals[t] - base);
          std::array<uint8_t, 16> pal{};
          if (g > 0 && ((int)vals[count - 1] - base) / g < 16) {
            for (int t = 0; t < 16; t++)
              pal[t] = std::min(255, t * g);
          } else {
            for (int t = 0; t < 16; t++)
              pal[t] = (uint8_t)((int)vals[std::min(t, count - 1)] - base);
          }
          std::string key((const char *)pal.data(), 16);
          auto it = ids.find(key);
          uint32_t id;
          if (it == ids.end()) {
            require(palettes.size() < 0xffffff, "palette dictionary full");
            id = palettes.size();
            palettes.push_back(pal);
            ids.emplace(key, id);
          } else
            id = it->second;
          dst.push_back(0);
          dst.push_back((uint8_t)base);
          for (int t = 0; t < 3; t++)
            dst.push_back(id >> (8 * t));
          uint8_t indexes[16] = {};
          for (size_t t = 0; t < n; t++) {
            int v = (int)src[k + t] - base, code = 0;
            while (code < 16 && pal[code] != v)
              code++;
            require(code < 16, "palette encode");
            indexes[t % 16] |= code << (t >= 16 ? 4 : 0);
          }
          dst.insert(dst.end(), indexes, indexes + 16);
        }
      } else
        throw std::runtime_error("codec");
      dst.shrink_to_fit();
      bytes += dst.capacity();
      chunks.push_back(std::move(dst));
    }
    palettes.shrink_to_fit();
    bytes += chunks.capacity() * sizeof(chunks[0]) + palettes.capacity() * 16;
  }
  bool decode(size_t c, int8_t *dst, size_t n) const {
    auto &s = chunks[c];
    if (codec == "bits")
      return unpack_bits(s.data(), s.size(), dst, n);
    if (codec == "lz4")
      return LZ4_decompress_safe((const char *)s.data(), (char *)dst, s.size(),
                                 n) == (int)n;
    if (codec == "palette") {
      size_t pos = 0;
      for (size_t k = 0; k < n; k += 32) {
        size_t len = std::min<size_t>(32, n - k);
        if (pos >= s.size())
          return false;
        int tag = s[pos++];
        if (tag == 255) {
          if (s.size() - pos < len)
            return false;
          memcpy(dst + k, s.data() + pos, len);
          pos += len;
          continue;
        }
        if (tag != 0 || s.size() - pos < 20)
          return false;
        uint8_t base = s[pos++];
        uint32_t id =
            s[pos] | ((uint32_t)s[pos + 1] << 8) | ((uint32_t)s[pos + 2] << 16);
        pos += 3;
        if (id >= palettes.size())
          return false;
        __m128i packed = _mm_loadu_si128((const __m128i *)(s.data() + pos));
        pos += 16;
        __m256i ix = _mm256_broadcastsi128_si256(packed);
        ix = _mm256_srlv_epi32(ix, _mm256_set_epi32(4, 4, 4, 4, 0, 0, 0, 0));
        ix = _mm256_and_si256(ix, _mm256_set1_epi8(15));
        __m256i lut = _mm256_broadcastsi128_si256(
            _mm_loadu_si128((const __m128i *)palettes[id].data()));
        __m256i v = _mm256_add_epi8(_mm256_shuffle_epi8(lut, ix),
                                    _mm256_set1_epi8(base));
        if (len == 32)
          _mm256_storeu_si256((__m256i *)(dst + k), v);
        else {
          alignas(32) int8_t tmp[32];
          _mm256_store_si256((__m256i *)tmp, v);
          memcpy(dst + k, tmp, len);
        }
      }
      return pos == s.size();
    }
    size_t z = ZSTD_decompress(dst, n, s.data(), s.size());
    return !ZSTD_isError(z) && z == n;
  }
  bool compute(const uint8_t *p, int b, int32_t *u, kernel_fn kernel) const {
    std::vector<int8_t> block((size_t)rows * K);
    std::vector<int32_t> acc(12 * rows);
    for (size_t c = 0; c < chunks.size(); c++) {
      int64_t j = c * rows, nr = std::min(rows, N - j);
      if (!decode(c, block.data(), nr * K)) {
        memset(u, 0, (size_t)b * N * 4);
        return false;
      }
      kernel(p, b, block.data(), K, nr, u + j, N, acc.data());
    }
    return true;
  }
};
// One product's private boundary block; never reused across products. Only the
// sequential prefetch reader accesses it, not the concurrent compute thread.
struct boundary_reader {
  file_cache &cache;
  std::vector<uint8_t> block =
      std::vector<uint8_t>(sh_weight_cache::block_bytes);
  uint64_t index = UINT64_MAX;
  int read(uint64_t off, uint8_t *out, size_t n) {
    if (off > cache.bytes || n > cache.bytes - off)
      return -1;
    while (n) {
      uint64_t bi = off / sh_weight_cache::block_bytes;
      uint64_t start = bi * sh_weight_cache::block_bytes;
      size_t count =
          std::min<uint64_t>(sh_weight_cache::block_bytes, cache.bytes - start);
      if (index != bi) {
        index = UINT64_MAX;
        if (cache.read(start, block.data(), count, true, true, false))
          return -1;
        index = bi;
      }
      size_t skip = off - start, take = std::min(n, count - skip);
      memcpy(out, block.data() + skip, take);
      out += take;
      off += take;
      n -= take;
    }
    return 0;
  }
};
static void compact_tests() {
  size_t cases = 0;
  for (int K : {1, 63, 64, 65, 5120, 17408, 65536})
    for (int N : {1, 16, 17, 32})
      for (int b : {1, 5, 16, 64}) {
        std::vector<int8_t> w((size_t)K * N);
        for (auto &x : w)
          x = (int)(next32() % 239) - 119;
        std::vector<int32_t> r((size_t)b * K);
        for (size_t i = 0; i < r.size(); i++)
          r[i] = i % 4 == 0   ? SH_M_MOD - 1
                 : i % 4 == 1 ? -SH_HALF_M
                 : i % 4 == 2 ? 0
                              : next32() % SH_M_MOD;
        std::vector<uint8_t> p(r.size() * 3);
        radix_planes(r.data(), r.size(), p.data());
        std::vector<int32_t> u((size_t)b * N), acc(12 * N);
        sh_simd_radix_refill_vector_crt(p.data(), b, w.data(), K, N, u.data(),
                                        N, acc.data());
        for (int row = 0; row < b; row++)
          for (int j = 0; j < N; j++) {
            int64_t z = 0;
            for (int k = 0; k < K; k++)
              z += (int64_t)r[(size_t)row * K + k] * w[(size_t)j * K + k];
            require(u[(size_t)row * N + j] == sh_balanced(z), "radix oracle");
          }
        auto want = u;
        outer_refill(p.data(), b, w.data(), K, N, u.data(), N, acc.data());
        require(u == want, "outer oracle");
#ifdef COMPACT_DNNL
        dnnl_refill(p.data(), b, w.data(), K, N, u.data(), N, acc.data());
        require(u == want, "oneDNN oracle");
#endif
        for (auto codec : {"bits", "lz4", "zstd", "palette"}) {
          compact_weights cw(w, K, N, codec, 12);
          require(cw.compute(p.data(), b, u.data(),
                             sh_simd_radix_refill_vector_crt) &&
                      u == want,
                  "compact product");
          cases++;
        }
      }
  for (int len : {1, 63, 64, 65, 127, 128, 129, 4097})
    for (int spread : {0, 1, 3, 15, 31, 63, 127, 238}) {
      std::vector<int8_t> w(len);
      for (auto &x : w)
        x = (int)(next32() % (spread + 1)) - 119;
      auto p = pack_bits(w.data(), w.size());
      std::vector<int8_t> d(w.size());
      require(unpack_bits(p.data(), p.size(), d.data(), d.size()) && d == w,
              "bit roundtrip");
      p.pop_back();
      require(!unpack_bits(p.data(), p.size(), d.data(), d.size()),
              "truncated bits accepted");
    }
  // Worst signed weights and maximum admitted K must not overflow lanes.
  for (int v : {-119, 119}) {
    int K = 65536, N = 17, b = 5;
    std::vector<int8_t> w((size_t)K * N, v);
    std::vector<int32_t> r((size_t)b * K, SH_M_MOD - 1),
        u((size_t)b * (N + 5), INT32_MIN), a(12 * N);
    std::vector<uint8_t> p(r.size() * 3);
    radix_planes(r.data(), r.size(), p.data());
    std::vector<kernel_fn> kernels{sh_simd_radix_refill_vector_crt,
                                   outer_refill};
#ifdef COMPACT_DNNL
    kernels.push_back(dnnl_refill);
#endif
    for (auto kernel : kernels) {
      kernel(p.data(), b, w.data(), K, N, u.data(), N + 5, a.data());
      for (int i = 0; i < b; i++) {
        for (int j = 0; j < N; j++)
          require(u[i * (N + 5) + j] ==
                      sh_balanced((int64_t)(SH_M_MOD - 1) * K * v),
                  "radix overflow");
        for (int j = N; j < N + 5; j++)
          require(u[i * (N + 5) + j] == INT32_MIN, "output stride overwritten");
      }
    }
  }
  {
    std::vector<int8_t> w((1 << 20) + 4096, 37);
    file_cache cache;
    cache.create("/tmp", w);
    boundary_reader reader{cache};
    std::vector<uint8_t> out(w.size());
    require(reader.read(0, out.data(), 17) == 0, "boundary initial read");
    uint8_t bad = 99;
    require(pwrite(cache.fd, &bad, 1, 20) == 1, "boundary mutate fixture");
    require(reader.read(17, out.data() + 17, (1 << 20) - 17) == 0,
            "private boundary reuse");
    for (size_t i = 0; i < (1 << 20); i++)
      require(out[i] == 37, "boundary private data changed");
    require(pwrite(cache.fd, &bad, 1, 1 << 20) == 1, "late boundary mutate");
    require(reader.read(1 << 20, out.data(), 4096) != 0,
            "boundary late tamper accepted");
    boundary_reader fresh{cache};
    require(fresh.read(0, out.data(), 17) != 0,
            "boundary survived product reset");
  }
  std::cout
      << "{\"compact_oracle_cases\":" << cases
      << ",\"bit_roundtrip_and_truncation\":true,\"radix_extremes\":true}\n";
}
int main(int argc, char **argv) {
  try {
    __builtin_cpu_init();
    if (!__builtin_cpu_supports("avx512vnni") ||
        !__builtin_cpu_supports("avx512bw") ||
        !__builtin_cpu_supports("avx512dq") ||
        !__builtin_cpu_supports("avx512vl"))
      return 77;
#ifndef COMPACT_DNNL
    require(!getenv("COMPACT_ONEDNN"), "oneDNN support was not compiled");
#endif
    if (argc == 2 && std::string(argv[1]) == "--test") {
      compact_tests();
      return 0;
    }
    if (argc == 4 && std::string(argv[1]) == "--inventory") {
      std::ifstream cal(argv[3]);
      require(bool(cal), "calibration file");
      std::string line;
      std::set<std::string> names;
      while (std::getline(cal, line)) {
        std::istringstream row(line);
        std::string kind, name;
        row >> kind >> name;
        if (kind == "site")
          names.insert(name);
      }
      for (const auto &name : names) {
        std::vector<int8_t> w;
        int64_t K, N;
        encode_model(argv[2], name.c_str(), w, K, N);
        compact_weights cw(w, K, N, "bits", 384);
        std::vector<int8_t> decoded((size_t)384 * K);
        for (size_t c = 0; c < cw.chunks.size(); c++) {
          size_t n = std::min<int64_t>(384, N - c * 384) * K;
          require(cw.decode(c, decoded.data(), n) &&
                      memcmp(decoded.data(), w.data() + c * 384 * K, n) == 0,
                  "inventory byte mismatch");
        }
        std::cout << "{\"tensor\":\"" << name << "\",\"K\":" << K
                  << ",\"N\":" << N << ",\"encoded_bytes\":" << w.size()
                  << ",\"compact_bytes\":" << cw.bytes << ",\"exact\":true}"
                  << std::endl;
      }
      return 0;
    }
    require(argc == 7,
            "usage: compact MODEL TENSOR BATCH REPS CODEC TILE_ROWS");
    int b = std::stoi(argv[3]), reps = std::stoi(argv[4]),
        tile = std::stoi(argv[6]);
    require(b > 0 && b <= 512 && reps > 0 && reps <= 12 && tile > 0 &&
                tile <= 1024,
            "bounds");
    std::vector<int8_t> w;
    int64_t K, N;
    encode_model(argv[1], argv[2], w, K, N);
    require(K <= 65536, "radix K overflow guard");
    std::vector<int32_t> r((size_t)b * K);
    for (auto &x : r)
      x = next32() % SH_M_MOD;
    std::vector<uint8_t> p(r.size() * 3), rp(p.size());
    sh_simd_avx512_pad_planes(r.data(), r.size(), p.data(), p.data() + r.size(),
                              p.data() + 2 * r.size());
    radix_planes(r.data(), r.size(), rp.data());
    std::vector<int32_t> u((size_t)b * N), ref(u.size()), acc(12 * N);
    sh_simd_avx512_refill_vector_crt(p.data(), b, w.data(), K, N, ref.data(), N,
                                     acc.data());
    std::unique_ptr<compact_weights> cw;
    std::unique_ptr<file_cache> fc;
    const bool stream_gmac = std::string(argv[5]) == "stream-gmac";
    require(!stream_gmac || !getenv("COMPACT_BOUNDARY_CACHE"),
            "boundary cache is SHA-256 only");
    if (stream_gmac || std::string(argv[5]) == "stream-sha256") {
      require(getenv("COMPACT_CACHE_DIR"), "NVMe cache directory required");
      fc.reset(new file_cache);
      fc->create(getenv("COMPACT_CACHE_DIR"), w);
    } else {
      cw.reset(new compact_weights(w, K, N, argv[5], tile));
      std::vector<int8_t> decode((size_t)tile * K);
      for (size_t c = 0; c < cw->chunks.size(); c++) {
        size_t n = std::min<int64_t>(tile, N - c * tile) * K;
        require(cw->decode(c, decode.data(), n) &&
                    memcmp(decode.data(), w.data() + c * tile * K, n) == 0,
                "not lossless");
      }
    }
    kernel_fn candidate = getenv("COMPACT_OUTER")
                              ? outer_refill
                              : sh_simd_radix_refill_vector_crt;
#ifdef COMPACT_DNNL
    if (getenv("COMPACT_ONEDNN"))
      candidate = dnnl_refill;
#endif
    const int stream_mib = getenv("COMPACT_STREAM_MIB")
                               ? std::stoi(getenv("COMPACT_STREAM_MIB"))
                               : 8;
    require(stream_mib >= 1 && stream_mib <= 32, "stream buffer bound");
    const size_t weight_bytes = w.size();
    const bool released = getenv("COMPACT_RELEASE") != nullptr;
    if (released) {
      uint64_t before = rss_kib();
      std::vector<int8_t>().swap(w);
      malloc_trim(0);
      std::cerr << "{\"released_encoded_bytes\":" << weight_bytes
                << ",\"before_rss_kib\":" << before
                << ",\"after_rss_kib\":" << rss_kib() << "}" << std::endl;
    }
    for (int rep = 0; rep < reps; rep++) {
      double ms[4] = {-1, -1, -1, -1}, cpu[4] = {-1, -1, -1, -1};
      uint64_t io[4] = {};
      for (int q = 0; q < 4; q++) {
        int mode = rep % 2 ? 3 - q : q;
        if (released && mode < 2)
          continue;
        if (fc && mode >= 2)
          fc->cold();
        uint64_t before_io = disk_bytes();
        double c = cpu_now(), t = now();
        if (mode < 2)
          (mode ? candidate : sh_simd_avx512_refill_vector_crt)(
              (mode ? rp : p).data(), b, w.data(), K, N, u.data(), N,
              acc.data());
        else if (cw)
          require(cw->compute((mode == 3 ? rp : p).data(), b, u.data(),
                              mode == 3 ? candidate
                                        : sh_simd_avx512_refill_vector_crt),
                  "decode failed");
        else {
          metrics m;
          std::unique_ptr<boundary_reader> boundary;
          if (getenv("COMPACT_BOUNDARY_CACHE"))
            boundary.reset(new boundary_reader{*fc});
          require(refill(
                      [&](uint64_t off, uint8_t *dst, size_t n) {
                        return boundary ? boundary->read(off, dst, n)
                                        : fc->read(off, dst, n, true, true,
                                                   stream_gmac);
                      },
                      (mode == 3 ? rp : p).data(), b, K, N, u.data(), N,
                      (size_t)stream_mib << 20,
                      mode == 3 ? candidate : sh_simd_avx512_refill_vector_crt,
                      true, m),
                  "authenticated stream failed");
        }
        ms[mode] = now() - t;
        cpu[mode] = cpu_now() - c;
        io[mode] = disk_bytes() - before_io;
        require(u == ref, "product differs");
      }
      std::cout << "{\"tensor\":\"" << argv[2] << "\",\"batch\":" << b
                << ",\"rep\":" << rep << ",\"codec\":\"" << argv[5]
                << "\",\"kernel\":\""
                << (getenv("COMPACT_ONEDNN")  ? "onednn-radix"
                    : getenv("COMPACT_OUTER") ? "outer-radix"
                                              : "radix")
                << "\",\"released\":" << (released ? "true" : "false")
                << ",\"boundary_cache\":"
                << (getenv("COMPACT_BOUNDARY_CACHE") ? "true" : "false")
                << ",\"stream_mib\":" << stream_mib << ",\"tile\":" << tile
                << ",\"encoded_bytes\":" << weight_bytes
                << ",\"compact_bytes\":" << (cw ? cw->bytes : 0)
                << ",\"resident_s\":" << ms[0] << ",\"radix_s\":" << ms[1]
                << ",\"compact_crt_s\":" << ms[2]
                << ",\"compact_radix_s\":" << ms[3]
                << ",\"resident_cpu_s\":" << cpu[0]
                << ",\"compact_cpu_s\":" << cpu[3]
                << ",\"candidate_disk_read_bytes\":" << io[3]
                << ",\"exact\":true}" << std::endl;
    }
    return 0;
  } catch (const std::exception &e) {
    std::cerr << e.what() << "\n";
    return 1;
  }
}
