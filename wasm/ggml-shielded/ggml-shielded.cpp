#include "ggml-shielded.h"
#include "ggml-backend-impl.h"
#include "ggml-impl.h"

extern "C" {
#include "shielded-field.h"
#include "shielded-tee.h"
}

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>

#define SH_LOG(...) do { if (sh_verbose()) fprintf(stderr, "[shielded] " __VA_ARGS__); } while (0)

static double sh_now_ms() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

static bool sh_verbose() {
    static int v = -1;
    if (v < 0) { const char *e = getenv("SHIELDED_VERBOSE"); v = (e && *e && strcmp(e, "0")) ? 1 : 0; }
    return v != 0;
}
static int sh_env_int(const char *name, int dflt) {
    const char *e = getenv(name);
    return (e && *e) ? atoi(e) : dflt;
}

/* The calibrated activation exponent, corrected for the per-column weight
 * encoding. NOT per-request: a constant for the process, exactly as the
 * calibrated exponent is -- adapting it to the activation in hand would buy
 * field headroom by leaking activation magnitude, and is refused.
 *
 * Why it defaults to -5 rather than 0. calibrate.py chose each site's exponent
 * against the PER-TENSOR weight encoding, where most columns held tiny w_fixed
 * and therefore tiny products. This backend encodes per COLUMN (per-tensor
 * quantises 13.5% of a real model's weights to zero and loses the answer), so
 * every column now uses the full byte lane, the products grow, and the ~23.8-bit
 * field cannot hold both exponents at their old values. Measured on
 * Qwen2.5-0.5B: the activation has to give back 5 bits for the products to fit,
 * and at that point the shielded path reproduces ggml's CPU output.
 *
 * Leaving it at 0 does not silently corrupt anything -- the Freivalds check runs
 * over the integers and catches the wrap -- but it fails EVERY request, which is
 * how this shipped: verified locally with the flag set, deployed without it, and
 * the tenant died in llama_decode with the wrap detector doing its job.
 *
 * This is a measured constant standing in for a calibrated one. The proper fix
 * is to re-run calibrate.py against the per-column encoding so each site gets
 * its own exponent again; when that lands this default becomes 0. */
static int sh_af_delta() {
    static int d = INT32_MIN;
    if (d == INT32_MIN) d = sh_env_int("SHIELDED_AF_DELTA", -5);
    return d;
}

/* --------------------------------------------------------------------------
 * Placement policy.
 *
 * Offload is a round trip, and a round trip has a floor cost that no amount of
 * GPU speed lowers. Two consequences, both tunable, neither per-request:
 *
 *  SHIELDED_MIN_MACS  A matmul below this many multiply-adds is cheaper to do
 *                     on the CPU inside the enclave than to ship. Qwen2.5-0.5B's
 *                     q/k/v/o projections (0.1-0.8 MMAC) sit under the default;
 *                     its FFN and lm_head (4.4-136 MMAC) sit above it.
 *  SHIELDED_MAX_M     Batches wider than this stay in the enclave. Refill costs
 *                     the TEE three residue planes of work per offloaded MAC,
 *                     so a prefill-sized batch is strictly cheaper computed in
 *                     the clear, in the enclave, once. Offload is a DECODE
 *                     accelerator: it removes the weight-bandwidth term from the
 *                     latency chain, and that is the only term it can remove.
 * ----------------------------------------------------------------------- */
static int64_t sh_min_macs() { static int64_t v = -1; if (v < 0) v = sh_env_int("SHIELDED_MIN_MACS", 2000000); return v; }
static int     sh_max_m()    { static int v = -1;     if (v < 0) v = sh_env_int("SHIELDED_MAX_M", 8); return v; }

/* q8_0, as ggml stores it: one fp16 scale then 32 quants, per block, per row. */
struct sh_block_q8_0 { uint16_t d; int8_t qs[32]; };
static_assert(sizeof(sh_block_q8_0) == 34, "unexpected q8_0 block layout");

