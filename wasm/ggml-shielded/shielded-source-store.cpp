// Source-backed local weight storage (SHIELDED_SOURCE_WEIGHTS=1): the enclave keeps NO
// encoded copy of an offloaded weight. Its int8 rows are a deterministic function of
// the weight's own (verified, private) source bytes, which the process keeps mapped
// anyway: the CPU computes the rows the backend leaves local from them. Reads and pad
// refills re-encode tiles from that source with the backend's own encoder
// (sh_row_to_q8_0 + sh_prepare_weight_rows_range), so every byte is identical to the
// registered encoding; admission re-encodes the whole weight once and compares.
//
// Cost: a refill decodes each tile once per refill batch, i.e. 1/b of the batch's own
// multiply work. Memory: K*N bytes per weight are not held (a 6B diffusion
// transformer's ~6 GB of encodings), only a pointer and N per-row exponents.
//
// The source must stay valid and unchanged for the life of the store: a mapping of
// the guest's private, hash-verified model copy, never a host-shared page.
#include "shielded-source-store.h"
#include "shielded-field.h"
#include "shielded-tee.h"
#include "shielded-simd.h"
#include "shielded-source-quant.h"
#include <algorithm>
#include <cmath>
#include <immintrin.h>
#include <cstring>
#include <omp.h>
#include <oneapi/dnnl/dnnl.h>
#include <stdexcept>
#include <vector>

static void require(bool ok, const char *why) {
  if (!ok) throw std::runtime_error(why);
}

struct sh_source_store {
  const uint8_t *src = nullptr;  // the weight's first byte (all N_total rows)
  ggml_type type = GGML_TYPE_COUNT;
  int64_t K = 0, col0 = 0, N = 0, rows = 384;
  size_t row_bytes = 0;
};

// ggml's quantize_row_q8_0_ref + sh_prepare_weight_rows_range for ONE row, vectorized and bit-exact:
// the same IEEE single-precision operations in the same order (this file is built with
// -ffp-contract=off), roundf emulated exactly (half away from zero), ggml's own fp16 conversion
// for the block scale and the field's own half helpers for the encoding. Admission compares
// every regenerated row with the registered (reference-encoded) weight, so a mismatch refuses
// the store; it can never mint a wrong pad.
static inline __m512 roundf_exact(__m512 v) {
  const __m512 t = _mm512_roundscale_ps(v, _MM_FROUND_TO_ZERO | _MM_FROUND_NO_EXC);
  const __m512 frac = _mm512_sub_ps(v, t);                       // exact for |v| < 2^23
  const __m512 absfrac = _mm512_abs_ps(frac);
  const __mmask16 away = _mm512_cmp_ps_mask(absfrac, _mm512_set1_ps(0.5f), _CMP_GE_OQ);
  const __m512 one = _mm512_or_ps(_mm512_set1_ps(1.0f), _mm512_and_ps(v, _mm512_set1_ps(-0.0f)));  // copysign(1, v)
  return _mm512_mask_add_ps(t, away, t, one);
}
static bool encode_row_fast(const float *x, int64_t K, int8_t *out, std::vector<int8_t> &qs, std::vector<uint16_t> &dh) {
  const int64_t nb = K / SH_QK;
  qs.resize((size_t)K); dh.resize((size_t)nb);
  double peak = 0.0;
  for (int64_t b = 0; b < nb; b++) {
    const float *xb = x + b * SH_QK;
    const __m512 v0 = _mm512_loadu_ps(xb), v1 = _mm512_loadu_ps(xb + 16);
    const float amax = std::max(_mm512_reduce_max_ps(_mm512_abs_ps(v0)), _mm512_reduce_max_ps(_mm512_abs_ps(v1)));
    const float d = amax / ((1 << 7) - 1);
    const float id = d ? 1.0f / d : 0.0f;
    dh[b] = ggml_fp32_to_fp16(d);
    const __m512 vid = _mm512_set1_ps(id);
    const __m512i q0 = _mm512_cvttps_epi32(roundf_exact(_mm512_mul_ps(v0, vid)));
    const __m512i q1 = _mm512_cvttps_epi32(roundf_exact(_mm512_mul_ps(v1, vid)));
    _mm_storeu_si128((__m128i *)(qs.data() + b * SH_QK), _mm512_cvtepi32_epi8(q0));
    _mm_storeu_si128((__m128i *)(qs.data() + b * SH_QK + 16), _mm512_cvtepi32_epi8(q1));
    const double dd = fabs((double)sh_half_to_float(dh[b]));
    if (dd == 0.0) continue;
    const __m512i a0 = _mm512_abs_epi32(q0), a1 = _mm512_abs_epi32(q1);
    const int qmax = std::max(_mm512_reduce_max_epi32(a0), _mm512_reduce_max_epi32(a1));
    const double a = dd * qmax;
    if (a > peak) peak = a;
  }
  int f_w = SH_FRAC;
  if (peak > 0.0) f_w = (int)floor(log2((double)SH_WEIGHT_BYTE_LIMIT / peak));
  const __m512 half = _mm512_set1_ps(0.5f), lim = _mm512_set1_ps((float)SH_WEIGHT_BYTE_LIMIT);
  for (int cand = f_w; cand > f_w - 8; cand--) {
    const float mul = ldexpf(1.0f, cand - SH_FRAC);
    bool ok = true;
    for (int64_t b = 0; b < nb && ok; b++) {
      const float v = sh_half_to_float(dh[b]) * mul;
      if (!std::isfinite(v)) { ok = false; break; }
      const __m512 d256 = _mm512_set1_ps(sh_half_to_float(sh_float_to_half(v)) * 256.0f);
      for (int h = 0; h < 2; h++) {
        const __m512 q = _mm512_cvtepi32_ps(_mm512_cvtepi8_epi32(_mm_loadu_si128((const __m128i *)(qs.data() + b * SH_QK + 16 * h))));
        const __m512 w = _mm512_roundscale_ps(_mm512_add_ps(_mm512_mul_ps(d256, q), half), _MM_FROUND_TO_NEG_INF | _MM_FROUND_NO_EXC);
        if (_mm512_cmp_ps_mask(w, lim, _CMP_GT_OQ) | _mm512_cmp_ps_mask(w, _mm512_sub_ps(_mm512_setzero_ps(), lim), _CMP_LT_OQ)) { ok = false; break; }
        _mm_storeu_si128((__m128i *)(out + b * SH_QK + 16 * h), _mm512_cvtepi32_epi8(_mm512_cvttps_epi32(w)));
      }
    }
    if (ok) return true;
  }
  return false;
}

