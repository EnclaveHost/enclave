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
 *        MODULAR bundles (--modular, k field = -1) instead send q = (x_in + r) mod m_i taken in [-m_i/2, m_i/2), with
 *        r uniform on the whole per-channel power-of-two modulus m_i >= 2*sig_q_i+1. What crosses the link is then
 *        UNIFORM and independent of x_in (an information-theoretic one-time pad, per use), where the bounded pad above
 *        only hides x_in statistically: an entry of x_in + r near the edge of its range confines x_in to an interval,
 *        and against a PUBLIC model that is enough to identify the token (PROGRESS-nonlinear-masking.md, E1).
 *        The wrap x_in = q - r + m_i*c_i is known here and joins the sparse out-of-lane correction below.
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
 * Pads are minted in batches (mint_batch: exact integer SDOT sums, tiled like a GEMM) into a bank by ggml_backend_tpu_mint()
 * and kept full by the optional background minters; an exchange that finds the bank empty mints on the spot and says so in
 * the stats, because that time is the honest cost of having no bank.
 */
#include "ggml.h"
#include "ggml-backend.h"
#include "ggml-backend-impl.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
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
#include <sys/socket.h>
#include <linux/vm_sockets.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <unordered_map>
#include <vector>
#include "ggml-tpu.h"
#if defined(__ARM_NEON)
#include <arm_neon.h>
#endif

/* stderr is NOT relayed out of the VM, so every TPU_LOG so far has been invisible to anyone reading a
 * run -- including "bundle malformed", the minter's abort, and the rail budget's refusal. A refusal
 * nobody can see is not a refusal anybody can verify. The engine installs a sink that reaches the
 * control channel; until it does, stderr is the fallback. */
static void (*g_log_sink)(const char *) = nullptr;
#define TPU_LOG(...) do { \
    if (g_log_sink) { char _b[512]; snprintf(_b, sizeof _b, "tpu: " __VA_ARGS__); g_log_sink(_b); } \
    else fprintf(stderr, "[tpu] " __VA_ARGS__); } while (0)