/* --------------------------------------------------------------------------
 * Calibration.
 *
 * Two public, offline constants per site: the activation exponent and the
 * outlier channel set. Both are properties of the PUBLIC weights, calibrated on
 * public text and shipped like an imatrix, so neither leaks anything about a
 * request -- and both must be per-model constants rather than adapted to the
 * activation in hand, since an adaptive exponent would leak activation
 * magnitude. A site with no calibration is not offloaded at all: supports_op
 * says no and ggml_backend_sched quietly runs it on the CPU, in the enclave.
 * ----------------------------------------------------------------------- */
struct sh_calib_site {
    int act_frac = 0;
    std::vector<int64_t> outliers;
};

/* q/k/v come from one attn_norm and gate/up from one ffn_norm, so they share an
 * activation -- and therefore share one exponent, one outlier set and, at run
 * time, ONE PAD and ONE EXCHANGE. That is not a bandwidth optimisation: masking
 * the same x three times under three pads would hand the adversary three
 * encryptions of one value for no benefit. */
static std::string sh_group_key(const std::string &name) {
    static const std::pair<const char *, const char *> members[] = {
        { "attn_k",   "attn_q" }, { "attn_v",  "attn_q" },
        { "ffn_up",   "ffn_gate" },
    };
    for (const auto &m : members) {
        const size_t p = name.find(m.first);
        if (p != std::string::npos) {
            std::string out = name;
            out.replace(p, strlen(m.first), m.second);
            return out;
        }
    }
    return name;
}

struct sh_state {
    std::mutex mu;
    std::string host = "127.0.0.1";
    int port = 9500;
    std::string calib_path;
    bool configured = false;
    bool calib_loaded = false;
    bool link_failed = false;
    std::map<std::string, sh_calib_site> calib;

    sh_link *link = nullptr;
    /* Weight tensor name -> everything needed to run and to check it. Map nodes
     * never move, so the link may borrow `w` for its lifetime. */
    struct entry {
        int node = -1;
        std::vector<int> f_w;           /* one exponent per output column */
        int64_t K = 0, N = 0;
        const sh_calib_site *site = nullptr;
        std::string group;
        std::vector<int8_t> w;          /* (N,K): THE encoding, borrowed by the link */
        std::vector<int8_t> out_cols;   /* nout x N: the outlier channels' weights, for the TEE-side term */
        std::vector<float> inv;         /* per-column descale 2^-(af + f_w[j]) */
    };
    std::map<std::string, entry> weights;
    std::map<std::string, int> group_first;   /* group key -> first node in it */
    std::set<std::string> refused;            /* names that failed registration, said once */
    bool dirty = false;                       /* new weights since the last start() */

    uint64_t offloaded_nodes = 0, local_nodes = 0, macs = 0, verify_fail = 0, exchanges = 0;
    double t_encode = 0, t_link = 0, t_post = 0, t_graph = 0;
};

static sh_state &sh_get() { static sh_state s; return s; }

void ggml_backend_shielded_configure(const char *host, int port, const char *calib_path) {
    sh_state &s = sh_get();
    std::lock_guard<std::mutex> lk(s.mu);
    if (host && *host) s.host = host;
    if (port > 0) s.port = port;
    if (calib_path && *calib_path) { s.calib_path = calib_path; s.calib_loaded = false; }
    s.configured = true;
}

extern "C" double sh_prof[8];
void ggml_backend_shielded_stats(uint64_t *off, uint64_t *loc, uint64_t *macs, uint64_t *vf) {
    sh_state &s = sh_get();
    std::lock_guard<std::mutex> lk(s.mu);
    if (getenv("SHIELDED_PROFILE")) {
        uint64_t used = 0, missed = 0;
        if (s.link) sh_link_pool_stats(s.link, &used, &missed);
        fprintf(stderr, "[shielded] profile: exchanges=%llu nodes=%llu | link: mask=%.1fms wire=%.1fms "
                        "refill-on-path=%.1fms unmask=%.1fms verify=%.1fms | backend: encode=%.1fms "
                        "post=%.1fms graph_compute=%.1fms | pads used=%llu missed=%llu | simd=%s\n",
                (unsigned long long)s.exchanges, (unsigned long long)s.offloaded_nodes,
                sh_prof[0], sh_prof[1], sh_prof[2], sh_prof[3], sh_prof[4],
                s.t_encode, s.t_post, s.t_graph, (unsigned long long)used, (unsigned long long)missed,
                sh_link_simd()->name);
    }
    if (off)  *off  = s.offloaded_nodes;
    if (loc)  *loc  = s.local_nodes;
    if (macs) *macs = s.macs;
    if (vf)   *vf   = s.verify_fail;
}

