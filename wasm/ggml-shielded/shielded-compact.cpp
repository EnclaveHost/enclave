// Opt-in production candidate: exact private packing and CPU-only pad math.
#include "shielded-compact.h"
#include "shielded-field.h"
#include "shielded-simd.h"
#include <algorithm>
#include <cstring>
#include <immintrin.h>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <omp.h>
#include <oneapi/dnnl/dnnl.hpp>
#include <stdexcept>
#include <vector>
#include <array>
#include <cerrno>
#include <fcntl.h>
#include <unistd.h>
#include <sys/vfs.h>
#include <sys/stat.h>
#include <linux/magic.h>
#include <openssl/sha.h>
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

struct omp_one {
  int previous;
  omp_one() : previous(omp_get_max_threads()) { omp_set_num_threads(1); }
  ~omp_one() { omp_set_num_threads(previous); }
};

// Plans carry no model weights or mask values. Use a bounded weak cache so
// equal geometries share JIT/descriptor metadata without keeping stores alive.
struct compact_layout {
  dnnl::engine engine{dnnl::engine::kind::cpu, 0};
  struct execution {
    dnnl::memory::desc src, dst, workspace;
    dnnl::matmul operation;
    explicit execution(const dnnl::matmul::primitive_desc &pd)
        : src(pd.src_desc()), dst(pd.dst_desc()),
          workspace(pd.scratchpad_desc()), operation(pd) {
      require(workspace.get_size() <= (8U << 20), "layout workspace bound");
    }
  };
  dnnl::memory::desc weights;
  std::shared_ptr<execution> primary;
  std::mutex plans_mu;
  std::vector<std::pair<int, std::shared_ptr<execution>>> small_plans;
  int64_t K, N;
  bool supported = false;
  compact_layout(int64_t k, int64_t n) : K(k), N(n) {
    omp_one single;
    using dt = dnnl::memory::data_type;
    using tag = dnnl::memory::format_tag;
    auto src = dnnl::memory::desc({192, K}, dt::u8, tag::ab);
    auto dst = dnnl::memory::desc({192, N}, dt::s32, tag::ab);
    dnnl::primitive_attr attr;
    attr.set_scratchpad_mode(dnnl::scratchpad_mode::user);
    dnnl::matmul::primitive_desc pd(
        engine, src, dnnl::memory::desc({K, N}, dt::s8, tag::any), dst, attr);
    weights = pd.weights_desc();
    auto workspace = pd.scratchpad_desc();
    // The fast gather/scatter below implements precisely this blocked layout.
    // Refuse other descriptors or padding; never infer offsets from a name.
    supported = weights.get_dims() == dnnl::memory::dims{K, N} &&
                weights.get_padded_dims() == dnnl::memory::dims{K, N} &&
                weights.get_padded_offsets() == dnnl::memory::dims{0, 0} &&
                weights.get_submemory_offset() == 0 &&
                weights.get_strides() == dnnl::memory::dims{4096, K * 64} &&
                weights.get_inner_blks() == dnnl::memory::dims{16, 64, 4} &&
                weights.get_inner_idxs() == dnnl::memory::dims{0, 1, 0} &&
                weights.get_size() == size_t(K * N) &&
                workspace.get_size() <= (8U << 20);
    if (supported)
      primary = std::make_shared<execution>(pd);
  }
  std::shared_ptr<execution> batch_plan(int batch) {
    if (batch == 64)
      return primary;
    std::lock_guard<std::mutex> lock(plans_mu);
    for (size_t i = 0; i < small_plans.size(); ++i)
      if (small_plans[i].first == batch) {
        auto found = small_plans[i];
        small_plans.erase(small_plans.begin() + i);
        small_plans.push_back(found);
        return found.second;
      }
    using dt = dnnl::memory::data_type;
    using tag = dnnl::memory::format_tag;
    dnnl::primitive_attr attr;
    attr.set_scratchpad_mode(dnnl::scratchpad_mode::user);
    dnnl::matmul::primitive_desc pd(
        engine, dnnl::memory::desc({3 * batch, K}, dt::u8, tag::ab), weights,
        dnnl::memory::desc({3 * batch, N}, dt::s32, tag::ab), attr);
    require(pd.weights_desc() == weights, "immutable layout");
    auto result = std::make_shared<execution>(pd);
    // Active calls own their plan even when another batch evicts its cache
    // entry.
    if (small_plans.size() == 4)
      small_plans.erase(small_plans.begin());
    small_plans.emplace_back(batch, result);
    return result;
  }
  void rearrange(const int8_t *in, int8_t *out, bool reverse) const {
    const __m512i offsets =
        _mm512_setr_epi32(0, 256, 512, 768, 1024, 1280, 1536, 1792, 2048, 2304,
                          2560, 2816, 3072, 3328, 3584, 3840);
    for (int64_t row = 0; row < N; row++)
      for (int64_t k = 0; k < K; k += 64) {
        size_t packed = (row / 64) * K * 64 + (k / 64) * 4096 + (row % 64) * 4;
        if (reverse) {
          auto v = _mm512_i32gather_epi32(offsets, in + packed, 1);
          _mm512_storeu_si512(out + row * K + k, v);
        } else {
          auto v = _mm512_loadu_si512(in + row * K + k);
          _mm512_i32scatter_epi32(out + packed, offsets, v, 1);
        }
      }
  }
  void run(const execution &plan, uint8_t *a, int8_t *b, int32_t *c,
           uint8_t *work) const {
    dnnl::stream stream(engine);
    dnnl::memory am(plan.src, engine, a), bm(weights, engine, b),
        cm(plan.dst, engine, c), tmp(plan.workspace, engine, work);
    plan.operation.execute(stream, {{DNNL_ARG_SRC, am},
                                    {DNNL_ARG_WEIGHTS, bm},
                                    {DNNL_ARG_DST, cm},
                                    {DNNL_ARG_SCRATCHPAD, tmp}});
    stream.wait();
  }
};
static std::shared_ptr<compact_layout> find_layout(int64_t K, int64_t N) {
  // Small/unaligned tiles retain the original format without padding.
  if (K < 256 || K % 64 || N < 64 || N % 64)
    return {};
  static std::mutex mu;
  static std::map<std::pair<int64_t, int64_t>, std::weak_ptr<compact_layout>>
      cache;
  std::lock_guard<std::mutex> lock(mu);
  for (auto it = cache.begin(); it != cache.end();)
    if (it->second.expired())
      it = cache.erase(it);
    else
      ++it;
  const auto key = std::make_pair(K, N);
  auto found = cache.find(key);
  if (found != cache.end())
    if (auto plan = found->second.lock())
      return plan;
  std::shared_ptr<compact_layout> plan;
  try {
    plan = std::make_shared<compact_layout>(K, N);
  } catch (const dnnl::error &e) {
    if (e.status == dnnl_unimplemented)
      return {};
    throw;
  }
  if (!plan->supported)
    return {};
  if (cache.size() < 32)
    cache[key] = plan;
  return plan;
}
// Reusable trusted extents. Destroying a model returns its ranges, so repeated
// loads cannot leak the scratch capacity. Extents are split/merged under one lock.
struct public_disk_arena {
  struct range { uint64_t base, size; bool used; };
  std::mutex mu;
  int fd = -1, source = -1;
  uint64_t next = 0, capacity = 0;
  std::vector<range> ranges;
  ~public_disk_arena() { if (fd >= 0) close(fd); }
  uint64_t reserve(uint64_t size) {
    require(size > 0, "empty public disk reservation");
    std::lock_guard<std::mutex> lock(mu);
    for (size_t i = 0; i < ranges.size(); ++i) {
      const auto r = ranges[i];
      if (r.used || r.size < size) continue;
      if (r.size > size) {
        // Insert before mutating the old range: allocation failure leaves it free.
        ranges.insert(ranges.begin() + i + 1, {r.base + size, r.size - size, false});
      }
      ranges[i] = {r.base, size, true};
      return r.base;
    }
    require(next <= capacity && size <= capacity - next, "public disk full");
    const auto base = next;
    ranges.push_back({base, size, true}); next += size;
    return base;
  }
  void release(uint64_t base) {
    std::lock_guard<std::mutex> lock(mu);
    for (size_t i = 0; i < ranges.size(); ++i) {
      if (ranges[i].base != base || !ranges[i].used) continue;
      ranges[i].used = false;
      if (i + 1 < ranges.size() && !ranges[i + 1].used) {
        ranges[i].size += ranges[i + 1].size;
        ranges.erase(ranges.begin() + i + 1);
      }
      if (i && !ranges[i - 1].used) {
        ranges[i - 1].size += ranges[i].size;
        ranges.erase(ranges.begin() + i);
      }
      return;
    }
  }
};
struct sh_compact_store {
  int64_t K, N, rows = 384;
  std::vector<std::vector<uint8_t>> chunks;
  std::vector<std::shared_ptr<compact_layout>> layouts;
  size_t bytes = 0;
  struct extent {
    uint64_t offset;
    size_t size;
    std::array<uint8_t, SHA256_DIGEST_LENGTH> hash;
  };
  std::vector<extent> disk;
  int fd = -1;
  uint64_t disk_bytes = 0;
  uint64_t disk_base = 0;
  uint64_t synced_bytes = 0;
  std::shared_ptr<public_disk_arena> arena;
  ~sh_compact_store() {
    if (fd >= 0) close(fd);
    if (arena) arena->release(disk_base);
  }
  void spill(const std::vector<uint8_t> &packed) {
    extent e{disk_base + disk_bytes, packed.size(), {}};
    require(SHA256(packed.data(), packed.size(), e.hash.data()), "weight digest");
    size_t at = 0;
    while (at < packed.size()) {
      ssize_t n = pwrite(fd, packed.data() + at, packed.size() - at, e.offset + at);
      if (n < 0 && errno == EINTR) continue;
      require(n > 0, "weight spill write"); at += size_t(n);
    }
    disk_bytes += packed.size();
    disk.push_back(e);
    // Batch durability work for this ephemeral PUBLIC cache. Synchronizing
    // every ~MiB tile forces thousands of journal/device flushes at cold start.
    // Bound dirty pages per store and finish before publishing the provider.
    if (disk_bytes - synced_bytes >= (32U << 20)) sync_pending();
  }
  void sync_pending() {
    if (disk_bytes == synced_bytes) return;
    int rc;
    do { rc = fdatasync(fd); } while (rc < 0 && errno == EINTR);
    require(rc == 0, "weight spill sync");
    posix_fadvise(fd, disk_base + synced_bytes, disk_bytes - synced_bytes, POSIX_FADV_DONTNEED);
    synced_bytes = disk_bytes;
  }
  const std::vector<uint8_t> &chunk(size_t ci, std::vector<uint8_t> &buffer) const {
    if (fd < 0) return chunks.at(ci);
    const auto &e = disk.at(ci);
    buffer.resize(e.size);
    size_t at = 0;
    while (at < e.size) {
      ssize_t n = pread(fd, buffer.data() + at, e.size - at, e.offset + at);
      if (n < 0 && errno == EINTR) continue;
      require(n > 0, "weight spill read"); at += size_t(n);
    }
    std::array<uint8_t, SHA256_DIGEST_LENGTH> hash;
    require(SHA256(buffer.data(), buffer.size(), hash.data()) && hash == e.hash,
            "weight spill authentication");
    // Only authenticated private bytes are decompressed or multiplied. Hints
    // reclaim this public file's pages and overlap the next sequential read.
    posix_fadvise(fd, e.offset, e.size, POSIX_FADV_DONTNEED);
    if (ci + 1 < disk.size()) {
      const auto &next = disk[ci + 1];
      posix_fadvise(fd, next.offset, next.size, POSIX_FADV_WILLNEED);
    }
    return buffer;
  }
};
// A measured guest can hand us a dedicated raw PUBLIC scratch disk. No host
// filesystem is mounted inside the guest. Process-private allocation metadata
// prevents matrices/cards from aliasing, and no prior disk bytes are trusted.
static void reserve_public_disk(sh_compact_store &s, const char *spec) {
  static const auto owner = std::make_shared<public_disk_arena>();
  static std::mutex init_mu;
  auto &a = *owner;
  char *end = nullptr;
  long source = strtol(spec + 3, &end, 10);
  require(end && !*end && source >= 3 && source <= 1023, "public disk descriptor");
  std::lock_guard<std::mutex> lock(init_mu);
  if (a.fd < 0) {
    require((fcntl(source, F_GETFL) & O_ACCMODE) == O_RDWR, "public disk writable");
    struct stat st;
    require(fstat(source, &st) == 0 && S_ISBLK(st.st_mode), "public disk must be a block device");
    off_t size = lseek(source, 0, SEEK_END);
    require(size > 0 && uint64_t(size) <= (UINT64_C(64) << 30), "public disk size");
    a.fd = fcntl(source, F_DUPFD_CLOEXEC, 3);
    require(a.fd >= 0, "public disk duplicate");
    a.source = source; a.capacity = uint64_t(size);
  }
  require(a.source == source, "one public disk per runtime");
  // Conservative upper bound: independently padded 64-byte frames per tile.
  const uint64_t tiles = (s.N + s.rows - 1) / s.rows;
  const uint64_t bound = (((uint64_t(s.K) * s.N / 64 + tiles) * 66 + 4095) / 4096) * 4096;
  s.fd = fcntl(a.fd, F_DUPFD_CLOEXEC, 3);
  require(s.fd >= 0, "public disk store descriptor");
  s.disk_base = a.reserve(bound);
  s.arena = owner;
}
static sh_compact_store *compact_create(const int8_t *w, int64_t K,
                                       int64_t N, const char *directory) {
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
    if (directory) {
      require(*directory, "empty spill directory");
      if (!strncmp(directory, "fd:", 3)) reserve_public_disk(*s, directory);
      else {
      std::string path = std::string(directory) + "/.shield-public-weights-XXXXXX";
      s->fd = mkstemp(path.data());
      require(s->fd >= 0, "weight spill open");
      const bool removed = unlink(path.c_str()) == 0;
      require(removed && fcntl(s->fd, F_SETFD, FD_CLOEXEC) == 0, "weight spill fd");
      struct statfs fs;
      require(fstatfs(s->fd, &fs) == 0 && fs.f_type != TMPFS_MAGIC &&
              fs.f_type != RAMFS_MAGIC, "weight spill must use disk, not RAM");
      }
    }
    std::vector<int8_t> check((size_t)s->rows * K), reordered;
    auto full = find_layout(K, std::min(s->rows, N));
    auto tail = N > s->rows && N % s->rows ? find_layout(K, N % s->rows) : full;
    for (int64_t j = 0; j < N; j += s->rows) {
      size_t n = (size_t)std::min(s->rows, N - j) * K;
      auto packed = pack_bits(w + j * K, n);
      require(unpack_bits(packed.data(), packed.size(), check.data(), n) &&
                  memcmp(check.data(), w + j * K, n) == 0,
              "lossless admission");
      auto layout = (n == size_t(s->rows * K) || N <= s->rows) ? full : tail;
      if (layout) {
        reordered.resize(n);
        layout->rearrange(w + j * K, reordered.data(), false);
        auto arranged = pack_bits(reordered.data(), n);
        // Bound encoded-payload growth per tile, not just on average. Keep
        // only one format. Plan/scratch allocations are separately bounded.
        if (arranged.capacity() <=
            packed.capacity() + packed.capacity() / 100) {
          require(
              unpack_bits(arranged.data(), arranged.size(), check.data(), n) &&
                  !memcmp(check.data(), reordered.data(), n),
              "layout admission");
          layout->rearrange(check.data(), reordered.data(), true);
          require(!memcmp(reordered.data(), w + j * K, n), "layout round trip");
          packed = std::move(arranged);
        } else
          layout.reset();
      }
      s->layouts.push_back(std::move(layout));
      if (s->fd >= 0) {
        s->spill(packed);
        s->chunks.emplace_back();
      } else {
        s->bytes += packed.capacity();
        s->chunks.push_back(std::move(packed));
      }
    }
    s->bytes += sizeof(*s) + s->chunks.capacity() * sizeof(s->chunks[0]) +
                s->layouts.capacity() * sizeof(s->layouts[0]) +
                s->disk.capacity() * sizeof(s->disk[0]);
    if (s->fd >= 0) s->sync_pending();
    return s;
  } catch (...) {
    delete s;
    return nullptr;
  }
}
extern "C" sh_compact_store *sh_compact_create(const int8_t *w, int64_t K, int64_t N) {
  return compact_create(w, K, N, nullptr);
}
extern "C" sh_compact_store *sh_compact_create_streamed(const int8_t *w, int64_t K,
                                                        int64_t N, const char *dir) {
  if (!dir) return nullptr;
  return compact_create(w, K, N, dir);
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
    std::vector<int8_t> block((size_t)s->rows * s->K), plain;
    std::vector<uint8_t> packed;
    while (n) {
      size_t ci = off / ((size_t)s->rows * s->K), start = ci * s->rows * s->K;
      size_t len =
          (size_t)std::min(s->rows, s->N - int64_t(ci * s->rows)) * s->K;
      const auto &v = s->chunk(ci, packed);
      require(unpack_bits(v.data(), v.size(), block.data(), len),
              "private decode");
      const int8_t *decoded = block.data();
      if (s->layouts[ci]) {
        plain.resize(len);
        s->layouts[ci]->rearrange(block.data(), plain.data(), true);
        decoded = plain.data();
      }
      size_t skip = off - start, take = std::min(n, len - skip);
      memcpy(out, decoded + skip, take);
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
// Each refill worker owns bounded scratch. Keep its allocation across calls:
// allocating and zeroing multi-MiB decode buffers on every matrix otherwise
// adds page faults and memory traffic to the steady-state path. Only the active
// ranges are read, and every active byte is written before use. Threads are
// joined at backend teardown, releasing these private buffers then.
struct compact_scratch {
  std::vector<uint8_t> planes, workspace, crt_planes, packed;
  std::vector<int8_t> block;
  std::vector<int32_t> accum;
  ~compact_scratch() {
    // Mask planes and products remain private for reuse of the allocation,
    // never reuse of pad values; wipe before the worker returns its memory.
    volatile uint8_t *crt = crt_planes.data();
    for (size_t i = 0; i < crt_planes.size(); ++i)
      crt[i] = 0;
    volatile uint8_t *tmp = workspace.data();
    for (size_t i = 0; i < workspace.size(); ++i)
      tmp[i] = 0;
    volatile uint8_t *p = planes.data();
    for (size_t i = 0; i < planes.size(); ++i)
      p[i] = 0;
    volatile int32_t *a = accum.data();
    for (size_t i = 0; i < accum.size(); ++i)
      a[i] = 0;
  }
};
template <class T> static void grow(std::vector<T> &v, size_t n) {
  // A growth can release an old allocation before the scratch destructor runs.
  // Clear private mask/product material before that allocation is returned.
  if (v.capacity() < n) {
    volatile T *old = v.data();
    for (size_t i = 0; i < v.size(); ++i)
      old[i] = 0;
    // Avoid resize's geometric over-allocation for large private buffers.
    v.reserve(n);
  }
  if (v.size() < n)
    v.resize(n);
}
static thread_local compact_scratch scratch;
extern "C" int sh_compact_refill(void *ctx, const int32_t *r, int b, int32_t *u,
                                 int64_t stride) {
  auto *s = static_cast<sh_compact_store *>(ctx);
  if (!s || !r || !u || b < 1 || b > 256 || stride < s->N || stride > (1 << 21))
    return SH_ERR_RANGE;
  auto wipe = [&] {
    for (int i = 0; i < b; i++)
      memset(u + (int64_t)i * stride, 0, (size_t)s->N * 4);
  };
  try {
    const size_t n = (size_t)b * s->K;
    auto &planes = scratch.planes;
    grow(planes, 3 * n);
    // Ordinary tiles retain the established small-batch CRT path.
    // Prearranged tiles use the same exact radix-256 math at every batch size.
    const bool gemm = b >= 32;
    const bool arranged = std::any_of(s->layouts.begin(), s->layouts.end(),
                                      [](const auto &p) { return bool(p); });
    for (size_t i = 0; i < n; i++)
      require(r[i] >= 0 && r[i] < SH_M_MOD, "mask range");
    if (gemm || arranged) {
      for (size_t i = 0; i < n; i++) {
        uint32_t v = r[i];
        planes[i] = v;
        planes[n + i] = v >> 8;
        planes[2 * n + i] = v >> 16;
      }
    } else
      sh_simd_avx512_pad_planes(r, n, planes.data(), planes.data() + n,
                                planes.data() + 2 * n);
    const uint8_t *crt = planes.data();
    if (arranged && !gemm) {
      grow(scratch.crt_planes, 3 * n);
      sh_simd_avx512_pad_planes(r, n, scratch.crt_planes.data(),
                                scratch.crt_planes.data() + n,
                                scratch.crt_planes.data() + 2 * n);
      crt = scratch.crt_planes.data();
    }
    auto &block = scratch.block;
    grow(block, (size_t)s->rows * s->K);
    auto &accum = scratch.accum;
    grow(accum, std::max<size_t>(12 * s->rows, 3 * (size_t)b * s->rows));
    omp_one scope;
    for (size_t ci = 0; ci < s->chunks.size(); ci++) {
      int64_t j = ci * s->rows, nr = std::min(s->rows, s->N - j);
      const auto &v = s->chunk(ci, scratch.packed);
      require(unpack_bits(v.data(), v.size(), block.data(), nr * s->K),
              "private decode");
      auto &layout = s->layouts[ci];
      int8_t *weights = block.data();
      if (!gemm && !layout) {
        sh_simd_avx512_refill_vector_crt(crt, b, weights, s->K, nr, u + j,
                                         stride, accum.data());
        continue;
      }
      if (layout) {
        auto plan = layout->batch_plan(b);
        grow(scratch.workspace, plan->workspace.get_size() + 64);
        auto work = (uint8_t *)(((uintptr_t)scratch.workspace.data() + 63) &
                                ~uintptr_t(63));
        layout->run(*plan, planes.data(), block.data(), accum.data(), work);
      } else {
        int32_t co = 0;
        require(dnnl_gemm_u8s8s32('N', 'T', 'F', 3 * b, nr, s->K, 1.0f,
                                  planes.data(), s->K, 0, weights, s->K, 0,
                                  0.0f, accum.data(), nr, &co) == dnnl_success,
                "integer GEMM");
      }
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
