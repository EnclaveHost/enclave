// Synthetic CPU-only integration fixture for the candidate opt-in bounded
// deferred retirement. The UNCHANGED candidate source table
// (../candidate/shield-original-source.hpp) is bound to the exact rebuilt
// backend's authenticated weight-source registration, consumed-source release
// and authenticated local computation. Bytes are synthetic: no model, GPU,
// network, keys or production paths. Build with -I<exact backend src> and
// -I<candidate dir>; see ../bounded-retirement-integration.test.mjs.
#ifdef NDEBUG
#error "bounded-retirement integration fixture requires assert()"
#endif
#include "ggml-shielded.cpp"
#include "ggml-cpu.h"
#include "shield-original-source.hpp"
#include <algorithm>
#include <cassert>
#include <cfloat>
#include <sys/mman.h>
#include <sys/stat.h>

namespace {
// Q8_0 256x256 is 69632 bytes: exactly 17 pages of 4 KiB, so each GPU source
// extent is page aligned and whole-page sized. N >= 64 so the real column
// split planner gives each of two cards a 32-aligned, non-empty slice.
constexpr int64_t K = 256, N = 256;
constexpr int kGpuCount = 4, kCpuCount = 3;
const char *const kGpu[kGpuCount] = {
    "blk.0.ffn_gate.weight", "blk.0.ffn_up.weight", "blk.1.ffn_gate.weight", "blk.1.ffn_up.weight"};
const char *const kCpu[kCpuCount] = {"token_embd.weight", "blk.0.attn_norm.weight", "output_norm.weight"};

struct extent { const char *name; uint64_t off, size; ggml_tensor *t = nullptr; };
struct event { std::string name; int rc; bool from_backing; bool retired[kGpuCount]; uint64_t unretired; };

struct harness {
    shield_original_source src;
    bool split = false, compact = false;
    uint64_t page = 0, T = 0, initial_blocks = 0;
    std::vector<uint8_t> image;   // authentic bytes: the table source and the public backing
    std::vector<uint8_t> priv;    // expected private file contents before retirement
    extent gpu[kGpuCount], cpu[kCpuCount];
    ggml_backend_buffer_t source_buf[kGpuCount] = {}, cpu_buf = nullptr;
    void *map = MAP_FAILED;
    std::vector<event> reads, verifies;
    int release_calls = 0;
    size_t round_reads = 0, round_verifies = 0;
    uint64_t round_released = 0, round_reread = 0;
};

int gpu_index(const std::string &name) {
    for (int i = 0; i < kGpuCount; i++) if (name == kGpu[i]) return i;
    return -1;
}
uint64_t interior(uint64_t pg, uint64_t off, uint64_t n) {
    const uint64_t b = (off + pg - 1) / pg * pg, e = (off + n) / pg * pg;
    return e > b ? e - b : 0;
}
uint64_t allocated(int fd) { struct stat st{}; return fstat(fd, &st) ? UINT64_MAX : uint64_t(st.st_blocks) * 512; }
bool overlaps(const void *p, size_t n, const void *base, size_t size) {
    const uintptr_t a = (uintptr_t)p, b = (uintptr_t)base;
    return a < b + size && b < a + n;
}
int memfd_with(const char *name, const std::vector<uint8_t> &img) {
    const int fd = memfd_create(name, MFD_CLOEXEC);
    if (fd < 0) return -1;
    for (size_t at = 0; at < img.size();) {
        const ssize_t put = pwrite(fd, img.data() + at, img.size() - at, (off_t)at);
        if (put < 0 && errno == EINTR) continue;
        if (put <= 0) { close(fd); return -1; }
        at += (size_t)put;
    }
    return fd;
}
void snap(harness &h, bool out[kGpuCount]) {
    for (int i = 0; i < kGpuCount; i++) out[i] = h.src.entries.at(kGpu[i]).retired;
}

// Thin observers. Each delegates to the unchanged candidate callback and
// returns its result verbatim; they only record state for the assertions.
int observe_read(void *ctx, const char *name, uint32_t type, const int64_t ne[4], void *bytes, size_t n) {
    auto &h = *static_cast<harness *>(ctx);
    // The backend supplies its own private destination, never the CPU mapping.
    assert(!overlaps(bytes, n, h.map, h.image.size()));
    const auto it = h.src.entries.find(name);
    const bool from_backing = it != h.src.entries.end() && it->second.retired;
    const int rc = shield_original_source::read(&h.src, name, type, ne, bytes, n);
    event ev{name, rc, from_backing, {}, h.src.unretired_bytes};
    snap(h, ev.retired);
    if (rc == 0 && h.src.retire_budget)
        assert(h.src.unretired_bytes <= std::max<uint64_t>(h.src.retire_budget, n));
    h.reads.push_back(ev);
    return rc;
}
int observe_verify(void *ctx, const char *name, uint32_t type, const int64_t ne[4], const void *bytes, size_t n) {
    auto &h = *static_cast<harness *>(ctx);
    // Authentication covers a private copy, not the shared private mapping.
    assert(!overlaps(bytes, n, h.map, h.image.size()));
    const int rc = shield_original_source::verify(&h.src, name, type, ne, bytes, n);
    event ev{name, rc, false, {}, h.src.unretired_bytes};
    snap(h, ev.retired);
    h.verifies.push_back(ev);
    return rc;
}

// Exactly the retired originals' page interiors are holes through pread,
// tmpfs blocks dropped by the same amount, and CPU-owned
// neighbours are untouched and readable through the CPU buffer.
void check_private(harness &h) {
    std::vector<uint8_t> want = h.priv;
    uint64_t released = 0;
    for (int i = 0; i < kGpuCount; i++) {
        const auto &e = h.src.entries.at(kGpu[i]);
        if (!e.retired) continue;
        const uint64_t lo = (e.offset + h.page - 1) / h.page * h.page, hi = (e.offset + e.size) / h.page * h.page;
        if (hi > lo) { std::fill(want.begin() + lo, want.begin() + hi, 0); released += hi - lo; }
    }
    std::vector<uint8_t> got(want.size());
    assert(shield_original_source::read_at(h.src.private_fd, got.data(), got.size(), 0));
    assert(got == want);
    // Do not fault retired GPU holes through MAP_SHARED: a read fault itself
    // allocates zero-filled tmpfs pages. CPU mapping reads are checked below.
    assert(h.src.released_bytes == released);
    assert(allocated(h.src.private_fd) == h.initial_blocks - released);
    for (auto &c : h.cpu) {
        const auto &e = h.src.entries.at(c.name);
        assert(!e.consumed && !e.retired);
        std::vector<uint8_t> b(c.size);
        ggml_backend_tensor_get(c.t, b.data(), 0, c.size);
        assert(!memcmp(b.data(), h.image.data() + c.off, c.size));
    }
}

// Called by the backend (sh_release_consumed_sources) at the end of each
// successful registration batch, BEFORE the candidate's final flush.
int observe_release(void *ctx) {
    auto &h = *static_cast<harness *>(ctx);
    h.release_calls++;
    const size_t per = h.split ? 2 : 1;          // one full-tensor read per card
    assert(h.reads.size() - h.round_reads == 2 * per);
    assert(h.verifies.size() - h.round_verifies == 2 * per);
    const event *r = &h.reads[h.round_reads], *v = &h.verifies[h.round_verifies];
    for (size_t i = 0; i < 2 * per; i++)
        assert(r[i].rc == 0 && !r[i].from_backing && v[i].rc == 0 && v[i].name == r[i].name);
    if (per == 2) assert(r[1].name == r[0].name && r[3].name == r[2].name);   // adjacent per-card reads
    const int first = gpu_index(r[0].name), second = gpu_index(r[per].name);
    assert(first >= 0 && second >= 0 && first != second && first / 2 == second / 2);
    auto &ef = h.src.entries.at(kGpu[first]);
    auto &es = h.src.entries.at(kGpu[second]);
    assert(ef.consumed && es.consumed);
    if (h.src.retire_budget) {
        // The next card's read of the same tensor stayed private (keep rule).
        if (per == 2) assert(!r[1].retired[first] && !v[1].retired[first]);
        // The first original was retired INSIDE the batch, at the next
        // tensor's first read, before that tensor was authenticated.
        assert(r[per].retired[first] && v[per].retired[first]);
        assert(ef.retired && !es.retired);
        assert(h.src.unretired.size() == 1 && h.src.unretired.front() == &es && h.src.unretired_bytes == es.size);
        assert(h.src.released_bytes == h.round_released + interior(h.page, ef.offset, ef.size));
    } else {
        // Default control: nothing retires before the batch flush.
        assert(!ef.retired && !es.retired && h.src.unretired.empty() && h.src.unretired_bytes == 0);
        assert(h.src.released_bytes == h.round_released);
    }
    assert(h.src.reread_bytes == h.round_reread);   // no host reread inside the batch
    check_private(h);
    return shield_original_source::release_consumed(&h.src);
}

ggml_status compute(harness &h, ggml_context *ctx, const std::vector<int> &which, int rows,
                    std::vector<ggml_tensor *> &nodes) {
    auto *a = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, K, rows);
    for (int i = 0; i < K * rows; i++) ((float *)a->data)[i] = (i % 13 - 6) / 256.0f;
    nodes.clear();
    for (int i : which) {
        auto *out = ggml_mul_mat(ctx, h.gpu[i].t, a);
        std::fill_n((float *)out->data, N * rows, -9876.0f);
        nodes.push_back(out);
    }
    ggml_cgraph graph = {};
    graph.n_nodes = graph.size = (int)nodes.size(); graph.nodes = nodes.data();
    return ggml_backend_shielded_graph_compute(nullptr, &graph);
}
void check_untouched(const std::vector<ggml_tensor *> &nodes, int rows) {
    for (auto *node : nodes)
        for (int i = 0; i < N * rows; i++) assert(((float *)node->data)[i] == -9876.0f);
}
// Exact products from the authentic bytes, independent of any source reread.
void check_products(harness &h, const std::vector<ggml_tensor *> &nodes, int rows) {
    sh_state &s = *sh_pool_get().cards[0];
    std::vector<int8_t> enc((size_t)(K * N));
    std::vector<int> frac((size_t)N);
    for (auto *node : nodes) {
        const int i = gpu_index(ggml_get_name(node->src[0]));
        assert(i >= 0);
        const auto &e = s.weights.at(kGpu[i]);
        assert(e.source_verified && e.inv.size() == (size_t)N);
        assert(sh_prepare_weight_rows(h.image.data() + h.gpu[i].off, K, N, enc.data(), frac.data()) == SH_OK);
        for (int r = 0; r < rows; r++) for (int64_t j = 0; j < N; j++) {
            int64_t acc = 0;
            for (int64_t k = 0; k < K; k++) acc += (int64_t)((r * K + k) % 13 - 6) * enc[(size_t)(j * K + k)];
            const float expected = (float)sh_balanced(acc) * e.inv[(size_t)j];
            assert(((float *)node->data)[(size_t)(r * N + j)] == expected);
        }
    }
}
void check_storage(harness &h, const std::vector<int> &which) {
    sh_pool &p = sh_pool_get();
    for (int i : which) {
        const auto &e = p.cards[0]->weights.at(kGpu[i]);
        assert(e.source_verified && !e.w_cache);
        if (h.compact) assert(e.w.empty()); else assert(!e.w.empty());
#ifdef SHIELDED_COMPACT
        if (h.compact) assert(e.compact);
#endif
        if (h.split) {
            assert(p.cards.size() == 2 && e.col0 == 0 && e.ncols == N / 2);
            assert(e.part_cards == std::vector<int>({0, 1}) && e.part_col0 == std::vector<int64_t>({0, N / 2}));
            const auto &o = p.cards[1]->weights.at(kGpu[i]);
            assert(o.source_verified && !o.w_cache && o.col0 == N / 2 && o.ncols == N / 2);
            if (h.compact) assert(o.w.empty()); else assert(o.w.size() == (size_t)(K * N / 2));
        } else {
            assert(e.part_cards.empty() && e.ncols == 0);
            if (!h.compact) assert(e.w.size() == (size_t)(K * N));
        }
    }
}