/* Read the environment once, so enabling the tier is launch configuration rather
 * than an app-visible API -- existing catalog guests keep their wasi-nn contract
 * unchanged, which is the point of putting the split here at all. An explicit
 * ggml_backend_shielded_configure() still wins. */
static void sh_env_defaults(sh_state &s) {
    if (s.configured) return;
    s.configured = true;
    if (const char *h = getenv("SHIELDED_HOST")) if (*h) s.host = h;
    if (const char *p = getenv("SHIELDED_PORT")) if (*p) { const int v = atoi(p); if (v > 0) s.port = v; }
}

static void sh_load_calib(sh_state &s) {
    if (s.calib_loaded) return;
    s.calib_loaded = true;
    if (s.calib_path.empty()) {
        const char *e = getenv("SHIELDED_CALIB");
        if (e && *e) s.calib_path = e;
    }
    if (s.calib_path.empty()) {
        SH_LOG("no calibration configured; nothing will be offloaded\n");
        return;
    }
    FILE *f = fopen(s.calib_path.c_str(), "r");
    if (!f) { SH_LOG("calibration %s unreadable; nothing will be offloaded\n", s.calib_path.c_str()); return; }
    char line[8192];
    while (fgets(line, sizeof line, f)) {
        if (line[0] == '#' || line[0] == '\n') continue;
        char name[512]; int af = 0, nout = 0; int pos = 0;
        if (sscanf(line, "site %511s %d %d%n", name, &af, &nout, &pos) < 3) continue;
        sh_calib_site site;
        site.act_frac = af;
        const char *p = line + pos;
        for (int i = 0; i < nout; i++) {
            long long v = 0; int adv = 0;
            if (sscanf(p, " %lld%n", &v, &adv) != 1) break;
            site.outliers.push_back((int64_t)v);
            p += adv;
        }
        s.calib[name] = std::move(site);
    }
    fclose(f);
    SH_LOG("calibration: %zu sites from %s (policy: min %lld MAC, max m %d, simd %s)\n",
           s.calib.size(), s.calib_path.c_str(), (long long)sh_min_macs(), sh_max_m(), sh_link_simd()->name);
}

static const sh_calib_site *sh_site_for(sh_state &s, const char *name) {
    sh_env_defaults(s);
    sh_load_calib(s);
    auto it = s.calib.find(sh_group_key(name));
    return it == s.calib.end() ? nullptr : &it->second;
}

/* --------------------------------------------------------------------------
 * Weight registration: straight from ggml's q8_0 rows into THE encoding, one
 * row per output, which is also what the worker wants. No transpose anywhere.
 * ----------------------------------------------------------------------- */