namespace {
struct proj { const char *name; uint32_t n_out; float s_out; int32_t budget; const float *sw; const int8_t *Wq; std::vector<double> M; };
struct pad { std::vector<int16_t> r; std::vector<std::vector<int16_t>> P; };   /* |P_j| <= the projection's budget < 32767 by construction */
/* Set from the bundle magic: ETPUB002 graphs take the masked row as two int8 digits, q = 256*hi + lo, stacked as
 * rows (hi first). Same bytes out, half the weight bytes the TPU streams, double the reply. */
static bool s_digit_split = false;

struct group {
    int layer, kind; uint32_t n_in; float s_in, k; const float *s; const int16_t *sig_q, *r_amp; std::vector<proj> projs;
    /* modular bundles (k < 0): r_amp holds log2(m_i) and mod[i] = m_i, a per-channel power-of-two modulus >= 2*sig_q_i+1.
     * The pad is then uniform on the WHOLE modulus, so what crosses the link is uniform and independent of x. */
    bool modular = false; std::vector<int32_t> mod;
    std::deque<pad> bank; std::mutex bank_mu; size_t minting = 0; bool fast = false;   /* fast: the batched integer minter's bounds hold */
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

static std::atomic<uint64_t> g_rx_calls{0}, g_rx_bytes{0};
bool rd_all(int fd, void *p, size_t n) { size_t o = 0; while (o < n) { ssize_t r = read(fd, (char *)p + o, n - o); if (r < 0 && errno == EINTR) continue; if (r <= 0) return false; o += (size_t)r; g_rx_calls.fetch_add(1, std::memory_order_relaxed); } return true; }
bool wr_all(int fd, const void *p, size_t n) { size_t o = 0; while (o < n) { ssize_t w = write(fd, (const char *)p + o, n - o); if (w < 0 && errno == EINTR) continue; if (w <= 0) return false; o += (size_t)w; } return true; }
int64_t now_us() { return ggml_time_us(); }

/* MEASURED AND OFF BY DEFAULT (2026-09-19). The idea was to skip the cold vCPU wake that collects the reply -- about
 * 360 us in the guest plus 160-200 us on the host, against 21-27 us for a hot hand-off (LOCAL.md trap 4) -- by
 * spinning on the socket for a bounded window instead of sleeping. It does the opposite. Same phone, same H=4
 * digit-split graphs, back to back:
 *
 *     blocking read   link 4.284 ms   0.91 tok/s
 *     spin 4000 us    link 7.180 ms   0.70 tok/s   (of which 3.937 ms spun, then it blocked anyway)
 *
 * The worker's own clock says it answered in 3.19 ms, so a 4 ms window should have caught the reply and did not:
 * the spin does not merely fail to help, it DELAYS delivery. The guest's vCPUs and the app's TPU worker are threads
 * on the same six big cores, and a spinning vCPU at decode uclamp starves the path that carries the reply across.
 * There is no idle core on this phone to spin on, which is the whole reason the work was pushed to the TPU.
 *
 * Kept behind ANCHOR_TPU_SPIN_US (default 0) so the result can be re-checked on hardware with cores to spare. */
int link_spin_us() {
    static const int v = []{ const char *e = getenv("ANCHOR_TPU_SPIN_US"); int n = e ? atoi(e) : 0; return n < 0 ? 0 : n > 50000 ? 50000 : n; }();
    return v;
}
bool rd_all_spin(int fd, void *p, size_t n, uint64_t *spun_us) {
    size_t o = 0; const int win = link_spin_us();
    if (win > 0) {
        const int64_t t0 = now_us(), deadline = t0 + win;
        while (o < n) {
            ssize_t r = recv(fd, (char *)p + o, n - o, MSG_DONTWAIT);
            if (r > 0) { o += (size_t)r; g_rx_calls.fetch_add(1, std::memory_order_relaxed); continue; }
            if (r == 0) return false;
            if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) return false;
            if (now_us() >= deadline) break;
        }
        if (spun_us) *spun_us += (uint64_t)(now_us() - t0);
    }
    return o >= n ? true : rd_all(fd, (char *)p + o, n - o);
}

/* sum_i Wq[j,i] * v_i for one output row: int8 x int16 products (< 2^22) gathered 256 at a time in int32, then widened */
inline int64_t dot_i8_i8(const int8_t *w, const int8_t *v, uint32_t n) {
    int64_t a = 0; for (uint32_t i = 0; i < n; i++) a += (int32_t)w[i] * (int32_t)v[i]; return a;
}
/* q = 256*hi + lo, both digits in [-128, 127]: the decomposition the digit-split wire uses.
 * Written WITHOUT shifts of negative values. A left shift of a negative is undefined in C++17 (it only
 * became defined in C++20) and build.sh compiles this as C++17; a right shift of a negative is
 * implementation-defined. Three places have to agree BIT-EXACTLY or the pad and the wire diverge -- the
 * send path, the minter's pad split, and the audit's exact recompute -- and they were three different
 * expressions, two of them shifting negatives. `(uint32_t)v & 0xFF` is modular and defined for negative
 * v; `v - lo` is an exact multiple of 256 so the division neither rounds nor depends on sign rules.
 * tpu/test/digit-split-test.cpp checks both digits over the whole int16 range under UBSan. */
static inline int32_t digit_lo(int32_t v) { const int32_t m = (int32_t)((uint32_t)v & 0xFFu); return m >= 128 ? m - 256 : m; }
static inline int32_t digit_hi(int32_t v) { return (v - digit_lo(v)) / 256; }

inline int64_t dot_i8_i16(const int8_t *w, const int16_t *v, uint32_t n) {
    int64_t acc = 0; uint32_t i = 0;
    while (i < n) { const uint32_t e = i + 256 < n ? i + 256 : n; int32_t a = 0; for (; i < e; i++) a += (int32_t)w[i] * (int32_t)v[i]; acc += a; }
    return acc;
}
/* Batched minting. One pad alone streams every weight row from memory for ONE dot product (memory-bound: 0.11-0.17 s per
 * position on this phone). A batch reads each weight row once and dots it against many pads, which is prefill's arithmetic.
 * The pad must cancel EXACTLY, so the sums stay integer: r = 256*hi + lo with lo = (int8)r, and
 *   sum_i Wq r  =  256 * sum_i Wq hi  +  sum_i Wq lo        two int8 x int8 dots (SDOT), bit-identical to dot_i8_i16.
 * Bounds (checked per group at open, else the scalar path): |hi| <= 127 needs r_amp <= 32384; an int32 sum of n_in products
 * of at most 127*128 needs n_in < 2^17. */
inline void dot8_i8(const int8_t *w, const int8_t *const v[8], uint32_t n, int32_t out[8]) {   /* out[k] += sum_i w[i] * v[k][i] */
    uint32_t i = 0;
#if defined(__ARM_NEON) && defined(__ARM_FEATURE_DOTPROD)
    int32x4_t a0 = vdupq_n_s32(0), a1 = a0, a2 = a0, a3 = a0, a4 = a0, a5 = a0, a6 = a0, a7 = a0;
    for (; i + 16 <= n; i += 16) {
        const int8x16_t ww = vld1q_s8(w + i);
        a0 = vdotq_s32(a0, ww, vld1q_s8(v[0] + i)); a1 = vdotq_s32(a1, ww, vld1q_s8(v[1] + i)); a2 = vdotq_s32(a2, ww, vld1q_s8(v[2] + i)); a3 = vdotq_s32(a3, ww, vld1q_s8(v[3] + i));
        a4 = vdotq_s32(a4, ww, vld1q_s8(v[4] + i)); a5 = vdotq_s32(a5, ww, vld1q_s8(v[5] + i)); a6 = vdotq_s32(a6, ww, vld1q_s8(v[6] + i)); a7 = vdotq_s32(a7, ww, vld1q_s8(v[7] + i));
    }
    out[0] += vaddvq_s32(a0); out[1] += vaddvq_s32(a1); out[2] += vaddvq_s32(a2); out[3] += vaddvq_s32(a3); out[4] += vaddvq_s32(a4); out[5] += vaddvq_s32(a5); out[6] += vaddvq_s32(a6); out[7] += vaddvq_s32(a7);
#endif
    for (int k = 0; k < 8; k++) { int32_t a = 0; const int8_t *vk = v[k]; for (uint32_t t = i; t < n; t++) a += (int32_t)w[t] * (int32_t)vk[t]; out[k] += a; }
}
bool mint_fast(const group &g) {
    if (g.n_in >= (1u << 17)) return false;
    if (g.modular) { for (uint32_t i = 0; i < g.n_in; i++) if (g.mod[i] > 32768) return false; return true; }   /* |r| <= m/2 <= 16384 */
    for (uint32_t i = 0; i < g.n_in; i++) if (g.r_amp[i] > 32384) return false;
    return true;
}
uint32_t mint_width(const group &) { return 64; }
void fill_random(void *p, size_t n) { size_t got = 0; while (got < n) { ssize_t r = getrandom((char *)p + got, n - got, 0); if (r < 0 && errno == EINTR) continue; if (r <= 0) abort(); got += (size_t)r; } }

/* At least `want` pads for rows of this group, appended to `out` (up to 3 more: the kernel works four pads at a time, and a
 * pad is a pad). r from the kernel CSPRNG, P for every projection; a pad with a P_j outside its share of the output lane is
 * dropped and drawn again. `scalar` forces the reference arithmetic (the self-check compares the two). */
void mint_batch(group &g, size_t want, std::vector<pad> &out, bool scalar = false) {
    static thread_local std::vector<uint32_t> rnd; static thread_local std::vector<int8_t> hl; static thread_local std::vector<int32_t> acc;       /* kept per thread: fresh pages are expensive in a protected VM */
    const bool fast = !scalar && g.fast; const uint32_t n = g.n_in, width = fast ? mint_width(g) : 1; const size_t goal = out.size() + want;
    for (int barren = 0; out.size() < goal; ) {
        if (barren >= 8) { TPU_LOG("8 draws in a row for blk.%d kind %d stayed outside their output budget; the lane recipe is wrong for this group\n", g.layer, g.kind); abort(); }
        const size_t left = goal - out.size(); const uint32_t B = fast ? (uint32_t)(left >= width ? width : (left + 3) & ~(size_t)3) : 1;
        rnd.resize((size_t)B * n); fill_random(rnd.data(), rnd.size() * 4);
        std::vector<pad> pads(B); std::vector<char> ok(B, 1);
        for (uint32_t b = 0; b < B; b++) {
            pads[b].r.resize(n); pads[b].P.resize(g.projs.size()); for (size_t p = 0; p < g.projs.size(); p++) pads[b].P[p].resize(g.projs[p].n_out);
            const uint32_t *u = rnd.data() + (size_t)b * n; int16_t *r = pads[b].r.data();
            if (g.modular) {   /* uniform on the whole modulus, centred: r_i in [-m_i/2, m_i/2) */
                for (uint32_t i = 0; i < n; i++) { const uint32_t m = (uint32_t)g.mod[i]; r[i] = (int16_t)((int32_t)(((uint64_t)u[i] * m) >> 32) - (int32_t)(m >> 1)); }
            } else {
                for (uint32_t i = 0; i < n; i++) { const uint32_t span = 2u * (uint32_t)g.r_amp[i] + 1u; r[i] = (int16_t)((int32_t)(((uint64_t)u[i] * span) >> 32) - (int32_t)g.r_amp[i]); }
            }
        }
        if (!fast) {
            for (size_t p = 0; p < g.projs.size() && ok[0]; p++) { const proj &pr = g.projs[p];
                for (uint32_t j = 0; j < pr.n_out; j++) { const int64_t v = llround((double)dot_i8_i16(pr.Wq + (size_t)j * n, pads[0].r.data(), n) * pr.M[j]); if (v > pr.budget || v < -pr.budget) { ok[0] = 0; break; } pads[0].P[p][j] = (int16_t)v; } }
        } else {
            hl.resize((size_t)2 * B * n);                                   /* [b] hi rows, then [B + b] lo rows */
            for (uint32_t b = 0; b < B; b++) { const int16_t *r = pads[b].r.data(); int8_t *hi = hl.data() + (size_t)b * n, *lo = hl.data() + (size_t)(B + b) * n;
                for (uint32_t i = 0; i < n; i++) { const int32_t v = r[i]; lo[i] = (int8_t)digit_lo(v); hi[i] = (int8_t)digit_hi(v); } }
            /* Tiled like a GEMM, because the dot is faster than the caches behind it: a tile of weight rows (TJ x TC bytes) stays
             * in L2 while four pads' hi and lo chunks (8 x TC bytes) stay in L1; partial sums wait in acc[row][pad][hi|lo]. */
            const uint32_t TC = n < 1536 ? n : 1536, TJ = (262144u / TC) < 1 ? 1 : 262144u / TC; acc.resize((size_t)TJ * B * 2);
            for (size_t p = 0; p < g.projs.size(); p++) { const proj &pr = g.projs[p];
                for (uint32_t j0 = 0; j0 < pr.n_out; j0 += TJ) { const uint32_t jn = pr.n_out - j0 < TJ ? pr.n_out - j0 : TJ;
                    std::fill(acc.begin(), acc.begin() + (size_t)jn * B * 2, 0);
                    for (uint32_t c0 = 0; c0 < n; c0 += TC) { const uint32_t cn = n - c0 < TC ? n - c0 : TC;
                        for (uint32_t b = 0; b < B; b += 4) {
                            const int8_t *v[8]; for (uint32_t t = 0; t < 4; t++) { v[t] = hl.data() + (size_t)(b + t) * n + c0; v[4 + t] = hl.data() + (size_t)(B + b + t) * n + c0; }
                            for (uint32_t j = 0; j < jn; j++) { int32_t *a = acc.data() + ((size_t)j * B + b) * 2; int32_t o[8] = { a[0], a[2], a[4], a[6], a[1], a[3], a[5], a[7] };
                                dot8_i8(pr.Wq + (size_t)(j0 + j) * n + c0, v, cn, o); a[0] = o[0]; a[2] = o[1]; a[4] = o[2]; a[6] = o[3]; a[1] = o[4]; a[3] = o[5]; a[5] = o[6]; a[7] = o[7]; }
                        } }
                    for (uint32_t j = 0; j < jn; j++) { const double M = pr.M[j0 + j];
                        for (uint32_t b = 0; b < B; b++) { const int32_t *a = acc.data() + ((size_t)j * B + b) * 2; const int64_t v64 = llround((double)(256 * (int64_t)a[0] + (int64_t)a[1]) * M);
                            if (v64 > pr.budget || v64 < -pr.budget) ok[b] = 0; else pads[b].P[p][j0 + j] = (int16_t)v64; } }
                } }
        }
        const size_t before = out.size();
        for (uint32_t b = 0; b < B; b++) { if (ok[b]) out.push_back(std::move(pads[b])); else S().st.pads_redrawn++; }
        barren = out.size() == before ? barren + 1 : 0;
    }
}

/* Minting inside the link window. After the out-of-lane correction there is still ~3.9 ms per exchange in which this
 * thread has nothing to do but wait for the worker, and a pad depends on NOTHING -- not the request, not the reply --
 * so it is the ideal filler. One position (a pad for each of the 140 groups) costs about 48 ms on one vCPU, against
 * 545 ms of window per token, so decode's own demand fits in the window many times over and the background minter
 * thread, which competes with the worker for the same six cores, can be switched off entirely.
 *
 * Emptiest group first, a few pads at a time (mint_batch rounds a small ask up to 4), with the deadline checked
 * BETWEEN batches: a batch cannot be preempted, so the chunk is kept small rather than trying to predict its cost.
 * Overrunning only delays a read whose data is already sitting in the socket. */
static std::atomic<int> g_window_target{0};
static std::atomic<unsigned> g_window_chunk{8};
static void mint_window(int64_t deadline_us) {
    const int target = g_window_target.load(std::memory_order_relaxed); if (target <= 0) return;
    state &s = S(); const size_t chunk = g_window_chunk.load(std::memory_order_relaxed);
    while (now_us() < deadline_us) {
        group *low = nullptr; size_t low_n = (size_t)target;
        for (group *g : s.groups) { std::lock_guard<std::mutex> lk(g->bank_mu); const size_t n = g->bank.size() + g->minting; if (n < low_n) { low_n = n; low = g; } }
        if (!low) return;                                                  /* every bank is at target */
        const size_t ask = std::min<size_t>((size_t)target - low_n, chunk);
        { std::lock_guard<std::mutex> lk(low->bank_mu); low->minting += ask; }
        const int64_t b0 = now_us(); std::vector<pad> fresh; mint_batch(*low, ask, fresh);
        { std::lock_guard<std::mutex> lk(low->bank_mu); low->minting -= ask; for (pad &p : fresh) low->bank.push_back(std::move(p)); }
        s.st.pads_refilled += fresh.size(); s.st.window_mint_us += (uint64_t)(now_us() - b0);
    }
}
/* Is the 2.18 ms round trip LATENCY or BYTES? Everything downstream turns on it: if it is latency, only
 * fewer exchanges help and batching rows is the lever; if it is bytes, the reply size is. The decode
 * numbers cannot separate them because the TPU's own time moves with the same variable. So: a frame the
 * worker answers immediately with `bytes` of nothing, timed through the REAL path -- same socket, same
 * bounce buffers, same wakes -- with the TPU out of it entirely.
 *   <- u8 0xE9, u8 0, u16 reply bytes/64        -> that many bytes
 * Writes "PING <bytes> <n> <median us>" through TPU_LOG for each size. */
extern "C" void ggml_backend_tpu_ping_bench(int reps) {
    state &s = S(); if (s.link < 0) return; if (reps < 1) reps = 50;
    static const int sizes[] = { 64, 4096, 24576, 122880 };
    for (int si = 0; si < 4; si++) {
        const int want = sizes[si]; std::vector<uint8_t> rx((size_t)want); std::vector<double> us((size_t)reps);
        uint8_t hdr[4] = { 0xE9, 0, (uint8_t)((want / 64) & 0xff), (uint8_t)((want / 64) >> 8) };
        for (int i = 0; i < reps; i++) {
            const int64_t t0 = now_us();
            if (!wr_all(s.link, hdr, 4) || !rd_all(s.link, rx.data(), rx.size())) { TPU_LOG("PING link failed at %d B\n", want); return; }
            us[(size_t)i] = (double)(now_us() - t0);
        }
        std::sort(us.begin(), us.end());
        TPU_LOG("PING %6d B: median %7.1f us  min %7.1f us  (n=%d)\n", want, us[(size_t)reps / 2], us[0], reps);
    }
}

extern "C" void ggml_backend_tpu_window_mint(int target, int chunk) {
    g_window_target.store(target < 0 ? 0 : target, std::memory_order_relaxed);
    if (chunk >= 1 && chunk <= 64) g_window_chunk.store((unsigned)chunk, std::memory_order_relaxed);
}

/* The correction pays for itself but not in full: run inline it occupies the core the app's TPU worker wants, and the
 * reply that used to arrive 4.28 ms after publish then arrives at 5.56. The work is not the problem, its PLACEMENT is
 * - the decode thread should be asleep on the socket so the worker gets a core, while the correction runs on one of
 * the five vCPUs that are otherwise idle. So: a single persistent helper, posted after the write and joined after the
 * read. One helper, not a pool: four scalar minters once took the link from 4.3 to 7.7 ms, and this phone punishes
 * every extra runnable thread. ANCHOR_TPU_CORR_THREAD=0 puts it back inline. */
/* One (projection, row) is an independent piece of the correction: it writes its own slice of the cache and reads
 * only public weights, so it parallelises with no sharing at all. That matters for speculative rows, where the work
 * scales with them -- one row's correction fits the link window with room over, five rows' does not. */
static void corr_one(group &g, const std::vector<std::vector<std::pair<uint32_t, int32_t>>> &outl, uint32_t rows, size_t p, uint32_t r) {
    const proj &pr = g.projs[p]; (void)rows;
    float *y = g.cache[p].data() + (size_t)r * pr.n_out;
    /* Accumulate the correction as INTEGERS and scale once. The term is s_in * sw[j] * sum_i delta_i *
     * W[j][i], and that sum is exact in int64 -- so it is independent of how many out-of-lane entries
     * there are and of the order they are added in. That matters because the count is PAD-DEPENDENT: a
     * modular wrap is a function of the pad, so three runs of the same prompt kept 394433 / 394590 /
     * 394756 entries, and in float32 that is a different rounding each time. Two runs agreed and the
     * third flipped a token at a near-tie (95 % identical, diverging at the same character the clipped
     * runs did). Integer accumulation removes that source: same inputs, same bytes, whatever pad. */
    static thread_local std::vector<int64_t> acc; if (acc.size() < pr.n_out) acc.assign(pr.n_out, 0);
    std::fill(acc.begin(), acc.begin() + pr.n_out, (int64_t)0);
    for (const auto &o : outl[r]) {
        const int64_t d = (int64_t)o.second; const int8_t *w = pr.Wq + o.first; const size_t stride = g.n_in;
        for (uint32_t j = 0; j < pr.n_out; j++) { if (j + 24 < pr.n_out) __builtin_prefetch(w + (size_t)(j + 24) * stride, 0, 0);
            acc[j] += d * (int64_t)w[(size_t)j * stride]; }
    }
    for (uint32_t j = 0; j < pr.n_out; j++) y[j] = (float)((double)acc[j] * (double)g.s_in * (double)pr.sw[j]);
}
static void corr_run(group &g, const std::vector<std::vector<std::pair<uint32_t, int32_t>>> &outl, uint32_t rows) {
    g.cache.resize(g.projs.size());
    for (size_t p = 0; p < g.projs.size(); p++) g.cache[p].resize((size_t)rows * g.projs[p].n_out);
    for (size_t p = 0; p < g.projs.size(); p++) for (uint32_t r = 0; r < rows; r++) corr_one(g, outl, rows, p, r);
}
/* The repair, behind a switch so the two arms of a before/after comparison differ in NOTHING else.
 * Off reproduces the defect exactly: the clipped reply is consumed as if correct. */
static constexpr bool kRepairClips = true;
/* Repairing a clip costs one dot product, and at the natural rate (<1 per token) that is free. But the
 * worker is UNTRUSTED and can rail replies deliberately: at 100% it would drag the entire matmul back
 * into the VM and silently defeat the offload. Not a confidentiality or correctness break -- the VM
 * computes the right answer from public weights either way -- but a denial-of-service lever, and the
 * peer tier treats an out-of-range reply as a protocol violation for exactly this reason. So bound it:
 * repair the rare case, and if a single exchange rails more than an eighth of its outputs (three orders
 * of magnitude above the natural rate) say so, and abort if it persists. Same precedent as mint_batch's
 * 8-consecutive-bad-draws abort. */
/* A WORK BUDGET, spent before the expensive dot rather than audited after it.
 *
 * Two things were wrong with the first attempt. It counted genuine clips, so a worker returning rails
 * for in-range products forced every recomputation and incremented nothing. And it was a consecutive-
 * exchange run-length trigger, so alternating a full flood with one normal exchange reset it forever
 * while still forcing unbounded total work. Both are fixed by gating the COST itself: every rail-
 * triggered recomputation must take a token from a leaky bucket before it may run, whatever the
 * trusted value turns out to be.
 *
 * The bucket refills per exchange, so a genuine burst is absorbed, but the long-run average is capped
 * at kRailRefill dots per exchange regardless of the pattern the worker chooses. Natural rate is about
 * 0.006 rails per exchange, so 4 is ~600x headroom and still bounds the forced work to ~0.2 % of the
 * MACs the exchange already costs. Exhaustion is a protocol violation: the element cannot be trusted
 * and cannot be repaired within budget, so the run stops rather than consuming it. */
static constexpr int64_t kRailRefill = 4;           /* tokens added per exchange */
static constexpr int64_t kRailBucketCap = 4096;     /* burst allowance */
static int64_t g_rail_bucket = kRailBucketCap;
static inline bool rail_budget_take(ggml_backend_tpu_stats_t &st, group &g) {
    if (g_rail_bucket <= 0) {
        TPU_LOG("blk.%d kind %d: rail-recomputation budget exhausted (cap %lld, refill %lld/exchange). A worker "
                "returning rails faster than this is forcing the VM to redo its work: refusing rather than "
                "consuming unverified replies\n", g.layer, g.kind, (long long)kRailBucketCap, (long long)kRailRefill);
        return false;
    }
    --g_rail_bucket; st.rail_recomp_total++; return true;
}
/* The sampled kernel verification recomputes elements on the CRITICAL PATH. It is a validation tool,
 * not free: off by default, on for audits. (The rail test itself IS free -- a predicate on values the
 * unmask has already loaded, with no second pass to fuse.) */
static constexpr bool kVerifyKernel = false;
/* FAULT INJECTION on the real backend path: rewrite the reply the worker sent, before the unmask sees
 * it, exactly as a malicious or broken worker could. This is how the integrity claims are tested rather
 * than argued -- a bound that is never driven is a bound nobody has checked.
 *   0  off (shipping)
 *   1  ALL-FALSE-RAILS: every reply value becomes +32767 though the trusted products are in range
 *   2  SPARSE false rails: ~0.2 per exchange, so the bound is NOT hit and the repair must still reject
 *   3  FLOOD/NORMAL: alternate exchanges between all-rails and untouched, to test recovery not just trip
 * Injection happens after the read and before any interpretation, so everything downstream -- detection,
 * recomputation, the DoS bound, the repair -- runs on data indistinguishable from a hostile worker's. */
static constexpr int kInjectFault = 0;
static void inject_fault(int16_t *rx, size_t n, uint64_t exchange) {
    if (kInjectFault == 1) { for (size_t i = 0; i < n; i++) rx[i] = 32767; }
    /* The loop starts at i=0, so this is EXACTLY ONE false rail per non-empty exchange for every reply this
     * lane produces (the largest is far below 200000 elements) -- not the "~0.2 per exchange" an earlier
     * comment here claimed. One is still below the refill rate of kRailRefill, which is the property the
     * experiment needs: the budget must never fire, so the repair has to reject the rails on its own. */
    else if (kInjectFault == 2) { for (size_t i = 0; i < n; i += 200000) rx[i] = 32767; }
    else if (kInjectFault == 3 && (exchange & 1)) { for (size_t i = 0; i < n; i++) rx[i] = 32767; }
}
static bool corr_threaded() {
    static const bool v = []{ const char *e = getenv("ANCHOR_TPU_CORR_THREAD"); return !e || atoi(e) != 0; }();
    return v;
}
struct corr_job {
    std::mutex mu; std::condition_variable cv_go, cv_done;
    group *g = nullptr; const std::vector<std::vector<std::pair<uint32_t, int32_t>>> *outl = nullptr;
    uint32_t rows = 0; bool stop = false, pending = false;
    std::vector<std::thread> pool; size_t nthreads = 0, done = 0;
    std::atomic<size_t> next{0}; uint64_t gen = 0;      /* gen is bumped per post; each worker remembers its OWN last seen */
};
static corr_job g_cj;
static int corr_threads() {
    static const int v = []{ const char *e = getenv("ANCHOR_TPU_CORR_THREADS"); int n = e ? atoi(e) : 1; return n < 1 ? 1 : n > 5 ? 5 : n; }();
    return v;
}
static void corr_post(group &g, const std::vector<std::vector<std::pair<uint32_t, int32_t>>> &outl, uint32_t rows) {
    std::unique_lock<std::mutex> lk(g_cj.mu);
    if (g_cj.pool.empty()) {
        g_cj.nthreads = (size_t)corr_threads();
        for (size_t t = 0; t < g_cj.nthreads; t++) g_cj.pool.emplace_back([] {
            uint64_t seen = 0;                                             /* per-thread, so no worker can consume another's wakeup */
            for (;;) {
                std::unique_lock<std::mutex> lk(g_cj.mu);
                g_cj.cv_go.wait(lk, [&] { return g_cj.gen != seen || g_cj.stop; });
                if (g_cj.stop) return;
                seen = g_cj.gen; group *g = g_cj.g; auto *ol = g_cj.outl; const uint32_t rw = g_cj.rows;
                const size_t total = g->projs.size() * (size_t)rw;
                lk.unlock();
                for (;;) { const size_t i = g_cj.next.fetch_add(1, std::memory_order_relaxed); if (i >= total) break;
                           corr_one(*g, *ol, rw, i / rw, (uint32_t)(i % rw)); }
                lk.lock();
                if (++g_cj.done == g_cj.nthreads) { g_cj.pending = false; g_cj.cv_done.notify_all(); }
            } });
    }
    /* the cache is sized HERE, before the workers are released, so each one only ever writes its own slice */
    g.cache.resize(g.projs.size());
    for (size_t p = 0; p < g.projs.size(); p++) g.cache[p].resize((size_t)rows * g.projs[p].n_out);
    g_cj.g = &g; g_cj.outl = &outl; g_cj.rows = rows;
    g_cj.next.store(0, std::memory_order_relaxed); g_cj.done = 0; g_cj.pending = true; g_cj.gen++;
    g_cj.cv_go.notify_all();
}
static void corr_join() { std::unique_lock<std::mutex> lk(g_cj.mu); g_cj.cv_done.wait(lk, [] { return !g_cj.pending; }); }
/* What this binary actually does, printed into the run's own log. Filenames and my say-so are not
 * evidence of which arm produced a result: two runs recorded "REPAIRED" while the repair was compiled
 * OUT, because the label was a literal rather than the flag. */
extern "C" void ggml_backend_tpu_set_logger(void (*sink)(const char *)) { g_log_sink = sink; }
extern "C" const char *ggml_backend_tpu_config(void) {
    static char b[160];
    snprintf(b, sizeof b, "repair=%d verify=%d inject=%d corr_threads=%d spin_us=%d (built " __DATE__ " " __TIME__ ")",
             kRepairClips ? 1 : 0, kVerifyKernel ? 1 : 0, kInjectFault, corr_threads(), link_spin_us());
    return b;
}
extern "C" void ggml_backend_tpu_corr_stop(void) {
    { std::lock_guard<std::mutex> lk(g_cj.mu); if (g_cj.pool.empty()) return; g_cj.stop = true; g_cj.cv_go.notify_all(); }
    for (auto &t : g_cj.pool) t.join(); g_cj.pool.clear();
}

/* AUDIT: is a reply value sitting on the int16 rail a genuine CLIP or an exact legitimate value?
 *
 * The counter only ever tested `v == 32767 || v == -32768` and then used v anyway. Both causes land
 * there: a product whose true value exceeded the rail (this chip saturates rather than wraps, so the
 * value is CORRUPT), and a product that legitimately rounds to exactly the rail. They are only
 * distinguishable against exact arithmetic, and the VM holds everything needed for it -- the masked row
 * it sent, the public weights, and the requantise multiplier -- so it can recompute that one element
 * exactly and say which happened. This is the same trusted arithmetic the reference worker uses.
 *
 * Cost is one dot product per rail hit, and rail hits are rare by construction (s_out budgets the
 * signal plus `sigmas` of the pad's spread), so this runs always rather than behind a flag. */
static int64_t dot_i8_digit(const int8_t *w, const int16_t *q, uint32_t n, bool high) {
    int64_t a = 0;
    for (uint32_t i = 0; i < n; i++) { const int32_t v = q[i];
        a += (int64_t)w[i] * (int64_t)(high ? digit_hi(v) : digit_lo(v)); }
    return a;
}

void exchange(group &g, const float *x, uint32_t rows) {
    state &s = S(); const int64_t t0 = now_us();
    std::vector<pad> pads; pads.reserve(rows + 3);
    { std::lock_guard<std::mutex> lk(g.bank_mu); while (pads.size() < rows && !g.bank.empty()) { pads.push_back(std::move(g.bank.front())); g.bank.pop_front(); } }
    if (pads.size() < rows) {                                              /* the bank ran dry: mint the rest here, in one batch, and say so */
        const size_t missing = rows - pads.size(); const int64_t m0 = now_us(); mint_batch(g, missing, pads);
        s.st.mint_inline_us += (uint64_t)(now_us() - m0); s.st.pads_minted_inline += missing;
        if (pads.size() > rows) { std::lock_guard<std::mutex> lk(g.bank_mu); while (pads.size() > rows) { g.bank.push_back(std::move(pads.back())); pads.pop_back(); } }
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
            long delta = full - in;                                        /* the rare entry beyond its lane: stays here, exact */
            long sent;
            if (g.modular) {
                /* q_i = ((in_i + r_i) mod m_i) taken in [-m/2, m/2). Uniform on the whole modulus and INDEPENDENT of x:
                 * a one-time pad, per use. The wrap is in_i = q_i - r_i + m_i*c_i with c_i known here, so it joins the
                 * same sparse correction the out-of-lane entries already use (one column of Wq each). */
                const int32_t m = g.mod[i]; const long t = in + (long)pr[i];
                sent = (long)(int32_t)((uint32_t)(t + (m >> 1)) & (uint32_t)(m - 1)) - (m >> 1);
                delta += t - sent;                                         /* = m_i * c_i, an exact multiple of the modulus */
            } else {
                sent = in + (long)pr[i];                                   /* |in| <= lane_i, |r| <= k*lane_i: inside int16 by construction */
            }
            if (delta != 0) outl[r].push_back({i, (int32_t)delta});
            q[i] = (int16_t)sent;
        }
        s.st.outlier_entries += outl[r].size();
    }
    const int64_t t1 = now_us();
    size_t n_out_total = 0; for (const proj &p : g.projs) n_out_total += p.n_out;
    const uint32_t wire_rows = s_digit_split ? 2u * rows : rows;
    if (s_digit_split) {
        /* q = 256*hi + lo with lo in [-128, 127] exactly, so hi = floor((q + 128) / 256). Modular lanes keep
         * |q| <= 16384, hence |hi| <= 64: both digits are inside signed int8 with room to spare. Stack hi rows
         * first, then lo rows, which is the layout make_graphs.py --digit-split authors. The byte count is
         * unchanged (2*rows int8 == rows int16); only the TPU's weight streaming halves. */
        s.frame.resize(4 + (size_t)wire_rows * g.n_in);
        int8_t *d = (int8_t *)(s.frame.data() + 4);
        for (uint32_t r = 0; r < rows; r++) {
            const int16_t *q = s.txbuf.data() + (size_t)r * g.n_in;
            int8_t *hi = d + (size_t)r * g.n_in, *lo = d + (size_t)(rows + r) * g.n_in;
            for (uint32_t i = 0; i < g.n_in; i++) {
                const int32_t v = q[i];
                hi[i] = (int8_t)digit_hi(v); lo[i] = (int8_t)digit_lo(v);
            }
        }
    } else {
        s.frame.resize(4 + s.txbuf.size() * 2); memcpy(s.frame.data() + 4, s.txbuf.data(), s.txbuf.size() * 2);
    }
    { const uint8_t hdr[4] = { (uint8_t)(s_digit_split ? 0xE8 : 0xE7), (uint8_t)g.layer, (uint8_t)g.kind, (uint8_t)rows };
      memcpy(s.frame.data(), hdr, 4); }
    uint64_t rail_recomp = 0;   /* rail-triggered exact recomputations THIS exchange */
    g_rail_bucket = g_rail_bucket + kRailRefill > kRailBucketCap ? kRailBucketCap : g_rail_bucket + kRailRefill;
    s.rxbuf.resize((size_t)wire_rows * n_out_total);
    if (!wr_all(s.link, s.frame.data(), s.frame.size())) { TPU_LOG("the worker link failed mid-exchange (blk.%d kind %d)\n", g.layer, g.kind); abort(); }
    const int64_t t_pub = now_us();
    /* The request is PUBLISHED, so the worker is already computing, and this thread is about to sleep for 4.3 ms.
     * The out-of-lane correction is a function of the REQUEST alone -- outl[] was built while masking and the walk
     * reads only public weights -- so it belongs in that window, not after the reply. This is the engine's
     * sh_pipe_exchange_work contract (shielded, "Fill the ring's spin window with the work that was waiting on
     * it"), which runs the Freivalds RHS there for the same reason: it removes work from the critical path
     * instead of adding a thread, and on this phone there is no spare core to add one to.
     *
     * Wq is row major, so a column is a strided walk (one cache miss per output); the misses are independent, so
     * they are prefetched a few rows ahead and overlap. The first term writes, the rest accumulate, which saves a
     * zeroing pass over the cache; a row with no out-of-lane entries is cleared instead. */
    const bool ct = corr_threaded();
    if (ct) corr_post(g, outl, rows); else corr_run(g, outl, rows);
    const int64_t t_corr = now_us();
    /* whatever is left of the window goes to pads: three quarters of the wait this link has been showing, so a batch
     * that runs long still lands inside it. The estimate starts at 3 ms and follows the measurement. */
    static double wait_ewma_us = 3000.0;
    mint_window(t_corr + (int64_t)(wait_ewma_us * 0.75));
    const int64_t t_mint = now_us();
    if (!rd_all_spin(s.link, s.rxbuf.data(), s.rxbuf.size() * 2, &s.st.spin_us)) { TPU_LOG("the worker link failed waiting for the reply (blk.%d kind %d)\n", g.layer, g.kind); abort(); }
    if (kInjectFault) inject_fault(s.rxbuf.data(), s.rxbuf.size(), s.st.exchanges);
    if (ct) corr_join();                                                   /* the cache must be complete before the reply is added to it */
    const int64_t t2 = now_us();
    wait_ewma_us += 0.05 * ((double)(t2 - t_corr) - wait_ewma_us);
    /* unmask: the correction is already standing in the cache, so the reply ADDS to it */
    const int16_t *rx = s.rxbuf.data();
    for (size_t p = 0; p < g.projs.size(); p++) {
        const proj &pr = g.projs[p];
        /* Digit-split replies carry both halves at ONE scale, sized for the larger (the lo product reaches about
         * 1/128 of a full-range output, hi about 1/256; the rest is headroom for the pad's spread). This MUST equal
         * make_graphs.py's DIGIT_OUT_DIV - it is deliberately not derived from the lane margin, so that retuning the
         * margin cannot silently desynchronise graph and payload. */
        const float s_d = pr.s_out / 102.4f;                               /* DIGIT_OUT_DIV */
        for (uint32_t r = 0; r < rows; r++) {
            float *y = g.cache[p].data() + (size_t)r * pr.n_out; const int16_t *P = pads[r].P[p].data();
            if (s_digit_split) {
                /* hi rows come first, so this projection's lo row sits rows*n_out further on. The pad was
                 * projected in units of s_out, so subtract it as a float rather than mixing the domains. */
                const int16_t *vh = rx, *vl = rx + (size_t)rows * pr.n_out;
                for (uint32_t j = 0; j < pr.n_out; j++) {
                    const int16_t a = vh[j], b2 = vl[j];
                    /* KERNEL VERIFICATION, independent of any CPU/GGUF path. One element per projection per
                     * exchange is recomputed with the reference's own expression under the SAME bundle, weights
                     * and quantisation, and compared to what the TPU returned. This is what validates the
                     * backend's requantisation and both rails with explicit tolerances; an unmasked CPU engine
                     * is a different quantisation and cannot settle it. Cost is 2 dots per projection per
                     * exchange, about 420 per token, against the 2.3 GMAC the token already costs. */
                    if (kVerifyKernel && j == (uint32_t)(s.st.exchanges % pr.n_out)) {
                        const int16_t *qv = s.txbuf.data() + (size_t)r * g.n_in;
                        const int64_t va = llround((double)dot_i8_digit(pr.Wq + (size_t)j * g.n_in, qv, g.n_in, true) * pr.M[j] * 102.4);
                        const int64_t vb = llround((double)dot_i8_digit(pr.Wq + (size_t)j * g.n_in, qv, g.n_in, false) * pr.M[j] * 102.4);
                        const int64_t ca = va > 32767 ? 32767 : (va < -32768 ? -32768 : va);   /* what a clamping backend should return */
                        const int64_t cb = vb > 32767 ? 32767 : (vb < -32768 ? -32768 : vb);
                        const uint64_t da = (uint64_t)llabs((int64_t)a - ca), db = (uint64_t)llabs((int64_t)b2 - cb);
                        s.st.ver_n += 2; s.st.ver_sq += (double)(da * da) + (double)(db * db);
                        if (da > s.st.ver_max) s.st.ver_max = da;
                        if (db > s.st.ver_max) s.st.ver_max = db;
                        if (da) s.st.ver_bad++; if (db) s.st.ver_bad++;
                    }
                    if (a >= 32767 || a <= -32767 || b2 >= 32767 || b2 <= -32767) {
                        /* A RETURNED RAIL IS NOT EVIDENCE OF ANYTHING. The worker is untrusted, so the rail is
                         * only a trigger to recompute; the recomputed value is the trusted one and is used
                         * UNCONDITIONALLY. The previous shape -- recompute, but only substitute when the trusted
                         * value was itself out of range -- let a worker return 32767 for an ordinary in-range
                         * product, pay for the recompute, increment no clip counter (so it evaded the flood
                         * bound), and then FALL THROUGH and consume the false rail. That was worker-injectable
                         * corruption, and it was mine. Using the exact value in every case closes it: a genuine
                         * clip is repaired, a legitimate rail is unchanged (exact == returned), and a false rail
                         * is rejected. */
                        s.st.saturated++;
                        if (!rail_budget_take(s.st, g)) abort();          /* budget is taken BEFORE the dots below */
                        rail_recomp++;
                        if (a == -32768 || b2 == -32768) s.st.rail_m32768++;
                        if (a == -32767 || b2 == -32767) s.st.rail_m32767++;
                        if (a == 32767 || b2 == 32767) s.st.rail_p32767++;
                        /* Associate EXACTLY as ggml_backend_tpu_reference_worker does -- (acc * M) * mscale, not
                         * acc * (M * mscale). Floating multiply is not associative and this is meant to be the
                         * same expression, not merely the same value. */
                        const int16_t *qr = s.txbuf.data() + (size_t)r * g.n_in;
                        const int64_t ea = llround((double)dot_i8_digit(pr.Wq + (size_t)j * g.n_in, qr, g.n_in, true) * pr.M[j] * 102.4);
                        const int64_t eb = llround((double)dot_i8_digit(pr.Wq + (size_t)j * g.n_in, qr, g.n_in, false) * pr.M[j] * 102.4);
                        const int64_t xa = ea > 32767 ? ea - 32767 : (ea < -32768 ? -32768 - ea : 0);
                        const int64_t xb = eb > 32767 ? eb - 32767 : (eb < -32768 ? -32768 - eb : 0);
                        if (xa || xb) {                                   /* genuine clip: the hardware saturated */
                            s.st.sat_clipped++; if (xa) s.st.sat_hi++; if (xb) s.st.sat_lo++;
                            const int64_t ex = xa > xb ? xa : xb; if ((uint64_t)ex > s.st.sat_max_excess) s.st.sat_max_excess = (uint64_t)ex;
                            const double err = fabs(s_d * (double)(256 * (ea - (int64_t)a) + (eb - (int64_t)b2))) / (double)pr.s_out;
                            if (err > s.st.sat_max_err_lsb) s.st.sat_max_err_lsb = err;
                        } else if (ea != (int64_t)a || eb != (int64_t)b2) {
                            s.st.false_rails++;                           /* in-range product returned as a rail: the worker is lying */
                        }
                        s.st.sat_repaired = kRepairClips ? 1 : 0;
                        if (kRepairClips) { y[j] += (float)((double)s_d * (256.0 * (double)ea + (double)eb) - (double)pr.s_out * (double)P[j]); continue; }
                    }
                    /* CANCELLATION. y = s_d*(256a+b) - s_out*P subtracts two LARGE pad-dependent quantities
                     * whose difference is small: the reply carries the pad, P IS the pad, and only the signal
                     * survives. In float32 each operand rounds at 2^-24 of ITS OWN magnitude, not of the
                     * difference, so the residual error is a function of the pad -- exactly the dependence being
                     * hunted. The plain path never had this (it subtracts v-P in int32 first); the digit path
                     * cannot, because DIGIT_OUT_DIV is 102.4 rather than a power of two. Doing the cancellation
                     * in double costs nothing and shrinks the error by about 2^29. The diagnostic records how
                     * far the float form WOULD have been, in output LSBs, so this is measured not assumed. */
                    const double yd = (double)s_d * (double)(256 * (int32_t)a + (int32_t)b2) - (double)pr.s_out * (double)P[j];
                    { const double yf = (double)(s_d * (float)(256 * (int32_t)a + (int32_t)b2) - pr.s_out * (float)P[j]);
                      const double dd = fabs(yf - yd) / (double)pr.s_out;
                      if (dd > s.st.cancel_max_lsb) s.st.cancel_max_lsb = dd;
                      s.st.cancel_sq += dd * dd; s.st.cancel_n++; }
                    y[j] += (float)yd;
                }
            } else
            for (uint32_t j = 0; j < pr.n_out; j++) { const int16_t v = rx[j];
                if (v >= 32767 || v <= -32767) { s.st.saturated++;
                    /* Same contract as the digit path: the rail is only a TRIGGER, the recomputed value is the
                     * trusted one and is used unconditionally, and the budget is taken before the dot. This
                     * branch previously substituted only when the trusted value was itself out of range, so a
                     * worker could return a rail for an in-range product, force the dot, increment nothing, and
                     * have the false rail consumed. Association matches the reference: (acc * M), not (M * acc). */
                    if (!rail_budget_take(s.st, g)) abort();
                    rail_recomp++;
                    const int16_t *qr = s.txbuf.data() + (size_t)r * g.n_in;
                    const int64_t ev = llround((double)dot_i8_i16(pr.Wq + (size_t)j * g.n_in, qr, g.n_in) * pr.M[j]);
                    const int64_t ex = ev > 32767 ? ev - 32767 : (ev < -32768 ? -32768 - ev : 0);
                    if (ex) { s.st.sat_clipped++; if ((uint64_t)ex > s.st.sat_max_excess) s.st.sat_max_excess = (uint64_t)ex;
                              const double err = fabs((double)(ev - (int64_t)v)); if (err > s.st.sat_max_err_lsb) s.st.sat_max_err_lsb = err; }
                    else if (ev != (int64_t)v) s.st.false_rails++;
                    if (kRepairClips) { y[j] += pr.s_out * (float)((double)ev - (double)P[j]); continue; } }
                y[j] += pr.s_out * (float)((int32_t)v - (int32_t)P[j]); }
            rx += pr.n_out;
        }
        if (s_digit_split) rx += (size_t)rows * pr.n_out;                  /* step over this projection's lo block */
    }
    const int64_t t3 = now_us();
    s.st.exchanges++; s.st.rows += rows; s.st.bytes_out += s.frame.size(); s.st.bytes_in += s.rxbuf.size() * 2;
    s.st.mask_us += (uint64_t)(t1 - t0); s.st.link_us += (uint64_t)(t2 - t1); s.st.unmask_us += (uint64_t)(t3 - t2);
    s.st.corr_us += (uint64_t)(t_corr - t_pub); s.st.wait_us += (uint64_t)(t2 - t_mint);
    s.st.rx_calls = g_rx_calls.load(std::memory_order_relaxed);
}

