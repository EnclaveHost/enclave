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

// rows [j, j + nr) of the store (store-relative), encoded into out (nr * K bytes)
static void encode_rows(const sh_source_store *s, int64_t j, int64_t nr, int8_t *out,
                        std::vector<float> &f32, std::vector<uint8_t> &q8) {
  f32.resize((size_t)s->K);
  q8.resize((size_t)(s->K / SH_QK) * sizeof(sh_block_q8_0));
  for (int64_t r = 0; r < nr; r++) {
    const uint8_t *row = s->src + (size_t)(s->col0 + j + r) * s->row_bytes;
    int f = 0;
    if (s->type == GGML_TYPE_Q8_0) {
      require(sh_prepare_weight_rows_range(row, s->K, 1, 0, 1, out + (size_t)r * s->K, &f) >= 0, "encode");
    } else {
      require(sh_row_to_q8_0(s->type, row, s->K, f32.data(), q8.data()), "decode");
      require(sh_prepare_weight_rows_range(q8.data(), s->K, 1, 0, 1, out + (size_t)r * s->K, &f) >= 0, "encode");
    }
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