static bool sh_register(sh_state &s, const ggml_tensor *w) {
    const std::string name = ggml_get_name(w);
    if (s.weights.count(name)) return true;
    if (s.refused.count(name)) return false;

    const int64_t K = w->ne[0], N = w->ne[1];
    const sh_calib_site *site = sh_site_for(s, name.c_str());
    if (!site) return false;
    if (K % SH_QK != 0) return false;

    const double t0 = sh_now_ms();
    sh_state::entry e;
    e.K = K; e.N = N; e.site = site; e.group = sh_group_key(name);
    e.w.resize((size_t)K * N);
    e.f_w.resize((size_t)N);
    if (sh_prepare_weight_rows(w->data, K, N, e.w.data(), e.f_w.data()) < 0) {
        SH_LOG("%s: no weight exponent fits the int8 lane; staying on CPU\n", name.c_str());
        s.refused.insert(name);
        return false;
    }

    /* The outlier columns, kept in the TEE. Their contribution is computed here
     * in plain int64 where nothing can wrap, and the offloaded activation has
     * those channels zeroed -- so the channels that would have broken Z_M are
     * exactly the ones the field never has to hold. */
    const size_t nout = site->outliers.size();
    e.out_cols.resize(nout * (size_t)N);
    for (size_t c = 0; c < nout; c++) {
        const int64_t k = site->outliers[c];
        if (k < 0 || k >= K) { SH_LOG("%s: outlier channel %lld out of range\n", name.c_str(), (long long)k); s.refused.insert(name); return false; }
        for (int64_t j = 0; j < N; j++) e.out_cols[c * (size_t)N + j] = e.w[(size_t)j * K + k];
    }
    const int af = site->act_frac + sh_af_delta();
    e.inv.resize((size_t)N);
    for (int64_t j = 0; j < N; j++) e.inv[j] = ldexpf(1.0f, -(af + e.f_w[j]));

    if (!s.link) {
        int err = SH_OK;
        s.link = sh_link_open(s.host.c_str(), s.port, true, &err);
        if (!s.link) { s.link_failed = true; return false; }
    }
    int lo = e.f_w[0], hi = e.f_w[0];
    for (int64_t j = 1; j < N; j++) { if (e.f_w[j] < lo) lo = e.f_w[j]; if (e.f_w[j] > hi) hi = e.f_w[j]; }

    sh_state::entry &stored = s.weights[name];
    stored = std::move(e);
    auto gf = s.group_first.find(stored.group);
    const int share = gf == s.group_first.end() ? -1 : gf->second;
    const int node = sh_link_add_weight(s.link, name.c_str(), stored.w.data(), K, N, sh_max_m(), share);
    if (node < 0) {
        SH_LOG("%s: %s\n", name.c_str(), sh_link_last_error(s.link));
        s.weights.erase(name); s.refused.insert(name);
        return false;
    }
    stored.node = node;
    if (share < 0) s.group_first[stored.group] = node;
    s.dirty = true;
    SH_LOG("registered %s K=%lld N=%lld f_w=%d..%d act_frac=%d outliers=%zu group=%s (%.0f ms)\n",
           name.c_str(), (long long)K, (long long)N, lo, hi, site->act_frac, nout, stored.group.c_str(), sh_now_ms() - t0);
    return true;
}

/* --------------------------------------------------------------------------
 * The backend
 * ----------------------------------------------------------------------- */
static const char *ggml_backend_shielded_get_name(ggml_backend_t) { return "Shielded"; }
static void ggml_backend_shielded_free(ggml_backend_t backend) { delete backend; }

/* Claimable at all: a calibrated q8_0 weight times an f32 activation, above the
 * size floor. Registers the weight on first sight of its data, so that every
 * weight is known before the first exchange and the worker is set up once.
 * `batch_ok` additionally applies the batch-width policy. */
static bool sh_claimable(const ggml_tensor *op, bool batch_ok) {
    if (op->op != GGML_OP_MUL_MAT) return false;
    const ggml_tensor *src0 = op->src[0];
    const ggml_tensor *src1 = op->src[1];
    if (!src0 || !src1) return false;
    if (src0->type != GGML_TYPE_Q8_0) return false;      /* the tier's weight format */
    if (src1->type != GGML_TYPE_F32) return false;
    if (op->type != GGML_TYPE_F32) return false;
    if (!ggml_is_contiguous(src0) || !ggml_is_contiguous(src1)) return false;
    if (src0->ne[2] != 1 || src0->ne[3] != 1) return false;
    if (src1->ne[2] != 1 || src1->ne[3] != 1) return false;
    if (src0->ne[0] % SH_QK != 0 || src0->ne[0] % 16 != 0) return false;
    /* A weight tensor has a name and calibration; an activation-activation
     * product (attention) has neither, and must never come here -- TwinShield's
     * OutAttnMult is broken at the group sizes real GQA uses. */
    const char *nm = ggml_get_name(src0);
    if (!nm || !*nm) return false;
    if (src0->ne[0] * src0->ne[1] < sh_min_macs()) return false;
    sh_state &s = sh_get();
    std::lock_guard<std::mutex> lk(s.mu);
    if (!sh_site_for(s, nm)) return false;
    /* ggml also asks about ops built on tensors whose data is not loaded yet
     * (buffer-type selection at model load); those cannot be registered and
     * must not be refused either. */
    if (src0->data && !s.link_failed && !sh_register(s, src0)) return false;
    if (batch_ok && src1->ne[1] > sh_max_m()) return false;
    return true;
}