bool claimable(const ggml_tensor *op) {
    state &s = S();
    if (s.link < 0 || op->op != GGML_OP_MUL_MAT) return false;
    const ggml_tensor *w = op->src[0], *x = op->src[1];
    if (!w || !x || x->type != GGML_TYPE_F32 || op->type != GGML_TYPE_F32 || !ggml_is_contiguous(x)) return false;
    if (x->ne[2] != 1 || x->ne[3] != 1 || x->ne[1] < 1 || x->ne[1] > s.rows_max) return false;       /* wider batches (prefill) stay on the VM's CPU */
    /* only weights the engine placed in its plain host buffer type: a drafter in the same process has tensors of the same NAMES */
    if (!w->buffer || strcmp(ggml_backend_buft_name(ggml_backend_buffer_get_type(w->buffer)), "CPU_plain") != 0) return false;
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
    const uint8_t *b = (const uint8_t *)m, *e = b + sb.st_size;
    /* ETPUB002 is a digit-split bundle: its graphs take 2*rows int8 digit rows instead of rows of int16, so a payload
     * that sent int16 would be feeding the TPU nonsense that still decodes to plausible text. Refuse loudly. */
    const bool bundle_ds = !memcmp(b, "ETPUB002", 8);
    if (!bundle_ds && memcmp(b, "ETPUB001", 8)) { TPU_LOG("bundle magic\n"); munmap(m, (size_t)sb.st_size); return -1; }
    s_digit_split = bundle_ds;
    uint32_t n; memcpy(&n, b + 8, 4); size_t off = 16;
    auto al8 = [](size_t o) { return (o + 7) & ~(size_t)7; };
    for (uint32_t gi = 0; gi < n; gi++) {
        if (b + off + 16 > e) goto bad;
        { group *g = new group; uint16_t layer; uint8_t kind, np; memcpy(&layer, b + off, 2); kind = b[off + 2]; np = b[off + 3]; memcpy(&g->n_in, b + off + 4, 4); memcpy(&g->s_in, b + off + 8, 4); memcpy(&g->k, b + off + 12, 4);
          g->layer = layer; g->kind = kind; off += 16;
          if (np < 1 || np > 3 || g->n_in < 1 || g->n_in > (1u << 20) || b + off + (size_t)g->n_in * 8 > e) goto bad;
          g->s = (const float *)(b + off); off += (size_t)g->n_in * 4; g->sig_q = (const int16_t *)(b + off); off += (size_t)g->n_in * 2; g->r_amp = (const int16_t *)(b + off); off += (size_t)g->n_in * 2; off = al8(off);
          g->modular = g->k < 0.0f;                                        /* k = -1 marks a modular bundle: r_amp holds log2(m_i) */
          if (g->modular) {
              g->mod.resize(g->n_in);
              for (uint32_t i = 0; i < g->n_in; i++) {
                  const int e = g->r_amp[i];
                  if (e < 1 || e > 15) { TPU_LOG("bundle: blk.%d kind %d channel %u has log2(modulus) %d, outside 1..15\n", g->layer, g->kind, i, e); goto bad; }
                  g->mod[i] = 1 << e;
                  if (g->mod[i] < 2 * (int32_t)g->sig_q[i] + 1) { TPU_LOG("bundle: blk.%d kind %d channel %u modulus %d is below its own lane %d\n", g->layer, g->kind, i, g->mod[i], (int)g->sig_q[i]); goto bad; }
              }
          }
          for (uint8_t p = 0; p < np; p++) {
              if (b + off + 76 > e) goto bad;
              proj pr; pr.name = (const char *)(b + off); memcpy(&pr.n_out, b + off + 64, 4); memcpy(&pr.s_out, b + off + 68, 4); memcpy(&pr.budget, b + off + 72, 4); off += 76;
              if (pr.n_out < 1 || pr.n_out > (1u << 20) || b + off + (size_t)pr.n_out * 4 + (size_t)pr.n_out * g->n_in > e || memchr(pr.name, 0, 64) == NULL) goto bad;
              pr.sw = (const float *)(b + off); off += (size_t)pr.n_out * 4; pr.Wq = (const int8_t *)(b + off); off += (size_t)pr.n_out * g->n_in; off = al8(off);
              pr.M.resize(pr.n_out); for (uint32_t j = 0; j < pr.n_out; j++) pr.M[j] = (double)g->s_in * (double)pr.sw[j] / (double)pr.s_out;
              s.by_name[pr.name] = { g, (int)p }; g->projs.push_back(std::move(pr));
          }
          g->fast = mint_fast(*g); s.groups.push_back(g); }
    }
    s.map = m; s.map_len = (size_t)sb.st_size;
    { const bool mo = !s.groups.empty() && s.groups[0]->modular;
      TPU_LOG("bundle %s: %u exchange groups, %zu projections, %s\n", path, n, s.by_name.size(),
              mo ? "MODULAR pads (uniform on a per-channel power-of-two modulus)" : "statistical pads"); }
    return 0;
bad:
    TPU_LOG("bundle %s is malformed at byte %zu\n", path, off); munmap(m, (size_t)sb.st_size); s.groups.clear(); s.by_name.clear(); return -1;
}
/* Page the whole bundle in (it lives in the VM's encrypted store: about 100 MB/s, cold) and try to pin it, so minting and the
 * unmask's column walks never wait for the disk. Returns seconds; *locked = 1 when mlock held. */
