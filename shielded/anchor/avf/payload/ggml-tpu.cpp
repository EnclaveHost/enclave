/*
 * ggml-tpu.cpp -- Enclave Shielded on a phone: the big matmuls of a llama.cpp graph run on the phone's TPU,
 * which lives OUTSIDE the protected VM and sees only masked rows (TPU.md).
 *
 * The trusted half is llama.cpp inside the VM: tokenizer, embeddings, norms, RoPE, attention over the KV cache,
 * activations, sampling. This backend claims the projection MUL_MATs (q,k,v | o | gate,up | down per block) and
 * turns each group into ONE exchange with the untrusted worker:
 *
 *   x' = x / s                      smoothing, public, folded into the public weights
 *   x_in = clip(round(x'/s_in), lane)   the signal lane per channel (public calibration); x_out = the rare rest
 *   q   = x_in + r                  r: a one-time pad, uniform in +-r_amp_i (k times the channel's own lane), CSPRNG
 *   TPU: yq_j = sat16(round(M_j * sum_i Wq[j,i] q_i))         int16 rows in, int16 rows out, int8 public weights
 *   VM:  y_j  = s_out * (yq_j - P_j) + s_in * sw_j * sum_{i in x_out} Wq[j,i] x_out_i
 *        P_j  = round(M_j * sum_i Wq[j,i] r_i)                minted here, never sent; M_j = s_in * sw_j / s_out
 *
 * What crosses the link: q (rows x n_in int16) and yq. Not x, not r, not P, not which entries were outliers.
 * The weights are public. A pad is used for exactly one row of one exchange.
 *
 * Wire (one exchange): -> u8 0xE7, u8 layer, u8 kind, u8 rows, then rows * n_in int16
 *                      <- for each projection of the group in bundle order: rows * n_out int16
 * A reply whose value sits on the int16 rail is counted (the lane was too small for that row); it is not hidden.
 *
 * Pads are minted into a bank by ggml_backend_tpu_mint() (the payload calls it at idle); an exchange that finds the
 * bank empty mints on the spot and says so in the stats, because that time is the honest cost of having no bank.
 */
#include "ggml.h"
#include "ggml-backend.h"
#include "ggml-backend-impl.h"

#include <atomic>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <fcntl.h>
#include <mutex>
#include <string>
#include <sys/mman.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <unordered_map>
#include <vector>
#include "ggml-tpu.h"

#define TPU_LOG(...) do { fprintf(stderr, "[tpu] " __VA_ARGS__); } while (0)