/* The escape hatch: q8_0 x f32 in the clear, in the enclave.
 *
 * A backend that claims an op and then returns GGML_STATUS_FAILED does not
 * degrade, it kills the graph -- llama_decode turns that into rc -3 and the
 * request dies. That is the right behaviour for a VERIFICATION failure, where
 * continuing would mean sampling a value a hostile worker chose. It is the wrong
 * behaviour for "this weight never registered", which is our own bookkeeping
 * problem and has a correct answer sitting right there in the tensor. */
static void sh_plain_mul_mat(const ggml_tensor *w, const ggml_tensor *a, ggml_tensor *dst) {
    const int64_t K = w->ne[0], N = w->ne[1], m = a->ne[1];
    const int64_t nb = K / SH_QK;
    const sh_block_q8_0 *blocks = (const sh_block_q8_0 *)w->data;
    const float *src = (const float *)a->data;
    float *out = (float *)dst->data;
    for (int64_t r = 0; r < m; r++) {
        const float *xr = src + r * K;
        float *orow = out + r * N;
        for (int64_t i = 0; i < N; i++) {
            double acc = 0.0;
            const sh_block_q8_0 *row = blocks + i * nb;
            for (int64_t b = 0; b < nb; b++) {
                const float d = sh_half_to_float(row[b].d);
                const int8_t *q = row[b].qs;
                const float *xb = xr + b * SH_QK;
                double blk = 0.0;
                for (int t = 0; t < SH_QK; t++) blk += (double)xb[t] * (double)q[t];
                acc += blk * (double)d;
            }
            orow[i] = (float)acc;
        }
    }
}

static bool sh_is_meta(const ggml_tensor *t) {
    switch (t->op) {
        case GGML_OP_NONE: case GGML_OP_RESHAPE: case GGML_OP_VIEW:
        case GGML_OP_PERMUTE: case GGML_OP_TRANSPOSE: return true;
        default: return false;
    }
}

static enum ggml_status ggml_backend_shielded_graph_compute(ggml_backend_t, ggml_cgraph *cgraph) {
    sh_state &s = sh_get();
    std::lock_guard<std::mutex> lk(s.mu);
    const double tg0 = sh_now_ms();
    const sh_simd *simd = sh_link_simd();

    const int n = ggml_graph_n_nodes(cgraph);
    for (int i = 0; i < n; i++) {
        ggml_tensor *node = ggml_graph_node(cgraph, i);
        if (node->op == GGML_OP_MUL_MAT && node->src[0] && node->src[0]->data) sh_register(s, node->src[0]);
    }
    if (s.dirty && s.link && !s.link_failed) {
        const double t0 = sh_now_ms();
        const int rc = sh_link_start(s.link);
        if (rc != SH_OK) {
            SH_LOG("worker unavailable (%s); computing in the enclave instead\n", sh_link_last_error(s.link));
            s.link_failed = true;
        } else {
            SH_LOG("worker live over %s with %zu weights (%.0f ms to upload and install)\n",
                   sh_link_transport(s.link), s.weights.size(), sh_now_ms() - t0);
        }
        s.dirty = false;
    }