extern "C" double ggml_backend_tpu_warm_bundle(int threads, int *locked) {
    state &s = S(); if (locked) *locked = 0; if (!s.map) return 0; const int64_t t0 = now_us(); if (threads < 1) threads = 1;
    madvise(s.map, s.map_len, MADV_WILLNEED); std::vector<std::thread> th; std::atomic<uint64_t> sink{0}; const size_t slice = (s.map_len + threads - 1) / threads;
    for (int t = 0; t < threads; t++) th.emplace_back([&, t] { const uint8_t *b = (const uint8_t *)s.map; uint64_t a = 0; const size_t e = std::min(s.map_len, slice * (t + 1)); for (size_t o = slice * t; o < e; o += 4096) a += b[o]; sink += a; });
    for (auto &x : th) x.join();
    if (mlock(s.map, s.map_len) == 0) { if (locked) *locked = 1; } else TPU_LOG("bundle mlock: %s (the pages stay evictable)\n", strerror(errno));
    return (now_us() - t0) / 1e6;
}
/* vsock is credit-flow-controlled by a per-socket buffer, and the measured link looks exactly like a small
 * window rather than a slow copy: 0.74 ms round-trip latency and 22 MB/s, and 16 KB / 0.74 ms = 21.6 MB/s.
 * If that is what it is, the buffer is a tunable and not a floor, and the byte term - 66% of the transport
 * at one row, and the thing that makes speculative rows break even instead of win - collapses.
 * SO_VM_SOCKETS_BUFFER_SIZE (level AF_VSOCK) is best-effort: the fd is already connected, the guest may
 * clamp to its MAX, and the peer has its own window. Logged either way, because a silent no-op here would
 * look exactly like "the link is simply slow". ANCHOR_TPU_VSOCK_BUF=0 leaves it alone. */