// One registration batch through the backend's own graph_compute -> sh_plan.
void run_round(harness &h, ggml_context *ctx, const std::vector<int> &fresh, const std::vector<int> &all) {
    const int releases = h.release_calls;
    h.round_reads = h.reads.size(); h.round_verifies = h.verifies.size();
    h.round_released = h.src.released_bytes; h.round_reread = h.src.reread_bytes;
    uint64_t c0 = 0, b0 = 0, c1 = 0, b1 = 0;
    ggml_backend_shielded_weight_source_stats(&c0, &b0);
    std::vector<ggml_tensor *> nodes;
    assert(compute(h, ctx, all, 1, nodes) == GGML_STATUS_SUCCESS);
    assert(h.release_calls == releases + 1);
    const size_t reads = (h.split ? 2 : 1) * fresh.size();
    assert(h.reads.size() == h.round_reads + reads && h.verifies.size() == h.round_verifies + reads);
    ggml_backend_shielded_weight_source_stats(&c1, &b1);
    assert(c1 == c0 + reads && b1 == b0 + reads * h.T);
    for (int i : fresh) { const auto &e = h.src.entries.at(kGpu[i]); assert(e.consumed && e.retired); }
    assert(h.src.unretired.empty() && h.src.unretired_bytes == 0 && h.src.reread_bytes == h.round_reread);
    check_private(h);
    check_storage(h, fresh);
    check_products(h, nodes, 1);
    // Wider than SHIELDED_MAX_M: same retained encodings, no source access.
    assert(compute(h, ctx, all, 19, nodes) == GGML_STATUS_SUCCESS);
    assert(h.reads.size() == h.round_reads + reads && h.verifies.size() == h.round_verifies + reads);
    check_products(h, nodes, 19);
    check_private(h);
}