// rows [j, j + nr) of the store (store-relative), encoded into out (nr * K bytes)
static void encode_rows(const sh_source_store *s, int64_t j, int64_t nr, int8_t *out,
                        std::vector<float> &f32, std::vector<uint8_t> &q8) {
  thread_local std::vector<int8_t> qs;
  thread_local std::vector<uint16_t> dh;
  f32.resize((size_t)s->K);
  (void)q8;
  const ggml_type_traits *tr = ggml_get_type_traits(s->type);
  require(tr && tr->to_float, "no dequantizer");
  for (int64_t r = 0; r < nr; r++) {
    const uint8_t *row = s->src + (size_t)(s->col0 + j + r) * s->row_bytes;
    if (s->type == GGML_TYPE_Q8_0) {   /* registration encodes q8_0 blocks directly, so must this */
      int f = 0;
      require(sh_prepare_weight_rows_range(row, s->K, 1, 0, 1, out + (size_t)r * s->K, &f) >= 0, "encode");
      continue;
    }
    tr->to_float(row, f32.data(), s->K);
    require(encode_row_fast(f32.data(), s->K, out + (size_t)r * s->K, qs, dh), "encode");
  }
}

extern "C" sh_source_store *sh_source_store_create(const void *src, int type, int64_t K, int64_t col0,
                                                   int64_t N, const int8_t *expected) {
  sh_source_store *s = nullptr;
  try {
    __builtin_cpu_init();
    if (!__builtin_cpu_supports("avx512vnni") || !__builtin_cpu_supports("avx512bw")) return nullptr;
    if (!src || !expected || K <= 0 || K > 65536 || N <= 0 || N > (1 << 20) || col0 < 0) return nullptr;
    if (!sh_source_type_ok((ggml_type)type) || !sh_source_geometry_ok((ggml_type)type, K)) return nullptr;
    s = new sh_source_store;
    s->src = static_cast<const uint8_t *>(src);
    s->type = (ggml_type)type;
    s->K = K; s->col0 = col0; s->N = N;
    s->row_bytes = (size_t)ggml_row_size((ggml_type)type, K);
    // Lossless admission: the regenerated rows ARE the registered encoding.
    std::vector<int8_t> block((size_t)s->rows * K);
    std::vector<float> f32; std::vector<uint8_t> q8;
    for (int64_t j = 0; j < N; j += s->rows) {
      const int64_t nr = std::min(s->rows, N - j);
      encode_rows(s, j, nr, block.data(), f32, q8);
      require(memcmp(block.data(), expected + (size_t)j * K, (size_t)nr * K) == 0, "source re-encoding differs");
    }
    return s;
  } catch (...) {
    delete s;
    return nullptr;
  }
}
extern "C" void sh_source_store_free(sh_source_store *s) { delete s; }
extern "C" size_t sh_source_store_bytes(const sh_source_store *s) { return s ? sizeof(*s) : 0; }