static uint64_t g_link_buf_before = 0, g_link_buf_after = 0;
static void link_widen(int fd) {
    const char *e = getenv("ANCHOR_TPU_VSOCK_BUF");
    const unsigned long want = e ? strtoul(e, nullptr, 0) : 1u << 20;
    if (!want) return;
#ifndef SO_VM_SOCKETS_BUFFER_SIZE
#define SO_VM_SOCKETS_BUFFER_SIZE 0
#define SO_VM_SOCKETS_BUFFER_MAX_SIZE 2
#endif
    uint64_t before = 0, after = 0, maxb = 0; socklen_t n = sizeof before;
    getsockopt(fd, AF_VSOCK, SO_VM_SOCKETS_BUFFER_SIZE, &before, &n);
    n = sizeof maxb; getsockopt(fd, AF_VSOCK, SO_VM_SOCKETS_BUFFER_MAX_SIZE, &maxb, &n);
    uint64_t mx = want; if (setsockopt(fd, AF_VSOCK, SO_VM_SOCKETS_BUFFER_MAX_SIZE, &mx, sizeof mx) != 0) { /* may be refused; the SIZE set below is what matters */ }
    uint64_t sz = want; const int rc = setsockopt(fd, AF_VSOCK, SO_VM_SOCKETS_BUFFER_SIZE, &sz, sizeof sz);
    n = sizeof after; getsockopt(fd, AF_VSOCK, SO_VM_SOCKETS_BUFFER_SIZE, &after, &n);
    g_link_buf_before = before; g_link_buf_after = after;
    TPU_LOG("link buffer: was %llu, max %llu, asked %llu -> now %llu (%s)\n",
            (unsigned long long)before, (unsigned long long)maxb, (unsigned long long)want,
            (unsigned long long)after, rc == 0 ? "accepted" : strerror(errno));
}
extern "C" void ggml_backend_tpu_link_buf(uint64_t *before, uint64_t *after) { if (before) *before = g_link_buf_before; if (after) *after = g_link_buf_after; }
extern "C" void ggml_backend_tpu_set_link(int fd, int rows_max) { S().link = fd; if (rows_max >= 1 && rows_max <= 64) S().rows_max = rows_max; link_widen(fd); }
extern "C" int ggml_backend_tpu_claims(const char *tensor_name) { return S().by_name.count(tensor_name) ? 1 : 0; }
/* Work for the minters: (group, at most one batch of pads), largest first, so threads finish together. */
static void mint_items(int threads, const std::vector<std::pair<group *, size_t>> &items, bool scalar, bool keep) {
    std::atomic<size_t> next{0}; std::vector<std::thread> th; if (threads < 1) threads = 1;
    for (int t = 0; t < threads; t++) th.emplace_back([&] {
        for (;;) { const size_t i = next.fetch_add(1); if (i >= items.size()) return; group &g = *items[i].first;
            std::vector<pad> fresh; mint_batch(g, items[i].second, fresh, scalar); if (!keep) continue;
            std::lock_guard<std::mutex> lk(g.bank_mu); for (pad &p : fresh) g.bank.push_back(std::move(p)); } });
    for (auto &x : th) x.join();
}
static std::vector<std::pair<group *, size_t>> mint_plan(const std::vector<std::pair<group *, size_t>> &need) {
    std::vector<std::pair<group *, size_t>> items;
    for (const auto &nd : need) for (size_t left = nd.second; left > 0; ) { const size_t take = left < mint_width(*nd.first) ? left : mint_width(*nd.first); items.push_back({ nd.first, take }); left -= take; }
    auto cost = [](const std::pair<group *, size_t> &it) { size_t rows = 0; for (const proj &p : it.first->projs) rows += p.n_out; return rows * it.first->n_in * it.second; };
    std::stable_sort(items.begin(), items.end(), [&](const auto &x, const auto &y) { return cost(x) > cost(y); });
    return items;
}
/* Fill every group's bank to `positions` pads on `threads` threads. Idle-time work: a batch of pads costs about one prefill pass over the projections. */
extern "C" double ggml_backend_tpu_mint(int positions, int threads) {
    state &s = S(); const int64_t t0 = now_us(); std::vector<std::pair<group *, size_t>> need;
    for (group *g : s.groups) { std::lock_guard<std::mutex> lk(g->bank_mu); if ((int)g->bank.size() < positions) need.push_back({ g, (size_t)positions - g->bank.size() }); }
    mint_items(threads, mint_plan(need), false, true);
    const double sec = (now_us() - t0) / 1e6; s.st.mint_bank_us += (uint64_t)(sec * 1e6); return sec;
}
/* Background refill: during Shielded-TPU decode the VM's cores mostly wait on the link, which is when pads are cheapest to make.
 * `threads` minters keep every group's bank at `target` pads, emptiest group first, one batch at a time; they yield between batches. */