// A retired original is reread from the public backing through the backend's
// source get_tensor, and the whole tensor is reauthenticated every time.
void reread(harness &h, ggml_context *meta, int i) {
    uint64_t c0 = 0, b0 = 0, c1 = 0, b1 = 0;
    ggml_backend_shielded_weight_source_stats(&c0, &b0);
    const uint64_t rr = h.src.reread_bytes;
    const size_t nr = h.reads.size(), nv = h.verifies.size();
    assert(h.src.entries.at(kGpu[i]).retired);
    std::vector<uint8_t> got(h.T);
    ggml_backend_tensor_get(h.gpu[i].t, got.data(), 0, got.size());
    assert(!memcmp(got.data(), h.image.data() + h.gpu[i].off, h.T));
    assert(h.reads.size() == nr + 1 && h.reads.back().from_backing && h.reads.back().rc == 0);
    assert(h.verifies.size() == nv + 1 && h.verifies.back().rc == 0);
    assert(h.src.reread_bytes == rr + h.T);
    auto *view = ggml_view_1d(meta, h.gpu[i].t, 32, 3 * 34);
    uint8_t part[17];
    ggml_backend_tensor_get(view, part, 4, sizeof part);
    assert(!memcmp(part, h.image.data() + h.gpu[i].off + 3 * 34 + 4, sizeof part));
    assert(h.reads.size() == nr + 2 && h.verifies.size() == nv + 2 && h.src.reread_bytes == rr + 2 * h.T);
    ggml_backend_shielded_weight_source_stats(&c1, &b1);
    assert(c1 == c0 + 2 && b1 == b0 + 2 * h.T);
    assert(h.src.unretired.empty() && h.src.unretired_bytes == 0);   // never re-enters the budget
    check_private(h);
}