namespace {
struct proj { const char *name; uint32_t n_out; float s_out; int32_t budget; const float *sw; const int8_t *Wq; std::vector<double> M; };
struct pad { std::vector<int16_t> r; std::vector<std::vector<int32_t>> P; };
struct group {
    int layer, kind; uint32_t n_in; float s_in, k; const float *s; const int16_t *sig_q, *r_amp; std::vector<proj> projs;
    std::deque<pad> bank; std::mutex bank_mu;
    /* one exchange serves every projection of the group; the others read it here (keyed by the input's storage) */
    const void *cache_src = nullptr; uint32_t cache_rows = 0, served = 0; std::vector<std::vector<float>> cache;
};
struct state {
    std::vector<group *> groups; std::unordered_map<std::string, std::pair<group *, int>> by_name;
    int link = -1, rows_max = 5; void *map = nullptr; size_t map_len = 0;
    ggml_backend_tpu_stats_t st{};
    std::vector<int16_t> txbuf, rxbuf; std::vector<uint8_t> frame;
};
state &S() { static state s; return s; }

bool rd_all(int fd, void *p, size_t n) { size_t o = 0; while (o < n) { ssize_t r = read(fd, (char *)p + o, n - o); if (r < 0 && errno == EINTR) continue; if (r <= 0) return false; o += (size_t)r; } return true; }
bool wr_all(int fd, const void *p, size_t n) { size_t o = 0; while (o < n) { ssize_t w = write(fd, (const char *)p + o, n - o); if (w < 0 && errno == EINTR) continue; if (w <= 0) return false; o += (size_t)w; } return true; }
int64_t now_us() { return ggml_time_us(); }

/* sum_i Wq[j,i] * v_i for one output row: int8 x int16 products (< 2^22) gathered 256 at a time in int32, then widened */
inline int64_t dot_i8_i16(const int8_t *w, const int16_t *v, uint32_t n) {
    int64_t acc = 0; uint32_t i = 0;
    while (i < n) { const uint32_t e = i + 256 < n ? i + 256 : n; int32_t a = 0; for (; i < e; i++) a += (int32_t)w[i] * (int32_t)v[i]; acc += a; }
    return acc;
}
/* one pad for one row of this group: r from the kernel CSPRNG, P for every projection; re-drawn if a P_j leaves its share of the output lane */
void mint_one(group &g, pad &out) {
    out.r.resize(g.n_in); out.P.resize(g.projs.size());
    std::vector<uint32_t> rnd(g.n_in);
    for (int attempt = 0; attempt < 8; attempt++) {
        size_t got = 0; while (got < rnd.size() * 4) { ssize_t r = getrandom((char *)rnd.data() + got, rnd.size() * 4 - got, 0); if (r < 0 && errno == EINTR) continue; if (r <= 0) abort(); got += (size_t)r; }
        for (uint32_t i = 0; i < g.n_in; i++) { const uint32_t span = 2u * (uint32_t)g.r_amp[i] + 1u; out.r[i] = (int16_t)((int32_t)(((uint64_t)rnd[i] * span) >> 32) - (int32_t)g.r_amp[i]); }
        bool ok = true;
        for (size_t p = 0; p < g.projs.size() && ok; p++) {
            const proj &pr = g.projs[p]; out.P[p].resize(pr.n_out);
            for (uint32_t j = 0; j < pr.n_out; j++) { const int64_t v = llround((double)dot_i8_i16(pr.Wq + (size_t)j * g.n_in, out.r.data(), g.n_in) * pr.M[j]); if (v > pr.budget || v < -pr.budget) { ok = false; break; } out.P[p][j] = (int32_t)v; }
        }
        if (ok) return;
        S().st.pads_redrawn++;
    }
    TPU_LOG("a pad for blk.%d kind %d stayed outside its output budget after 8 draws; the lane recipe is wrong for this group\n", g.layer, g.kind); abort();
}

void exchange(group &g, const float *x, uint32_t rows) {
    state &s = S(); const int64_t t0 = now_us();
    std::vector<pad> pads(rows);
    for (uint32_t r = 0; r < rows; r++) {
        std::unique_lock<std::mutex> lk(g.bank_mu);
        if (!g.bank.empty()) { pads[r] = std::move(g.bank.front()); g.bank.pop_front(); lk.unlock(); }
        else { lk.unlock(); const int64_t m0 = now_us(); mint_one(g, pads[r]); s.st.mint_inline_us += (uint64_t)(now_us() - m0); s.st.pads_minted_inline++; }
    }
    /* mask: the signal lane gets the pad, the rest stays here */
    s.txbuf.resize((size_t)rows * g.n_in);
    std::vector<std::vector<std::pair<uint32_t, int32_t>>> outl(rows);
    const double inv_in = 1.0 / g.s_in;
    for (uint32_t r = 0; r < rows; r++) {
        const float *xr = x + (size_t)r * g.n_in; int16_t *q = s.txbuf.data() + (size_t)r * g.n_in; const int16_t *pr = pads[r].r.data();
        for (uint32_t i = 0; i < g.n_in; i++) {
            const long full = lround((double)xr[i] / g.s[i] * inv_in); const long lane = g.sig_q[i];
            const long in = full > lane ? lane : full < -lane ? -lane : full;
            if (full != in) outl[r].push_back({i, (int32_t)(full - in)});
            q[i] = (int16_t)(in + pr[i]);                                  /* |in| <= lane_i, |r| <= k*lane_i: inside int16 by construction */
        }
        s.st.outlier_entries += outl[r].size();
    }
    const int64_t t1 = now_us();
    uint8_t hdr[4] = { 0xE7, (uint8_t)g.layer, (uint8_t)g.kind, (uint8_t)rows };
    s.frame.resize(4 + s.txbuf.size() * 2); memcpy(s.frame.data(), hdr, 4); memcpy(s.frame.data() + 4, s.txbuf.data(), s.txbuf.size() * 2);
    size_t n_out_total = 0; for (const proj &p : g.projs) n_out_total += p.n_out;
    s.rxbuf.resize((size_t)rows * n_out_total);
    if (!wr_all(s.link, s.frame.data(), s.frame.size()) || !rd_all(s.link, s.rxbuf.data(), s.rxbuf.size() * 2)) { TPU_LOG("the worker link failed mid-exchange (blk.%d kind %d)\n", g.layer, g.kind); abort(); }
    const int64_t t2 = now_us();
    /* unmask */
    g.cache.resize(g.projs.size()); const int16_t *rx = s.rxbuf.data();
    for (size_t p = 0; p < g.projs.size(); p++) {
        const proj &pr = g.projs[p]; g.cache[p].resize((size_t)rows * pr.n_out);
        for (uint32_t r = 0; r < rows; r++) {
            float *y = g.cache[p].data() + (size_t)r * pr.n_out; const int32_t *P = pads[r].P[p].data();
            for (uint32_t j = 0; j < pr.n_out; j++) { const int16_t v = rx[j]; if (v == 32767 || v == -32768 || v == -32767) s.st.saturated++; y[j] = pr.s_out * (float)((int32_t)v - P[j]); }
            for (const auto &o : outl[r]) { const float xo = (float)o.second * g.s_in; for (uint32_t j = 0; j < pr.n_out; j++) y[j] += xo * pr.sw[j] * (float)pr.Wq[(size_t)j * g.n_in + o.first]; }
            rx += pr.n_out;
        }
    }
    const int64_t t3 = now_us();
    s.st.exchanges++; s.st.rows += rows; s.st.bytes_out += s.frame.size(); s.st.bytes_in += s.rxbuf.size() * 2;
    s.st.mask_us += (uint64_t)(t1 - t0); s.st.link_us += (uint64_t)(t2 - t1); s.st.unmask_us += (uint64_t)(t3 - t2);
}

bool claimable(const ggml_tensor *op) {
    state &s = S();
    if (s.link < 0 || op->op != GGML_OP_MUL_MAT) return false;
    const ggml_tensor *w = op->src[0], *x = op->src[1];
    if (!w || !x || x->type != GGML_TYPE_F32 || op->type != GGML_TYPE_F32 || !ggml_is_contiguous(x)) return false;
    if (x->ne[2] != 1 || x->ne[3] != 1 || x->ne[1] < 1 || x->ne[1] > s.rows_max) return false;       /* wider batches (prefill) stay on the VM's CPU */
    auto it = s.by_name.find(w->name); if (it == s.by_name.end()) return false;
    const group &g = *it->second.first; const proj &p = g.projs[(size_t)it->second.second];
    return (uint32_t)x->ne[0] == g.n_in && (uint32_t)w->ne[1] == p.n_out;
}

const char *be_name(ggml_backend_t) { return "ShieldedTPU"; }
void be_free(ggml_backend_t b) { delete b; }
enum ggml_status be_graph_compute(ggml_backend_t, ggml_cgraph *graph) {
    for (int n = 0; n < ggml_graph_n_nodes(graph); n++) {
        ggml_tensor *node = ggml_graph_node(graph, n);
        if (node->op != GGML_OP_MUL_MAT) continue;                         /* views and reshapes carry no work */
        auto it = S().by_name.find(node->src[0]->name);
        if (it == S().by_name.end()) { TPU_LOG("asked for a matmul that is not in the bundle: %s\n", node->src[0]->name); return GGML_STATUS_FAILED; }
        group &g = *it->second.first; const int p = it->second.second; const ggml_tensor *x = node->src[1]; const uint32_t rows = (uint32_t)x->ne[1];
        const bool hit = g.cache_src == x->data && g.cache_rows == rows && !(g.served & (1u << p));
        if (!hit) { exchange(g, (const float *)x->data, rows); g.cache_src = x->data; g.cache_rows = rows; g.served = 0; }
        g.served |= 1u << p;
        memcpy(node->data, g.cache[(size_t)p].data(), (size_t)rows * g.projs[(size_t)p].n_out * sizeof(float));
    }
    return GGML_STATUS_SUCCESS;
}
const ggml_backend_i be_iface = { be_name, be_free, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, be_graph_compute, NULL, NULL, NULL };
ggml_guid_t be_guid() { static ggml_guid g = { 0x7e, 0x50, 0x55, 0x21, 0x9c, 0x04, 0x4d, 0x1b, 0xa6, 0x33, 0x18, 0xe2, 0x5f, 0x90, 0x0c, 0x71 }; return &g; }

const char *dev_name(ggml_backend_dev_t) { return "ShieldedTPU"; }
const char *dev_desc(ggml_backend_dev_t) { return "masked matmul offload to the phone's TPU, outside the protected VM"; }
void dev_memory(ggml_backend_dev_t, size_t *f, size_t *t) { *f = *t = 0; }
enum ggml_backend_dev_type dev_type(ggml_backend_dev_t) { return GGML_BACKEND_DEVICE_TYPE_ACCEL; }   /* never enumerated as a GPU: it is not inside the enclave */
void dev_props(ggml_backend_dev_t d, ggml_backend_dev_props *p) { p->name = dev_name(d); p->description = dev_desc(d); p->type = dev_type(d); p->memory_free = p->memory_total = 0; p->caps = { false, false, true, false }; }
ggml_backend_t dev_init(ggml_backend_dev_t d, const char *) { return new ggml_backend{ be_guid(), be_iface, d, NULL }; }
ggml_backend_buffer_type_t dev_buft(ggml_backend_dev_t) { return ggml_backend_cpu_buffer_type(); }   /* activations stay in VM memory; what leaves is decided in exchange() */
bool dev_supports_op(ggml_backend_dev_t, const ggml_tensor *op) {
    switch (op->op) { case GGML_OP_NONE: case GGML_OP_RESHAPE: case GGML_OP_VIEW: case GGML_OP_PERMUTE: case GGML_OP_TRANSPOSE: return true; case GGML_OP_MUL_MAT: return claimable(op); default: return false; }
}
bool dev_supports_buft(ggml_backend_dev_t, ggml_backend_buffer_type_t b) { return ggml_backend_buft_is_host(b); }
bool dev_offload_op(ggml_backend_dev_t, const ggml_tensor *op) { return claimable(op); }               /* the weights sit in a host buffer on the CPU backend: this is how the node comes here */
const ggml_backend_device_i dev_iface = { dev_name, dev_desc, dev_memory, dev_type, dev_props, dev_init, dev_buft, NULL, NULL, dev_supports_op, dev_supports_buft, dev_offload_op, NULL, NULL, NULL };
const char *reg_name(ggml_backend_reg_t) { return "ShieldedTPU"; }
size_t reg_count(ggml_backend_reg_t) { return 1; }
ggml_backend_dev_t reg_dev(ggml_backend_reg_t reg, size_t) { static ggml_backend_device dev = { dev_iface, reg, NULL }; return &dev; }
const ggml_backend_reg_i reg_iface = { reg_name, reg_count, reg_dev, NULL };
}  // namespace