static std::vector<std::thread> g_refill; static std::atomic<bool> g_refill_on{false};
extern "C" void ggml_backend_tpu_refill_start(int target, int threads) {
    state &s = S(); if (g_refill_on.exchange(true)) return; if (threads < 1) threads = 1;
    for (int t = 0; t < threads; t++) g_refill.emplace_back([&s, target] {
        while (g_refill_on.load(std::memory_order_relaxed)) {
            group *low = nullptr; size_t low_n = (size_t)target;
            for (group *g : s.groups) { std::lock_guard<std::mutex> lk(g->bank_mu); const size_t n = g->bank.size() + g->minting; if (n < low_n) { low_n = n; low = g; } }
            if (!low) { std::this_thread::sleep_for(std::chrono::milliseconds(5)); continue; }
            const size_t ask = std::min<size_t>((size_t)target - low_n, mint_width(*low));
            { std::lock_guard<std::mutex> lk(low->bank_mu); low->minting += ask; }
            std::vector<pad> fresh; mint_batch(*low, ask, fresh);
            { std::lock_guard<std::mutex> lk(low->bank_mu); low->minting -= ask; for (pad &p : fresh) low->bank.push_back(std::move(p)); }
            s.st.pads_refilled += fresh.size(); std::this_thread::yield();
        } });
}
extern "C" void ggml_backend_tpu_refill_stop(void) { if (!g_refill_on.exchange(false)) return; for (auto &t : g_refill) t.join(); g_refill.clear(); }
extern "C" void ggml_backend_tpu_get_stats(ggml_backend_tpu_stats_t *out, int reset) { *out = S().st; size_t left = (size_t)-1; for (group *g : S().groups) { std::lock_guard<std::mutex> lk(g->bank_mu); if (g->bank.size() < left) left = g->bank.size(); } out->bank_min = S().groups.empty() ? 0 : left; if (reset) S().st = ggml_backend_tpu_stats_t{}; }
/* The batched minter against the scalar reference: for every group, `batch` pads from the batched path, each P recomputed from
 * the pad's own r with dot_i8_i16. Returns the number of differing values (0 = exact), or -1 without a bundle. */