    std::vector<char> done((size_t)n, 0);
    for (int i = 0; i < n; i++) {
        if (done[i]) continue;
        ggml_tensor *node = ggml_graph_node(cgraph, i);
        if (sh_is_meta(node)) continue;
        if (node->op != GGML_OP_MUL_MAT) {
            // supports_op claims only matmuls and metadata ops, so this is
            // unreachable unless sched changes its mind about what we take.
            fprintf(stderr, "[shielded] refusing an op we never claimed (%s); failing the graph\n", ggml_op_name(node->op));
            return GGML_STATUS_FAILED;
        }
        const ggml_tensor *a = node->src[1];
        auto it = s.weights.find(ggml_get_name(node->src[0]));
        if (it == s.weights.end()) {
            // We claimed it in supports_op and then failed to register it. Compute
            // it honestly rather than killing the graph, and say so once.
            static std::set<std::string> told;
            const std::string nm = ggml_get_name(node->src[0]);
            if (told.insert(nm).second)
                fprintf(stderr, "[shielded] %s: claimed but not registered; computing it "
                                "in the enclave (nothing offloaded for this site)\n", nm.c_str());
            sh_plain_mul_mat(node->src[0], a, node);
            s.local_nodes++; done[i] = 1;
            continue;
        }

        /* Gather every later matmul in this split that reads the SAME activation
         * and belongs to the same group: gate with up, q with k and v. They are
         * one exchange under one pad. */
        std::vector<ggml_tensor *> members = { node };
        std::vector<sh_state::entry *> ents = { &it->second };
        for (int j = i + 1; j < n && members.size() < SH_GROUP_MAX; j++) {
            ggml_tensor *o = ggml_graph_node(cgraph, j);
            if (done[j] || sh_is_meta(o)) continue;
            if (o->op != GGML_OP_MUL_MAT || o->src[1] != a) continue;
            auto jt = s.weights.find(ggml_get_name(o->src[0]));
            if (jt == s.weights.end() || jt->second.group != it->second.group) continue;
            members.push_back(o); ents.push_back(&jt->second); done[j] = 1;
        }
        done[i] = 1;

        const sh_state::entry &e0 = *ents[0];
        const int64_t K = e0.K;
        const int32_t m = (int32_t)a->ne[1];
        const int af = e0.site->act_frac + sh_af_delta();

        /* x_field = round(x * 2^af), with the outlier channels held back. The
         * exponent is a public model constant; deriving it from the activation in
         * hand would buy field headroom by leaking activation magnitude. */
        const double te0 = sh_now_ms();
        std::vector<int64_t> x_gpu((size_t)m * K), x_tee;
        simd->encode((const float *)a->data, (size_t)m * K, ldexpf(1.0f, af), x_gpu.data());
        const size_t nout = e0.site->outliers.size();
        if (nout) {
            x_tee.resize((size_t)m * nout);
            for (int32_t r = 0; r < m; r++)
                for (size_t c = 0; c < nout; c++) {
                    const int64_t k = e0.site->outliers[c];
                    x_tee[(size_t)r * nout + c] = x_gpu[(size_t)r * K + k];
                    x_gpu[(size_t)r * K + k] = 0;
                }
        }
        s.t_encode += sh_now_ms() - te0;

        std::vector<std::vector<int64_t>> ys(members.size());
        std::vector<int64_t *> yp(members.size());
        std::vector<int> nodes(members.size());
        for (size_t t = 0; t < members.size(); t++) {
            ys[t].resize((size_t)m * ents[t]->N); yp[t] = ys[t].data(); nodes[t] = ents[t]->node;
        }
        const double tl0 = sh_now_ms();
        int rc;
        if (s.link && !s.link_failed && sh_link_is_live(s.link)) {
            rc = sh_link_gemm(s.link, nodes.data(), nodes.size(), x_gpu.data(), m, yp.data());
            if (rc == SH_ERR_VERIFY) {
                /* A corrupted product must never reach the caller: it would be
                 * sampled, streamed, or written into the KV cache, where one bad
                 * entry poisons every future token that attends to it. */
                s.verify_fail++;
                fprintf(stderr, "[shielded] %s\n", sh_link_last_error(s.link));
                return GGML_STATUS_FAILED;
            }
            if (rc != SH_OK) {
                SH_LOG("%s: offload failed (%s); falling back to the enclave\n",
                       ggml_get_name(node->src[0]), sh_link_last_error(s.link));
                s.link_failed = true;
                rc = sh_link_gemm_local(s.link, nodes.data(), nodes.size(), x_gpu.data(), m, yp.data());
                s.local_nodes += members.size();
            } else {
                s.offloaded_nodes += members.size(); s.exchanges++;
            }
        } else {
            rc = sh_link_gemm_local(s.link, nodes.data(), nodes.size(), x_gpu.data(), m, yp.data());
            s.local_nodes += members.size();
        }
        s.t_link += sh_now_ms() - tl0;
        if (rc != SH_OK) {
            // Not a verification failure (that returned above) -- a transport or
            // bookkeeping problem. The honest answer is still available locally.
            fprintf(stderr, "[shielded] %s: offload and local path both failed (%d); "
                            "computing it in the enclave\n", ggml_get_name(node->src[0]), rc);
            for (size_t t = 0; t < members.size(); t++) sh_plain_mul_mat(members[t]->src[0], a, members[t]);
            s.local_nodes += members.size();
            continue;
        }

        const double tp0 = sh_now_ms();
        for (size_t t = 0; t < members.size(); t++) {
            const sh_state::entry &e = *ents[t];
            const int64_t N = e.N;
            float *dst = (float *)members[t]->data;
            for (int32_t r = 0; r < m; r++) {
                int64_t *yr = ys[t].data() + (size_t)r * N;
                /* The outlier term, in the TEE, outside the field. */
                if (nout) simd->outlier_add(x_tee.data() + (size_t)r * nout, e.out_cols.data(), (int)nout, N, yr);
                /* Per-column descale: each output column carries its own exponent,
                 * which is what stops one outlier weight quantising a whole tensor
                 * to nothing. */
                simd->descale(yr, e.inv.data(), (size_t)N, dst + (size_t)r * N);
            }
            s.macs += (uint64_t)m * (uint64_t)K * (uint64_t)N;
        }
        s.t_post += sh_now_ms() - tp0;
    }
    s.t_graph += sh_now_ms() - tg0;
    return GGML_STATUS_SUCCESS;
}