struct src_scratch {
  std::vector<int8_t> block;
  std::vector<float> f32;
  std::vector<uint8_t> q8, planes;
  std::vector<int32_t> accum;
  ~src_scratch() {
    volatile uint8_t *p = planes.data();
    for (size_t i = 0; i < planes.size(); ++i) p[i] = 0;
    volatile int32_t *a = accum.data();
    for (size_t i = 0; i < accum.size(); ++i) a[i] = 0;
  }
};
static thread_local src_scratch scratch;

extern "C" int sh_source_store_read(void *ctx, uint64_t off, uint8_t *out, size_t n) {
  auto *s = static_cast<sh_source_store *>(ctx);
  if (!s || !out || off > uint64_t(s->K) * s->N || n > uint64_t(s->K) * s->N - off) return SH_ERR_RANGE;
  auto *begin = out;
  const size_t total = n;
  try {
    auto &block = scratch.block;
    if (block.size() < (size_t)s->rows * s->K) block.resize((size_t)s->rows * s->K);
    while (n) {
      const int64_t j = (int64_t)(off / s->K) / s->rows * s->rows;
      const int64_t nr = std::min(s->rows, s->N - j);
      encode_rows(s, j, nr, block.data(), scratch.f32, scratch.q8);
      const size_t start = (size_t)j * s->K, skip = off - start;
      const size_t take = std::min(n, (size_t)nr * s->K - skip);
      memcpy(out, block.data() + skip, take);
      off += take; out += take; n -= take;
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

// u[i] = r[i] . W (mod M), the same arithmetic as sh_compact_refill over regenerated tiles.
extern "C" int sh_source_store_refill(void *ctx, const int32_t *r, int b, int32_t *u, int64_t stride) {
  auto *s = static_cast<sh_source_store *>(ctx);
  if (!s || !r || !u || b < 1 || b > 64 || stride < s->N || stride > (1 << 21)) return SH_ERR_RANGE;
  auto wipe = [&] { for (int i = 0; i < b; i++) memset(u + (int64_t)i * stride, 0, (size_t)s->N * 4); };
  try {
    const size_t n = (size_t)b * s->K;
    auto &planes = scratch.planes; if (planes.size() < 3 * n) planes.resize(3 * n);
    const bool gemm = b >= 32;
    for (size_t i = 0; i < n; i++) require(r[i] >= 0 && r[i] < SH_M_MOD, "mask range");
    if (gemm) {
      for (size_t i = 0; i < n; i++) { uint32_t v = r[i]; planes[i] = v; planes[n + i] = v >> 8; planes[2 * n + i] = v >> 16; }
    } else
      sh_simd_avx512_pad_planes(r, n, planes.data(), planes.data() + n, planes.data() + 2 * n);
    auto &block = scratch.block; if (block.size() < (size_t)s->rows * s->K) block.resize((size_t)s->rows * s->K);
    const size_t rows = (size_t)std::min(s->rows, s->N);
    auto &accum = scratch.accum; if (accum.size() < (gemm ? 3 * (size_t)b : 12) * rows) accum.resize((gemm ? 3 * (size_t)b : 12) * rows);
    omp_one scope;
    for (int64_t j = 0; j < s->N; j += s->rows) {
      const int64_t nr = std::min(s->rows, s->N - j);
      encode_rows(s, j, nr, block.data(), scratch.f32, scratch.q8);
      if (!gemm) {
        sh_simd_avx512_refill_vector_crt(planes.data(), b, block.data(), s->K, nr, u + j, stride, accum.data());
        continue;
      }
      int32_t co = 0;
      require(dnnl_gemm_u8s8s32('N', 'T', 'F', 3 * b, nr, s->K, 1.0f, planes.data(), s->K, 0, block.data(), s->K, 0,
                                0.0f, accum.data(), nr, &co) == dnnl_success, "integer GEMM");
      for (int i = 0; i < b; i++)
        for (int64_t c = 0; c < nr; c++) {
          const int64_t x = (int64_t)accum[(size_t)i * nr + c] + 256 * (int64_t)accum[(size_t)(b + i) * nr + c] +
                            65536 * (int64_t)accum[(size_t)(2 * b + i) * nr + c];
          int64_t z = x % SH_M_MOD;
          z += (z < 0) * SH_M_MOD;
          u[(int64_t)i * stride + j + c] = (int32_t)(z - (z > SH_HALF_M) * SH_M_MOD);
        }
    }
    return SH_OK;
  } catch (...) {
    wipe();
    return SH_ERR_VERIFY;
  }
}