extern "C" long ggml_backend_tpu_mint_check(int batch) {
    state &s = S(); if (s.groups.empty()) return -1; long bad = 0;
    for (group *g : s.groups) { std::vector<pad> pads; mint_batch(*g, (size_t)(batch < 1 ? 1 : batch), pads);
        for (const pad &pd : pads) for (size_t p = 0; p < g->projs.size(); p++) { const proj &pr = g->projs[p];
            for (uint32_t j = 0; j < pr.n_out; j++) if ((int64_t)pd.P[p][j] != (int64_t)llround((double)dot_i8_i16(pr.Wq + (size_t)j * g->n_in, pd.r.data(), g->n_in) * pr.M[j])) bad++; } }
    return bad;
}
/* Minting alone, for measurement: `positions` pads per group on `threads` threads with the batched (scalar = 0) or the
 * one-at-a-time reference path (scalar = 1); the pads are dropped. Returns seconds. */
extern "C" double ggml_backend_tpu_mint_bench(int positions, int threads, int scalar) {
    state &s = S(); const int64_t t0 = now_us(); std::vector<std::pair<group *, size_t>> need; for (group *g : s.groups) need.push_back({ g, (size_t)(positions < 1 ? 1 : positions) });
    mint_items(threads, mint_plan(need), scalar != 0, false);
    return (now_us() - t0) / 1e6;
}
/* The arithmetic the TPU is REQUIRED to perform, as a loop over a connection: used by the host test as the worker, and the
 * definition the on-phone layer check compares the real TPU against (measured: at most one int16 step apart). */