static const struct ggml_backend_i ggml_backend_shielded_i = {
    /* .get_name            = */ ggml_backend_shielded_get_name,
    /* .free                = */ ggml_backend_shielded_free,
    /* .set_tensor_async    = */ NULL,
    /* .get_tensor_async    = */ NULL,
    /* .set_tensor_2d_async = */ NULL,
    /* .get_tensor_2d_async = */ NULL,
    /* .cpy_tensor_async    = */ NULL,
    /* .synchronize         = */ NULL,
    /* .graph_plan_create   = */ NULL,
    /* .graph_plan_free     = */ NULL,
    /* .graph_plan_update   = */ NULL,
    /* .graph_plan_compute  = */ NULL,
    /* .graph_compute       = */ ggml_backend_shielded_graph_compute,
    /* .event_record        = */ NULL,
    /* .event_wait          = */ NULL,
    /* .graph_optimize      = */ NULL,
};

static ggml_guid_t ggml_backend_shielded_guid(void) {
    static ggml_guid guid = { 0x51, 0x48, 0x1e, 0x1d, 0x22, 0x0b, 0x4c, 0x77,
                              0x9a, 0x3e, 0x6f, 0x14, 0xd0, 0x8b, 0x2a, 0x63 };
    return &guid;
}

bool ggml_backend_is_shielded(ggml_backend_t backend) {
    return backend != NULL && ggml_guid_matches(backend->guid, ggml_backend_shielded_guid());
}