void cleanup(harness &h, ggml_context *meta, ggml_context *act) {
    for (auto *b : h.source_buf) if (b) ggml_backend_buffer_free(b);
    if (h.cpu_buf) ggml_backend_buffer_free(h.cpu_buf);
    ggml_free(act); ggml_free(meta);
    if (h.map != MAP_FAILED) assert(munmap(h.map, h.image.size()) == 0);
    h.map = MAP_FAILED;
}
}  // namespace

int main(int argc, char **argv) {
    assert(argc == 3);
    const std::string dir = argv[1], scenario = argv[2];
    static const std::set<std::string> known = {
        "bounded_local", "bounded_split_local", "tiny_local", "default_local", "default_split_local",
        "bounded_compact", "bounded_compact_split", "private_tamper", "punch_fail",
        "backing_tamper_reread", "backing_truncate_reread"};
    if (!known.count(scenario)) { fprintf(stderr, "unknown scenario %s\n", scenario.c_str()); return 2; }
    harness h;
    h.split = scenario.find("split") != std::string::npos;
    h.compact = scenario.find("compact") != std::string::npos;
#ifndef SHIELDED_COMPACT
    if (h.compact) { fprintf(stderr, "compact scenario requires a -DSHIELDED_COMPACT build\n"); return 2; }
#endif
    const bool fail_closed = scenario == "private_tamper" || scenario == "punch_fail";
    const bool abort_reread = scenario == "backing_tamper_reread" || scenario == "backing_truncate_reread";

    // Same synthetic environment as the existing verifier fixture's local-mint
    // scenarios (all-zero test seeds; never real pad or key material).
    setenv("SHIELDED_WEIGHT_CACHE_DIR", dir.c_str(), 1);
    unsetenv("SHIELDED_PAD_SOURCE");
    unsetenv("SHIELDED_SOURCE_PREFETCH");
    setenv("SHIELDED_PAD_SEED", std::string(64, '0').c_str(), 1);
    setenv("SHIELDED_PAD_SEED_ID", std::string(32, '0').c_str(), 1);
    setenv("SHIELDED_PAD_SK", std::string(64, '0').c_str(), 1);
    setenv("SHIELDED_PAD_CHECK", "1", 1); setenv("SHIELDED_NO_SIMD", "1", 1);
    setenv("SHIELDED_MIN_MACS", "0", 1); setenv("SHIELDED_MAX_M", "16", 1);
    if (h.compact) setenv("SHIELDED_COMPACT_WEIGHTS", "1", 1);
    if (h.split) setenv("SHIELDED_SPLIT_COLS", "1", 1);   // read once, by sh_split_cols()

    // ---- synthetic private file and separate public backing ----
    h.page = (uint64_t)sysconf(_SC_PAGESIZE);
    h.T = ggml_row_size(GGML_TYPE_Q8_0, K) * (uint64_t)N;
    assert(h.T == 69632);
    if (h.T % h.page) fprintf(stderr, "note: page %llu does not divide %llu; extents are not whole-page\n",
                              (unsigned long long)h.page, (unsigned long long)h.T);
    const uint64_t P = h.page, Tp = (h.T + P - 1) / P * P;
    h.cpu[0] = {kCpu[0], 0, P};
    h.gpu[0] = {kGpu[0], P, h.T};
    h.gpu[1] = {kGpu[1], P + Tp, h.T};
    h.cpu[1] = {kCpu[1], P + 2 * Tp, P};
    h.gpu[2] = {kGpu[2], 2 * P + 2 * Tp, h.T};
    h.gpu[3] = {kGpu[3], 2 * P + 3 * Tp, h.T};
    h.cpu[2] = {kCpu[2], 2 * P + 4 * Tp + 64, 256};   // partial page after the last GPU extent
    h.image.resize(3 * P + 4 * Tp);
    uint64_t x = 0x9e3779b97f4a7c15ull;
    for (auto &b : h.image) { x ^= x << 13; x ^= x >> 7; x ^= x << 17; b = (uint8_t)x; }
    for (int t = 0; t < kGpuCount; t++) {
        std::vector<float> raw((size_t)(K * N));
        for (size_t i = 0; i < raw.size(); i++) raw[i] = (float)((int)((i * 7 + 3 * t) % 23) - 11) / 64.0f;
        assert(ggml_quantize_chunk(GGML_TYPE_Q8_0, raw.data(), h.image.data() + h.gpu[t].off, 0, N, K, nullptr) == h.T);
    }
    for (int c = 0; c < kCpuCount; c++) {
        float *f = (float *)(h.image.data() + h.cpu[c].off);
        for (uint64_t i = 0; i < h.cpu[c].size / 4; i++) f[i] = (float)((int)(i % 17) - 8) * 0.125f + (float)c;
    }
    h.priv = h.image;

    int priv = memfd_with("bounded-retirement-private", h.image);
    const int back = memfd_with("bounded-retirement-public-backing", h.image);
    assert(priv >= 0 && back >= 0);
    if (scenario == "punch_fail") {
        // Read-only private descriptor: every hole punch fails.
        char path[64]; snprintf(path, sizeof path, "/proc/self/fd/%d", priv);
        const int ro = open(path, O_RDONLY | O_CLOEXEC);
        close(priv); priv = ro; assert(priv >= 0);
    }
    struct stat ps{}, bs{};
    assert(!fstat(priv, &ps) && !fstat(back, &bs) && !(ps.st_dev == bs.st_dev && ps.st_ino == bs.st_ino));
    h.src.private_fd = priv; h.src.backing_fd = back;
    h.src.file_size = h.image.size(); h.src.page = h.page;
    h.src.defer_retirement = true;
    // Internal test budget, set directly. The production parser and its
    // [64, 65536] MiB range are neither called nor changed.
    h.src.retire_budget = scenario.rfind("default", 0) == 0 ? 0 : scenario.rfind("tiny", 0) == 0 ? 1 : h.T;
    for (auto &e : h.cpu) { const int64_t ne[4] = {(int64_t)(e.size / 4), 1, 1, 1}; h.src.add(e.name, GGML_TYPE_F32, ne, e.off, e.size); }
    for (auto &e : h.gpu) { const int64_t ne[4] = {K, N, 1, 1}; h.src.add(e.name, GGML_TYPE_Q8_0, ne, e.off, e.size); }
    h.initial_blocks = allocated(priv);
    if (h.initial_blocks != h.image.size()) {
        fprintf(stderr, "private memfd allocates %llu bytes for %zu written; tmpfs huge pages?\n",
                (unsigned long long)h.initial_blocks, h.image.size());
        return 2;
    }
    h.map = mmap(nullptr, h.image.size(), PROT_READ, MAP_SHARED, priv, 0);
    assert(h.map != MAP_FAILED);
    if (scenario == "private_tamper") {
        // After the table is built: the bytes later delivered differ from it.
        const uint64_t at = h.gpu[1].off + 20;
        h.priv[at] ^= 0x5a;
        assert(pwrite(priv, &h.priv[at], 1, (off_t)at) == 1);
    }

    // ---- backend admission, same order as the loader ----
    assert(ggml_backend_shielded_set_source_release(observe_release, &h) == SH_ERR_RANGE);
    assert(ggml_backend_shielded_set_weight_verifier(observe_verify, &h) == SH_OK);
    assert(ggml_backend_shielded_set_source_release(observe_release, &h) == SH_OK);
    sh_pool &p = sh_pool_get(); sh_state &s = *p.cards[0];
    s.configured = s.calib_loaded = true; s.calib_version = 2;
    for (auto *name : kGpu) s.calib[name] = {8, {}};
    if (h.split) {
        p.extra.emplace_back(new sh_state()); p.cards.push_back(p.extra.back().get());
        auto &other = *p.cards.back();
        other.configured = other.calib_loaded = true; other.calib_version = 2; other.calib = s.calib;
    }
    // No worker, no connection attempt: every link stays down; authenticated
    // mode must compute locally from the verified encodings, never plainly.
    for (auto *c : p.cards) { c->link_failed = true; c->link_retry_at = DBL_MAX; }
    s.contention.contended = true; s.probe_group = "different.group";

    uint64_t calls = 99, bytes = 99;
    ggml_backend_shielded_weight_source_stats(&calls, &bytes);
    assert(calls == 0 && bytes == 0);
    auto *meta = ggml_init({ggml_tensor_overhead() * 64, nullptr, true}); assert(meta);
    auto *act = ggml_init({8u << 20, nullptr, false}); assert(act);
    for (int i = 0; i < kGpuCount; i++) {
        auto *t = ggml_new_tensor_2d(meta, GGML_TYPE_Q8_0, K, N); ggml_set_name(t, kGpu[i]);
        auto *buf = ggml_backend_shielded_weight_source(t, observe_read, &h);
        assert(buf && !ggml_backend_buffer_is_host(buf) && sh_dev_supports_buft(nullptr, buf->buft));
        h.gpu[i].t = t; h.source_buf[i] = buf;
    }
    h.cpu_buf = ggml_backend_cpu_buffer_from_ptr(h.map, h.image.size()); assert(h.cpu_buf);
    ggml_backend_buffer_set_usage(h.cpu_buf, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
    for (auto &c : h.cpu) {
        auto *t = ggml_new_tensor_1d(meta, GGML_TYPE_F32, (int64_t)(c.size / 4)); ggml_set_name(t, c.name);
        t->buffer = nullptr;
        assert(ggml_backend_tensor_alloc(h.cpu_buf, t, (char *)h.map + c.off) == GGML_STATUS_SUCCESS);
        c.t = t;
    }
    check_private(h);
    const std::vector<int> layer0 = {0, 1}, layer1 = {2, 3}, all = {0, 1, 2, 3};

    if (fail_closed) {
        std::vector<ggml_tensor *> nodes;
        assert(compute(h, act, layer0, 1, nodes) == GGML_STATUS_FAILED);
        check_untouched(nodes, 1);
        assert(h.release_calls == 0 && s.source_verification_failed);
        if (scenario == "punch_fail") {
            assert(h.reads.size() == 2 && h.reads[0].rc == 0 && h.reads[1].rc != 0);
            assert(h.verifies.size() == 1 && h.verifies[0].rc == 0 && h.verifies[0].name == h.reads[0].name);
            const int first = gpu_index(h.reads[0].name), second = gpu_index(h.reads[1].name);
            assert(first >= 0 && second >= 0 && first != second);
            assert(!h.src.entries.at(kGpu[first]).retired && h.src.entries.at(kGpu[second]).consumed);
            assert(h.src.released_bytes == 0);
            assert(static_cast<sh_weight_source *>(h.source_buf[second]->context)->failed.load());
        } else {
            assert(!h.verifies.empty() && h.verifies.back().name == kGpu[1] && h.verifies.back().rc != 0);
            if (h.reads[0].name == kGpu[0])
                assert(h.reads.size() == 2 && h.verifies.size() == 2 && h.verifies[0].rc == 0 &&
                       h.reads[1].retired[0] && h.verifies[1].retired[0]);
            else assert(h.reads.size() == 1 && h.verifies.size() == 1);
        }
        check_private(h);
        const size_t nr = h.reads.size(), nv = h.verifies.size();
        assert(compute(h, act, layer0, 1, nodes) == GGML_STATUS_FAILED); check_untouched(nodes, 1);
        assert(compute(h, act, layer1, 1, nodes) == GGML_STATUS_FAILED); check_untouched(nodes, 1);
        ggml_cgraph empty = {};
        assert(ggml_backend_shielded_graph_compute(nullptr, &empty) == GGML_STATUS_FAILED);
        assert(h.reads.size() == nr && h.verifies.size() == nv && h.release_calls == 0);
        if (scenario == "punch_fail") assert(shield_original_source::release_consumed(&h.src) == -1);
        check_private(h);
        cleanup(h, meta, act);
        puts("bounded-retirement-integration: registration failure failed closed");
        return 0;
    }

    run_round(h, act, layer0, layer0);
    reread(h, meta, 0); reread(h, meta, 1);

    if (abort_reread) {
        if (scenario == "backing_tamper_reread") {
            const uint64_t at = h.gpu[0].off + 20; const uint8_t bad = h.image[at] ^ 1;
            assert(pwrite(back, &bad, 1, (off_t)at) == 1);
        } else assert(ftruncate(back, (off_t)(h.gpu[0].off + 17)) == 0);
        // Retained encodings never touch the source: exact compute still works.
        const size_t nr = h.reads.size();
        std::vector<ggml_tensor *> nodes;
        assert(compute(h, act, layer0, 1, nodes) == GGML_STATUS_SUCCESS);
        assert(h.reads.size() == nr);
        check_products(h, nodes, 1);
        puts("bounded-retirement-integration: pre-abort checks passed"); fflush(stdout);
        std::vector<uint8_t> got(h.T);
        ggml_backend_tensor_get(h.gpu[0].t, got.data(), 0, got.size());   // must GGML_ABORT
        fprintf(stderr, "bounded-retirement-integration: corrupted backing reread was accepted\n");
        return 3;
    }

    // Second registration round. Hostile public backing under a not-yet-read
    // tensor is irrelevant: unretired originals are read from the private file.
    const uint64_t at = h.gpu[2].off + 20; const uint8_t good = h.image[at], bad = good ^ 0x5a;
    assert(pwrite(back, &bad, 1, (off_t)at) == 1);
    run_round(h, act, layer1, all);
    assert(pwrite(back, &good, 1, (off_t)at) == 1);
    reread(h, meta, 2); reread(h, meta, 3); reread(h, meta, 0);
    assert(h.release_calls == 2);
    assert(h.src.released_bytes == 4 * interior(h.page, h.gpu[0].off, h.T));

    // Retirement leaves the verified encodings usable for local pad minting.
    uint8_t seed[32] = {}, pk[32]; crypto_scalarmult_base(pk, seed);
    const std::string minted = dir + "/bounded-retirement-mint.pads";
    assert(!sh_link_is_dealt(s.link));
    const size_t nr = h.reads.size(), nv = h.verifies.size();
    assert(sh_link_mint_shipment(s.link, seed, seed, seed, 0, 2, pk, minted.c_str()) == SH_OK);
    assert(h.reads.size() == nr && h.verifies.size() == nv);
    assert(unlink(minted.c_str()) == 0);
    check_private(h);
    cleanup(h, meta, act);
    puts("bounded-retirement-integration: mid-batch retirement, authenticated rereads and exact local products passed");
    return 0;
}