extern "C" int ggml_backend_tpu_reference_worker(int fd) {
    state &s = S(); std::vector<int16_t> q, y; std::vector<int8_t> d; uint8_t hdr[4];
    while (rd_all(fd, hdr, 4)) {
        const bool ds = hdr[0] == 0xE8;                                    /* digit-split frame: 2*rows int8, hi rows then lo */
        if (hdr[0] != 0xE7 && !ds) return -1;
        group *g = nullptr; for (group *c : s.groups) if (c->layer == hdr[1] && c->kind == hdr[2]) { g = c; break; }
        if (!g || hdr[3] < 1) return -1;
        const uint32_t rows = hdr[3], wire = ds ? 2u * rows : rows;
        if (ds) { d.resize((size_t)wire * g->n_in); if (!rd_all(fd, d.data(), d.size())) return -1; }
        else    { q.resize((size_t)rows * g->n_in); if (!rd_all(fd, q.data(), q.size() * 2)) return -1; }
        for (const proj &p : g->projs) {
            /* The digit graphs carry both halves at one scale, DIGIT_OUT_DIV coarser than s_out, so the reference
             * has to requantise the same way or the VM's recombination lands in the wrong units. */
            const double mscale = ds ? 102.4 : 1.0;
            y.resize((size_t)wire * p.n_out);
            for (uint32_t r = 0; r < wire; r++) for (uint32_t j = 0; j < p.n_out; j++) {
                const long long acc = ds ? dot_i8_i8(p.Wq + (size_t)j * g->n_in, d.data() + (size_t)r * g->n_in, g->n_in)
                                         : dot_i8_i16(p.Wq + (size_t)j * g->n_in, q.data() + (size_t)r * g->n_in, g->n_in);
                long long v = llround((double)acc * p.M[j] * mscale);
                /* MEASURED 2026-09-22: the backend clamps negatives at -32768, never -32767 (rail histogram
                 * over every detected rail: -32768 x98, -32767 x0, +32767 x90). The reference clamped one LSB
                 * short of the hardware, so anything validated against it was off by an LSB at the negative rail. */
                y[(size_t)r * p.n_out + j] = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
            }
            if (!wr_all(fd, y.data(), y.size() * 2)) return -1;
        }
    }
    return 0;
}