/* --- device ------------------------------------------------------------- */
static const char *sh_dev_get_name(ggml_backend_dev_t) { return "Shielded"; }
static const char *sh_dev_get_description(ggml_backend_dev_t) {
    return "masked offload to an untrusted GPU";
}
static void sh_dev_get_memory(ggml_backend_dev_t, size_t *free, size_t *total) {
    *free = *total = 0;   /* the activations live in host memory, inside the CVM */
}
static enum ggml_backend_dev_type sh_dev_get_type(ggml_backend_dev_t) {
    /* ACCEL, not GPU: the card is real but it is not inside the enclave, and the
     * distinction is the whole product. A caller enumerating GPUs must not find
     * this and conclude it has one. */
    return GGML_BACKEND_DEVICE_TYPE_ACCEL;
}
static void sh_dev_get_props(ggml_backend_dev_t dev, struct ggml_backend_dev_props *props) {
    props->name        = sh_dev_get_name(dev);
    props->description = sh_dev_get_description(dev);
    props->type        = sh_dev_get_type(dev);
    sh_dev_get_memory(dev, &props->memory_free, &props->memory_total);
    props->caps = { /* async */ false, /* host_buffer */ false,
                    /* buffer_from_host_ptr */ true, /* events */ false };
}
static ggml_backend_t sh_dev_init_backend(ggml_backend_dev_t dev, const char *) {
    ggml_backend_t backend = new ggml_backend {
        /* .guid    = */ ggml_backend_shielded_guid(),
        /* .iface   = */ ggml_backend_shielded_i,
        /* .device  = */ dev,
        /* .context = */ NULL,
    };
    return backend;
}
static ggml_backend_buffer_type_t sh_dev_get_buffer_type(ggml_backend_dev_t) {
    /* Host memory, like the BLAS backend. What reaches the untrusted side is
     * decided explicitly in graph_compute -- never by ggml's buffer plumbing,
     * which has no idea some of these bytes are secret. */
    return ggml_backend_cpu_buffer_type();
}
static bool sh_dev_supports_op(ggml_backend_dev_t, const struct ggml_tensor *op) {
    switch (op->op) {
        case GGML_OP_NONE: case GGML_OP_RESHAPE: case GGML_OP_VIEW:
        case GGML_OP_PERMUTE: case GGML_OP_TRANSPOSE:
            return true;
        case GGML_OP_MUL_MAT:
            return sh_claimable(op, true);
        default:
            return false;   /* everything nonlinear or position-aware stays in the TEE */
    }
}
static bool sh_dev_supports_buft(ggml_backend_dev_t, ggml_backend_buffer_type_t buft) {
    return ggml_backend_buft_is_host(buft);
}

static const struct ggml_backend_device_i ggml_backend_shielded_device_i = {
    /* .get_name             = */ sh_dev_get_name,
    /* .get_description      = */ sh_dev_get_description,
    /* .get_memory           = */ sh_dev_get_memory,
    /* .get_type             = */ sh_dev_get_type,
    /* .get_props            = */ sh_dev_get_props,
    /* .init_backend         = */ sh_dev_init_backend,
    /* .get_buffer_type      = */ sh_dev_get_buffer_type,
    /* .get_host_buffer_type = */ NULL,
    /* .buffer_from_host_ptr = */ NULL,
    /* .supports_op          = */ sh_dev_supports_op,
    /* .supports_buft        = */ sh_dev_supports_buft,
    /* .offload_op           = */ NULL,
    /* .event_new            = */ NULL,
    /* .event_free           = */ NULL,
    /* .event_synchronize    = */ NULL,
};

/* --- reg ---------------------------------------------------------------- */
static const char *sh_reg_get_name(ggml_backend_reg_t) { return "Shielded"; }
static size_t sh_reg_get_device_count(ggml_backend_reg_t) { return 1; }
static ggml_backend_dev_t sh_reg_get_device(ggml_backend_reg_t reg, size_t) {
    static ggml_backend_device dev = {
        /* .iface   = */ ggml_backend_shielded_device_i,
        /* .reg     = */ reg,
        /* .context = */ NULL,
    };
    return &dev;
}
static const struct ggml_backend_reg_i ggml_backend_shielded_reg_i = {
    /* .get_name         = */ sh_reg_get_name,
    /* .get_device_count = */ sh_reg_get_device_count,
    /* .get_device       = */ sh_reg_get_device,
    /* .get_proc_address = */ NULL,
};

ggml_backend_reg_t ggml_backend_shielded_reg(void) {
    static ggml_backend_reg reg = {
        /* .api_version = */ GGML_BACKEND_API_VERSION,
        /* .iface       = */ ggml_backend_shielded_reg_i,
        /* .context     = */ NULL,
    };
    return &reg;
}

ggml_backend_t ggml_backend_shielded_init(void) {
    return sh_dev_init_backend(sh_reg_get_device(ggml_backend_shielded_reg(), 0), NULL);
}

/* Loadable as a module, so an engine picks the tier up as launch configuration
 * rather than a rebuild -- ggml_backend_load_all() finds it beside the binary or
 * on GGML_BACKEND_PATH. Only compiled in for the shared-library build; the static
 * one links ggml_backend_shielded_reg() directly. */
#ifdef GGML_BACKEND_DL
GGML_BACKEND_DL_IMPL(ggml_backend_shielded_reg)
#endif
