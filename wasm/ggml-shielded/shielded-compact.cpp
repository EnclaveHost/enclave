// Opt-in production candidate: exact private packing and CPU-only pad math.
#include "shielded-compact.h"
#include "shielded-field.h"
#include "shielded-simd.h"
#include <algorithm>
#include <cstring>
#include <immintrin.h>
#include <limits>
#include <omp.h>
#include <oneapi/dnnl/dnnl.h>
#include <stdexcept>
#include <type_traits>
#include <vector>
static void require(bool ok, const char *why) {
  if (!ok)
    throw std::runtime_error(why);
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
    // The frame's min/max already covers every source byte; validate once
    // here instead of a second scalar branch per weight during admission.
    require(lo >= -119 && hi <= 119, "weight bound");
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
template<bool window = false, bool compare = false>
static bool unpack_bits(const uint8_t *src, size_t size,
                        std::conditional_t<compare, const int8_t *, int8_t *> w, size_t n,
                        size_t skip = 0, size_t take = 0) {
  static_assert(!window || !compare, "admission compares the complete chunk");
  if constexpr (window)
    if (skip > n || take > n - skip) return false;
  size_t pos = 0;
  for (size_t i = 0; i < n; i += 64) {
    if (pos == size)
      return false;
    unsigned bits = src[pos++];
    const bool selected = !window ||
        (i + std::min<size_t>(64, n - i) > skip && i < skip + take);
    __m512i v;
    if (bits == 255) {
      if (size - pos < 64)
        return false;
      if constexpr (window) {
        if (!selected) { pos += 64; continue; }
      }
      v = _mm512_loadu_si512(src + pos);
      pos += 64;
    } else {
      if (bits > 7 || size - pos < 1 + bits * 8)
        return false;
      if constexpr (window) {
        if (!selected) { pos += 1 + bits * 8; continue; }
      }
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
    if constexpr (compare) {
      // Admission verifies every decoded byte directly against the source.
      // The mask excludes padding in the last frame; no decoded tile copy is
      // needed for the same exact round-trip check.
      if (_mm512_cmpneq_epi8_mask(v, _mm512_maskz_loadu_epi8(mask, w + i)) & mask)
        return false;
    } else if constexpr (window) {
      // Frames outside the window were still checked above, so a malformed
      // later frame fails the read and wipes even an already-written output.
      const size_t first = std::max(i, skip), last = std::min(i + len, skip + take);
      if (first < last) {
        if (first == i && last == i + len) {
          _mm512_mask_storeu_epi8(w + (first - skip), mask, v);
        } else {
          alignas(64) int8_t edge[64];
          _mm512_store_si512(edge, v);
          memcpy(w + (first - skip), edge + (first - i), last - first);
        }
      }
    } else {
      _mm512_mask_storeu_epi8(w + i, mask, v);
    }
  }
  return pos == size;
}

struct sh_compact_store {
  int64_t K, N, rows = 384;
  std::vector<std::vector<uint8_t>> chunks;
  size_t bytes = 0;
};
extern "C" sh_compact_store *sh_compact_create(const int8_t *w, int64_t K,
                                               int64_t N) {
  sh_compact_store *s = nullptr;
  try {
    __builtin_cpu_init();
    if (!__builtin_cpu_supports("avx512vnni") ||
        !__builtin_cpu_supports("avx512bw") ||
        !__builtin_cpu_supports("avx512vl") ||
        !__builtin_cpu_supports("avx512dq"))
      return nullptr;
    if (!w || K <= 0 || K > 65536 || N <= 0 || N > (1 << 20) ||
        uint64_t(K) * N > SIZE_MAX)
      return nullptr;
    s = new sh_compact_store;
    s->K = K;
    s->N = N;
    for (int64_t j = 0; j < N; j += s->rows) {
      size_t n = (size_t)std::min(s->rows, N - j) * K;
      auto packed = pack_bits(w + j * K, n);
      require(unpack_bits<false, true>(packed.data(), packed.size(), w + j * K, n),
              "lossless admission");
      s->bytes += packed.capacity();
      s->chunks.push_back(std::move(packed));
    }
    s->bytes += sizeof(*s) + s->chunks.capacity() * sizeof(s->chunks[0]);
    return s;
  } catch (...) {
    delete s;
    return nullptr;
  }
}
extern "C" void sh_compact_free(sh_compact_store *s) { delete s; }
extern "C" size_t sh_compact_bytes(const sh_compact_store *s) {
  return s ? s->bytes : 0;
}
extern "C" int sh_compact_read(void *ctx, uint64_t off, uint8_t *out,
                               size_t n) {
  auto *s = static_cast<sh_compact_store *>(ctx);
  if (!s || !out || off > uint64_t(s->K) * s->N ||
      n > uint64_t(s->K) * s->N - off)
    return SH_ERR_RANGE;
  auto *begin = out;
  size_t total = n;
  try {
    while (n) {
      size_t ci = off / ((size_t)s->rows * s->K), start = ci * s->rows * s->K;
      size_t len =
          (size_t)std::min(s->rows, s->N - int64_t(ci * s->rows)) * s->K;
      auto &v = s->chunks[ci];
      size_t skip = off - start, take = std::min(n, len - skip);
      // Full chunks decode straight into the caller's output. Partial reads
      // need only a 64-byte edge buffer, never a rows*K temporary allocation.
      auto *dst = reinterpret_cast<int8_t *>(out);
      require(skip == 0 && take == len
                  ? unpack_bits(v.data(), v.size(), dst, len)
                  : unpack_bits<true>(v.data(), v.size(), dst, len, skip, take),
              "private decode");
      off += take;
      out += take;
      n -= take;
    }
    return SH_OK;
  } catch (...) {
    memset(begin, 0, total);
    return SH_ERR_VERIFY;
  }
}
struct omp_one {
  int previous;
  omp_one() : previous(omp_get_max_threads()) { omp_set_num_threads(1); }
  ~omp_one() { omp_set_num_threads(previous); }
};
// Each refill worker owns bounded scratch. Keep its allocation across calls:
// allocating and zeroing multi-MiB decode buffers on every matrix otherwise
// adds page faults and memory traffic to the steady-state path. Only the active
// ranges are read, and every active byte is written before use. Threads are
// joined at backend teardown, releasing these private buffers then.
struct compact_scratch {
  std::vector<uint8_t> planes;
  std::vector<int8_t> block;
  std::vector<int32_t> accum;
  ~compact_scratch() {
    // Mask planes and products remain private for reuse of the allocation,
    // never reuse of pad values; wipe before the worker returns its memory.
    volatile uint8_t *p = planes.data();
    for (size_t i=0; i<planes.size(); ++i) p[i]=0;
    volatile int32_t *a = accum.data();
    for (size_t i=0; i<accum.size(); ++i) a[i]=0;
  }
};
template<class T> static void grow(std::vector<T> &v, size_t n) {
  if (v.size() < n) v.resize(n);
}
static thread_local compact_scratch scratch;
extern "C" int sh_compact_refill(void *ctx, const int32_t *r, int b, int32_t *u,
                                 int64_t stride) {
  auto *s = static_cast<sh_compact_store *>(ctx);
  if (!s || !r || !u || b < 1 || b > 64 || stride < s->N || stride > (1 << 21))
    return SH_ERR_RANGE;
  auto wipe = [&] {
    for (int i = 0; i < b; i++)
      memset(u + (int64_t)i * stride, 0, (size_t)s->N * 4);
  };
  try {
    const size_t n = (size_t)b * s->K;
    auto &planes = scratch.planes; grow(planes, 3 * n);
    // Small batches use the existing audited kernel. This avoids GEMM setup
    // regressions but not the measurable cost of lossless decompression.
    const bool gemm = b >= 32;
    for (size_t i = 0; i < n; i++)
      require(r[i] >= 0 && r[i] < SH_M_MOD, "mask range");
    if (gemm) {
      for (size_t i = 0; i < n; i++) {
        uint32_t v = r[i];
        planes[i] = v;
        planes[n + i] = v >> 8;
        planes[2 * n + i] = v >> 16;
      }
    } else
      sh_simd_avx512_pad_planes(r, n, planes.data(), planes.data() + n,
                                planes.data() + 2 * n);
    auto &block = scratch.block; grow(block, (size_t)s->rows * s->K);
    // Accumulators only address existing output rows, including partial tiles.
    const size_t rows = (size_t)std::min(s->rows, s->N);
    auto &accum = scratch.accum;
    // The native kernel (including its allocation-failure fallback) needs
    // 12 values per output row; only GEMM uses three complete batch planes.
    grow(accum, (gemm ? 3 * (size_t)b : 12) * rows);
    omp_one scope;
    for (size_t ci = 0; ci < s->chunks.size(); ci++) {
      int64_t j = ci * s->rows, nr = std::min(s->rows, s->N - j);
      auto &v = s->chunks[ci];
      require(unpack_bits(v.data(), v.size(), block.data(), nr * s->K),
              "private decode");
      if (!gemm) {
        sh_simd_avx512_refill_vector_crt(planes.data(), b, block.data(), s->K,
                                         nr, u + j, stride, accum.data());
        continue;
      }
      int32_t co = 0;
      require(dnnl_gemm_u8s8s32('N', 'T', 'F', 3 * b, nr, s->K, 1.0f,
                                planes.data(), s->K, 0, block.data(), s->K, 0,
                                0.0f, accum.data(), nr, &co) == dnnl_success,
              "integer GEMM");
      for (int i = 0; i < b; i++)
        for (int64_t c = 0; c < nr; c++) {
          int64_t x = (int64_t)accum[(size_t)i * nr + c] +
                      256 * (int64_t)accum[(size_t)(b + i) * nr + c] +
                      65536 * (int64_t)accum[(size_t)(2 * b + i) * nr + c];
          int64_t z = x % SH_M_MOD;
          z += (z < 0) * SH_M_MOD;
          u[(int64_t)i * stride + j + c] =
              (int32_t)(z - (z > SH_HALF_M) * SH_M_MOD);
        }
    }
    return SH_OK;
  } catch (...) {
    wipe();
    return SH_ERR_VERIFY;
  }
}
