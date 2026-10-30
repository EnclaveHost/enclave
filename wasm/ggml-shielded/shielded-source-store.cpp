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
#define GGML_COMMON_DECL_CPP
#include "ggml-common.h"
static_assert(offsetof(block_q4_K, scales) == 4, "q4_K: d and dmin open the block");
#include <algorithm>
#include <cmath>
#include <immintrin.h>
#include <cstring>
#include <mutex>
#include <atomic>
#include <cstdio>
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
// sh_half_to_float, by table: 65536 entries computed BY sh_half_to_float, so every value is the
// helper's own. The helper's ldexpf/scalbnf was a measurable share of each re-encode.
static float g_h2f[65536];
static std::once_flag g_h2f_once;
static inline float h2f(uint16_t h) { return g_h2f[h]; }
static void h2f_init() { std::call_once(g_h2f_once, [] { for (uint32_t h = 0; h < 65536; h++) g_h2f[h] = sh_half_to_float((uint16_t)h); }); }

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
    const double dd = fabs((double)h2f(dh[b]));
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
      const float v = h2f(dh[b]) * mul;
      if (!std::isfinite(v)) { ok = false; break; }
      const __m512 d256 = _mm512_set1_ps(h2f(sh_float_to_half(v)) * 256.0f);
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

// ggml's dequantize_row_q4_K / _q6_K (ggml-quants.c), sixteen values at a time with the same float
// operations in the same order (this file is built with -ffp-contract=off). Whether they ARE the
// reference's bits depends on how ggml-base was compiled, so each type is compared with ggml's own
// to_float on the first row it decodes and used only if every byte agrees (dq_admit); admission
// then compares the whole re-encoded weight with the registered encoding as before.
static inline void q4k_scale_min(int j, const uint8_t *q, uint8_t *d, uint8_t *m) {
  if (j < 4) { *d = q[j] & 63; *m = q[j + 4] & 63; }
  else { *d = (q[j + 4] & 0xF) | ((q[j - 4] >> 6) << 4); *m = (q[j + 4] >> 4) | ((q[j - 0] >> 6) << 4); }
}
static inline __m512 u8x16_to_ps(__m128i v) { return _mm512_cvtepi32_ps(_mm512_cvtepu8_epi32(v)); }
static void dq_q4_K(const block_q4_K *x, float *y, int64_t k) {
  for (int64_t i = 0; i < k / QK_K; i++) {
    const uint8_t *q = x[i].qs;
    uint16_t dh[2];                                  // the block opens with d, dmin (ggml_half each)
    memcpy(dh, &x[i], sizeof dh);
    const float d = h2f(dh[0]), dmin = h2f(dh[1]);
    int is = 0;
    for (int j = 0; j < QK_K; j += 64) {
      uint8_t sc, m;
      q4k_scale_min(is + 0, x[i].scales, &sc, &m);
      const __m512 d1 = _mm512_set1_ps(d * sc), m1 = _mm512_set1_ps(dmin * m);
      q4k_scale_min(is + 1, x[i].scales, &sc, &m);
      const __m512 d2 = _mm512_set1_ps(d * sc), m2 = _mm512_set1_ps(dmin * m);
      for (int h = 0; h < 2; h++) {
        const __m128i b = _mm_loadu_si128((const __m128i *)(q + 16 * h));
        const __m128i lo = _mm_and_si128(b, _mm_set1_epi8(0xF)), hi = _mm_and_si128(_mm_srli_epi16(b, 4), _mm_set1_epi8(0xF));
        _mm512_storeu_ps(y + 16 * h, _mm512_sub_ps(_mm512_mul_ps(d1, u8x16_to_ps(lo)), m1));
        _mm512_storeu_ps(y + 32 + 16 * h, _mm512_sub_ps(_mm512_mul_ps(d2, u8x16_to_ps(hi)), m2));
      }
      y += 64; q += 32; is += 2;
    }
  }
}
static void dq_q6_K(const block_q6_K *x, float *y, int64_t k) {
  for (int64_t i = 0; i < k / QK_K; i++) {
    const float d = h2f(x[i].d);
    const uint8_t *ql = x[i].ql, *qh = x[i].qh;
    const int8_t *sc = x[i].scales;
    for (int n = 0; n < QK_K; n += 128) {
      for (int h = 0; h < 2; h++) {                 // l = 16h .. 16h+15, is = h
        const __m512i l0 = _mm512_cvtepu8_epi32(_mm_loadu_si128((const __m128i *)(ql + 16 * h)));
        const __m512i l32 = _mm512_cvtepu8_epi32(_mm_loadu_si128((const __m128i *)(ql + 32 + 16 * h)));
        const __m512i hh = _mm512_cvtepu8_epi32(_mm_loadu_si128((const __m128i *)(qh + 16 * h)));
        const __m512i f = _mm512_set1_epi32(0xF), t = _mm512_set1_epi32(3), k32 = _mm512_set1_epi32(32);
        const __m512i q1 = _mm512_sub_epi32(_mm512_or_si512(_mm512_and_si512(l0, f), _mm512_slli_epi32(_mm512_and_si512(hh, t), 4)), k32);
        const __m512i q2 = _mm512_sub_epi32(_mm512_or_si512(_mm512_and_si512(l32, f), _mm512_slli_epi32(_mm512_and_si512(_mm512_srli_epi32(hh, 2), t), 4)), k32);
        const __m512i q3 = _mm512_sub_epi32(_mm512_or_si512(_mm512_srli_epi32(l0, 4), _mm512_slli_epi32(_mm512_and_si512(_mm512_srli_epi32(hh, 4), t), 4)), k32);
        const __m512i q4 = _mm512_sub_epi32(_mm512_or_si512(_mm512_srli_epi32(l32, 4), _mm512_slli_epi32(_mm512_and_si512(_mm512_srli_epi32(hh, 6), t), 4)), k32);
        _mm512_storeu_ps(y + 16 * h + 0,  _mm512_mul_ps(_mm512_set1_ps(d * sc[h + 0]), _mm512_cvtepi32_ps(q1)));
        _mm512_storeu_ps(y + 16 * h + 32, _mm512_mul_ps(_mm512_set1_ps(d * sc[h + 2]), _mm512_cvtepi32_ps(q2)));
        _mm512_storeu_ps(y + 16 * h + 64, _mm512_mul_ps(_mm512_set1_ps(d * sc[h + 4]), _mm512_cvtepi32_ps(q3)));
        _mm512_storeu_ps(y + 16 * h + 96, _mm512_mul_ps(_mm512_set1_ps(d * sc[h + 6]), _mm512_cvtepi32_ps(q4)));
      }
      y += 128; ql += 64; qh += 32; sc += 8;
    }
  }
}
// per type: 0 not yet compared, 1 agrees with ggml's to_float, -1 does not (reference used)
static std::atomic<int> g_dq_state[GGML_TYPE_COUNT];
static void dequantize(const ggml_type_traits *tr, ggml_type type, const uint8_t *row, float *y, int64_t K) {
  void (*fast)(const void *, float *, int64_t) =
      type == GGML_TYPE_Q4_K ? [](const void *x, float *o, int64_t k) { dq_q4_K((const block_q4_K *)x, o, k); } :
      type == GGML_TYPE_Q6_K ? [](const void *x, float *o, int64_t k) { dq_q6_K((const block_q6_K *)x, o, k); } : nullptr;
  if (!fast || K % QK_K || g_dq_state[type].load(std::memory_order_acquire) < 0) { tr->to_float(row, y, K); return; }
  if (g_dq_state[type].load(std::memory_order_acquire) == 0) {
    std::vector<float> ref((size_t)K);
    tr->to_float(row, ref.data(), K);
    fast(row, y, K);
    const bool same = !memcmp(ref.data(), y, (size_t)K * sizeof(float));
    g_dq_state[type].store(same ? 1 : -1, std::memory_order_release);
    if (!same) { fprintf(stderr, "[shielded] source store: vector %s dequantizer differs from ggml's; using ggml's\n", ggml_type_name(type)); memcpy(y, ref.data(), (size_t)K * sizeof(float)); }
    return;
  }
  fast(row, y, K);
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
  h2f_init();
  for (int64_t r = 0; r < nr; r++) {
    const uint8_t *row = s->src + (size_t)(s->col0 + j + r) * s->row_bytes;
    if (s->type == GGML_TYPE_Q8_0) {   /* registration encodes q8_0 blocks directly, so must this */
      int f = 0;
      require(sh_prepare_weight_rows_range(row, s->K, 1, 0, 1, out + (size_t)r * s->K, &f) >= 0, "encode");
      continue;
    }
    dequantize(tr, s->type, row, f32.data(), s->K);
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
  if (!s || !r || !u || b < 1 || b > 256 || stride < s->N || stride > (1 << 21)) return SH_ERR_RANGE;
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