extern "C" ggml_backend_reg_t ggml_backend_tpu_reg(void) { static ggml_backend_reg reg = { GGML_BACKEND_API_VERSION, reg_iface, NULL }; return &reg; }
#ifdef GGML_BACKEND_DL
GGML_BACKEND_DL_IMPL(ggml_backend_tpu_reg)
#endif

/* The public lane bundle (tpu/make_graphs.py). Mapped read-only; every array is copied out of nothing: the pointers ARE the file. */
extern "C" int ggml_backend_tpu_open_bundle(const char *path) {
    state &s = S(); int fd = open(path, O_RDONLY | O_CLOEXEC); if (fd < 0) { TPU_LOG("bundle %s: %s\n", path, strerror(errno)); return -1; }
    struct stat sb; if (fstat(fd, &sb) != 0 || sb.st_size < 16) { close(fd); return -1; }
    void *m = mmap(NULL, (size_t)sb.st_size, PROT_READ, MAP_PRIVATE, fd, 0); close(fd); if (m == MAP_FAILED) { TPU_LOG("bundle mmap: %s\n", strerror(errno)); return -1; }
    const uint8_t *b = (const uint8_t *)m, *e = b + sb.st_size; if (memcmp(b, "ETPUB001", 8)) { TPU_LOG("bundle magic\n"); munmap(m, (size_t)sb.st_size); return -1; }
    uint32_t n; memcpy(&n, b + 8, 4); size_t off = 16;
    auto al8 = [](size_t o) { return (o + 7) & ~(size_t)7; };
    for (uint32_t gi = 0; gi < n; gi++) {
        if (b + off + 16 > e) goto bad;
        { group *g = new group; uint16_t layer; uint8_t kind, np; memcpy(&layer, b + off, 2); kind = b[off + 2]; np = b[off + 3]; memcpy(&g->n_in, b + off + 4, 4); memcpy(&g->s_in, b + off + 8, 4); memcpy(&g->k, b + off + 12, 4);
          g->layer = layer; g->kind = kind; off += 16;
          if (np < 1 || np > 3 || g->n_in < 1 || g->n_in > (1u << 20) || b + off + (size_t)g->n_in * 8 > e) goto bad;
          g->s = (const float *)(b + off); off += (size_t)g->n_in * 4; g->sig_q = (const int16_t *)(b + off); off += (size_t)g->n_in * 2; g->r_amp = (const int16_t *)(b + off); off += (size_t)g->n_in * 2; off = al8(off);
          for (uint8_t p = 0; p < np; p++) {
              if (b + off + 76 > e) goto bad;
              proj pr; pr.name = (const char *)(b + off); memcpy(&pr.n_out, b + off + 64, 4); memcpy(&pr.s_out, b + off + 68, 4); memcpy(&pr.budget, b + off + 72, 4); off += 76;
              if (pr.n_out < 1 || pr.n_out > (1u << 20) || b + off + (size_t)pr.n_out * 4 + (size_t)pr.n_out * g->n_in > e || memchr(pr.name, 0, 64) == NULL) goto bad;
              pr.sw = (const float *)(b + off); off += (size_t)pr.n_out * 4; pr.Wq = (const int8_t *)(b + off); off += (size_t)pr.n_out * g->n_in; off = al8(off);
              pr.M.resize(pr.n_out); for (uint32_t j = 0; j < pr.n_out; j++) pr.M[j] = (double)g->s_in * (double)pr.sw[j] / (double)pr.s_out;
              s.by_name[pr.name] = { g, (int)p }; g->projs.push_back(std::move(pr));
          }
          s.groups.push_back(g); }
    }
    s.map = m; s.map_len = (size_t)sb.st_size;
    TPU_LOG("bundle %s: %u exchange groups, %zu projections, k=%.1f\n", path, n, s.by_name.size(), s.groups.empty() ? 0.0 : (double)s.groups[0]->k);
    return 0;
bad:
    TPU_LOG("bundle %s is malformed at byte %zu\n", path, off); munmap(m, (size_t)sb.st_size); s.groups.clear(); s.by_name.clear(); return -1;
}
extern "C" void ggml_backend_tpu_set_link(int fd, int rows_max) { S().link = fd; if (rows_max >= 1 && rows_max <= 64) S().rows_max = rows_max; }
extern "C" int ggml_backend_tpu_claims(const char *tensor_name) { return S().by_name.count(tensor_name) ? 1 : 0; }
/* Fill every group's bank to `positions` pads on `threads` threads. Idle-time work: one position costs about one CPU pass over the projections. */
extern "C" double ggml_backend_tpu_mint(int positions, int threads) {
    state &s = S(); if (threads < 1) threads = 1; const int64_t t0 = now_us(); std::atomic<size_t> next{0}; std::vector<std::thread> th;
    for (int t = 0; t < threads; t++) th.emplace_back([&] {
        for (;;) { const size_t gi = next.fetch_add(1); if (gi >= s.groups.size()) return; group &g = *s.groups[gi];
            for (;;) { { std::lock_guard<std::mutex> lk(g.bank_mu); if ((int)g.bank.size() >= positions) break; } pad p; mint_one(g, p); std::lock_guard<std::mutex> lk(g.bank_mu); g.bank.push_back(std::move(p)); } } });
    for (auto &x : th) x.join();
    const double sec = (now_us() - t0) / 1e6; s.st.mint_bank_us += (uint64_t)(sec * 1e6); return sec;
}
extern "C" void ggml_backend_tpu_get_stats(ggml_backend_tpu_stats_t *out, int reset) { *out = S().st; size_t left = (size_t)-1; for (group *g : S().groups) { std::lock_guard<std::mutex> lk(g->bank_mu); if (g->bank.size() < left) left = g->bank.size(); } out->bank_min = S().groups.empty() ? 0 : left; if (reset) S().st = ggml_backend_tpu_stats_t{}; }
/* The arithmetic the TPU is REQUIRED to perform, as a loop over a connection: used by the host test as the worker, and the
 * definition the on-phone layer check compares the real TPU against (measured: at most one int16 step apart). */
extern "C" int ggml_backend_tpu_reference_worker(int fd) {
    state &s = S(); std::vector<int16_t> q, y; uint8_t hdr[4];
    while (rd_all(fd, hdr, 4)) {
        if (hdr[0] != 0xE7) return -1;
        group *g = nullptr; for (group *c : s.groups) if (c->layer == hdr[1] && c->kind == hdr[2]) { g = c; break; }
        if (!g || hdr[3] < 1) return -1;
        const uint32_t rows = hdr[3]; q.resize((size_t)rows * g->n_in); if (!rd_all(fd, q.data(), q.size() * 2)) return -1;
        for (const proj &p : g->projs) {
            y.resize((size_t)rows * p.n_out);
            for (uint32_t r = 0; r < rows; r++) for (uint32_t j = 0; j < p.n_out; j++) {
                long long v = llround((double)dot_i8_i16(p.Wq + (size_t)j * g->n_in, q.data() + (size_t)r * g->n_in, g->n_in) * p.M[j]);
                y[(size_t)r * p.n_out + j] = (int16_t)(v > 32767 ? 32767 : v < -32767 ? -32767 : v);
            }
            if (!wr_all(fd, y.data(), y.size() * 2)) return -1;
        }
    }
    return 0;
}
