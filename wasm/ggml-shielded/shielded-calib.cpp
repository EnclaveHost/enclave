/*
 * shielded-calib -- calibrate ANY q8_0 GGUF the engine can run, for the C backend.
 *
 * calibrate.py does the same job through shielded/model.py, a numpy
 * re-implementation of ONE architecture (qwen2). That is why, until this tool,
 * only Qwen2.5-0.5B had a calibration: qwen3, qwen35 (hybrid deltanet), the VL
 * and MoE variants all load and run on the engine but nothing could calibrate
 * them. This tool has no model of the model. It runs the real engine
 * (libllama) over the calibration texts and observes every matmul the backend
 * could claim through ggml_backend_sched's eval callback -- the mechanism
 * llama-imatrix uses -- so whatever libllama can prefill, it can calibrate.
 *
 * WHAT IT DECIDES (the same two public constants per site as calibrate.py)
 *
 *   act_frac   the activation's fixed-point exponent, fixed per site. Never
 *              adapted per request: that would make a public parameter out of a
 *              secret activation's magnitude.
 *   outliers   the channels the TEE keeps for itself, chosen because their
 *              products alone would wrap the ~2^23.8 field.
 *
 * Both against TARGET = 25% of M/2 -- two bits of headroom over the worst thing
 * calibration saw, because calibration text is not the user's text, and the
 * runtime Freivalds check is what turns that margin into a guarantee: an unseen
 * input that overflows anyway aborts instead of returning plausible noise.
 *
 * WHY THIS ONE IS EXACT WHERE calibrate.py WAS NOT
 *
 * The product that has to fit the field is x_field . w_fixed, and w_fixed is
 * whatever the backend encodes at registration: sh_prepare_weight_rows(), one
 * exponent per OUTPUT COLUMN. calibrate.py measured against tee.py's per-TENSOR
 * encoding, where most columns carried a tiny w_fixed and therefore a tiny
 * product; the backend then needed SHIELDED_AF_DELTA=-5 to make those numbers
 * true again (see sh_af_delta in ggml-shielded.cpp). This tool links the same
 * shielded-field.c, built with the same -ffp-contract=off, so its w_fixed is
 * byte-identical to the runtime's and the exponent it chooses is the one the
 * runtime can actually use: SHIELDED_AF_DELTA returns to 0.
 *
 * TWO PASSES, SAME ORDER AS calibrate.py
 *
 * Pass A ranks channels by max|x| with nothing held back. Pass B fixes each
 * candidate outlier set and measures the peak product that would actually be
 * offloaded. One prefill over the texts collects the rows for both -- the rows
 * are kept in memory (a few hundred tokens x K floats per site, ~1.5 GB for a
 * 4B model), and pass B is the arithmetic: y_full once, in int64 (exact:
 * |x_field| < 2^17, |w| <= 119, K <= 2^17 keeps every partial sum under 2^41),
 * then the outlier columns' contributions subtracted per candidate k instead of
 * a GEMM per k.
 *
 * SITES THAT SHARE AN ACTIVATION
 *
 * The backend exchanges q/k/v under one pad because they read one tensor, and
 * looks the group up under the attn_q / ffn_gate name (sh_group_key). The real
 * criterion is "same src[1] in one graph", so that is what this tool records;
 * the name mapping is applied on top so the emitted key is the one the backend
 * looks for, and a group that the graph shares but the name mapping does not
 * know is reported, since the backend would then mask one plaintext twice.
 *
 * Nothing here is a runtime path: this is a separate host tool that sees
 * plaintext activations of PUBLIC text, and it is compiled into nothing the
 * enclave ships (security invariant 8).
 */
#include "llama.h"
#include "ggml-backend.h"
#include "ggml.h"

extern "C" {
#include "shielded-field.h"
}

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <thread>
#include <vector>

/* calibrate.py's CALIB_TEXTS, verbatim. Deliberately mixed -- prose, chat
 * framing, code, digits -- because which outlier channels light up is mildly
 * input-dependent and a single register would under-cover them. */
static const char *CALIB_TEXTS[] = {
    "<|im_start|>system\nYou are a helpful assistant.<|im_end|>\n"
    "<|im_start|>user\nExplain in one paragraph why the sky appears blue.<|im_end|>\n"
    "<|im_start|>assistant\nSunlight contains every colour, and air scatters the short "
    "wavelengths far more strongly than the long ones, so blue light arrives from every "
    "direction at once while red passes straight through.<|im_end|>",
    "<|im_start|>user\nWrite a Python function that reverses a linked list.<|im_end|>\n"
    "<|im_start|>assistant\ndef reverse(head):\n    prev = None\n    while head:\n"
    "        head.next, prev, head = prev, head, head.next\n    return prev<|im_end|>",
    "The quick brown fox jumps over the lazy dog. 0123456789 -- punctuation, commas; "
    "colons: and (parentheses) all appear here, alongside UPPERCASE and lowercase.",
    "In 1687 Newton published the Principia, which set out three laws of motion and a "
    "law of universal gravitation, and remained the standard account of mechanics for "
    "over two centuries.",
};

static const int K_CANDIDATES[] = { 0, 4, 8, 16, 32 };
static const int N_K = (int)(sizeof(K_CANDIDATES) / sizeof(K_CANDIDATES[0]));
static const double TARGET = 0.25;      /* fraction of M/2 the worst calibration product may reach */
static const int AF_MIN = 3, AF_MAX = 14;
static const int REF_AF = 8;

/* The backend's grouping, copied rather than shared: ggml-shielded.cpp is the
 * shipped artifact and must not grow a dependency on a host tool. Keep the two
 * tables identical. */
static std::string group_key(const std::string &name) {
    static const std::pair<const char *, const char *> members[] = {
        { "attn_k",    "attn_q" },   { "attn_v",    "attn_q" },
        { "ffn_up",    "ffn_gate" },
        { "attn_gate", "attn_qkv" }, { "ssm_alpha", "attn_qkv" }, { "ssm_beta", "attn_qkv" },
        { "ssm_ba",    "attn_qkv" },
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

struct site {
    int64_t K = 0;
    std::vector<float> rows;               /* m_total x K, every captured activation row */
    int64_t m_total = 0;
    std::set<std::string> members;         /* weight tensor names fed by this activation */
    std::map<std::string, const ggml_tensor *> weights;
};

struct capture {
    std::map<std::string, site> sites;
    int decode_id = 0;
    /* (decode, src1 ptr, group) already stored, so k and v do not re-store q's
     * rows. Keyed by GROUP, not by tensor alone: a shared activation the name
     * map does not fold is one calib entry per group, and each needs the rows
     * -- storing them once under the first group calibrated the others against
     * no data at all and gave them act_frac=14 with infinite headroom (seen on
     * qwen35's attn_gate / ssm_alpha / ssm_beta before the table learned them). */
    std::set<std::pair<std::pair<int, const void *>, std::string>> stored;
    /* src1 pointer -> group key, per decode: detects sharing the name map misses */
    std::map<const void *, std::string> ptr_group;
    std::set<std::string> unmapped_sharing;
    std::set<std::string> skipped;
    bool verbose = false;
};

/* The backend's claimability rules (sh_claimable), minus the MIN_MACS policy:
 * calibrate every site, the policy can change without a recalibration. */
static bool claimable(const ggml_tensor *op) {
    if (op->op != GGML_OP_MUL_MAT) return false;
    const ggml_tensor *src0 = op->src[0], *src1 = op->src[1];
    if (!src0 || !src1) return false;
    if (src0->type != GGML_TYPE_Q8_0) return false;
    if (src1->type != GGML_TYPE_F32) return false;
    if (op->type != GGML_TYPE_F32) return false;
    if (!ggml_is_contiguous(src0) || !ggml_is_contiguous(src1)) return false;
    if (src0->ne[2] != 1 || src0->ne[3] != 1) return false;
    if (src1->ne[2] != 1 || src1->ne[3] != 1) return false;
    if (src0->ne[0] % SH_QK != 0 || src0->ne[0] % 16 != 0) return false;
    const char *nm = ggml_get_name(src0);
    if (!nm || !*nm) return false;
    return true;
}

/* "blk.7.attn_qkv.weight" -> "attn_qkv", so a per-layer fact is said once. */
static std::string strip_blk(const std::string &name) {
    std::string s = name;
    if (s.rfind("blk.", 0) == 0) { const size_t d = s.find('.', 4); if (d != std::string::npos) s = s.substr(d + 1); }
    const size_t w = s.rfind(".weight");
    if (w != std::string::npos) s = s.substr(0, w);
    return s;
}

static bool eval_cb(struct ggml_tensor *t, bool ask, void *ud) {
    capture *c = (capture *)ud;
    if (ask) {
        if (t->op == GGML_OP_MUL_MAT && t->src[0] && t->src[0]->type == GGML_TYPE_Q8_0) {
            if (claimable(t)) return true;
            const char *nm = ggml_get_name(t->src[0]);
            if (nm && *nm && c->skipped.insert(nm).second && c->verbose)
                fprintf(stderr, "[calib] %s: q8_0 matmul the backend would not claim (shape/layout); skipped\n", nm);
        }
        return false;
    }
    if (!claimable(t)) return true;
    const ggml_tensor *w = t->src[0], *a = t->src[1];
    const std::string name = ggml_get_name(w);
    const std::string g = group_key(name);
    site &s = c->sites[g];
    const int64_t K = w->ne[0], m = a->ne[1];
    if (s.K == 0) s.K = K;
    if (s.K != K) { fprintf(stderr, "[calib] %s: K=%lld but group %s has K=%lld\n", name.c_str(), (long long)K, g.c_str(), (long long)s.K); exit(2); }
    s.members.insert(name);
    s.weights[name] = w;

    /* Sharing evidence, from the graph itself. */
    auto pg = c->ptr_group.find(a);
    if (pg == c->ptr_group.end()) c->ptr_group[a] = g;
    else if (pg->second != g) c->unmapped_sharing.insert(strip_blk(pg->second) + " + " + strip_blk(g));

    if (c->stored.insert({ { c->decode_id, (const void *)a }, g }).second) {
        const float *x = (const float *)a->data;
        s.rows.insert(s.rows.end(), x, x + (size_t)m * K);
        s.m_total += m;
    }
    return true;
}

/* Pass B for one weight: peak |x_field . w_fixed| with the top-k channels
 * zeroed, for every k at once. y_full once; nested outlier prefixes subtracted
 * in order. Threads split N. */
static void peak_for_weight(const std::vector<int32_t> &xq, int64_t m, int64_t K,
                            const int8_t *w, int64_t N, const std::vector<int64_t> &order,
                            int64_t peaks[]) {
    const int nth = std::max(1u, std::min(std::thread::hardware_concurrency(), 32u));
    std::vector<std::vector<int64_t>> local(nth, std::vector<int64_t>(N_K, 0));
    std::vector<std::thread> th;
    for (int ti = 0; ti < nth; ti++) {
        th.emplace_back([&, ti]() {
            std::vector<int64_t> &pk = local[ti];
            for (int64_t j = ti; j < N; j += nth) {
                const int8_t *wj = w + (size_t)j * K;
                for (int64_t r = 0; r < m; r++) {
                    const int32_t *xr = xq.data() + (size_t)r * K;
                    int64_t acc = 0;
                    for (int64_t k = 0; k < K; k++) acc += (int64_t)xr[k] * wj[k];
                    int64_t y = acc;
                    int used = 0;
                    for (int ki = 0; ki < N_K; ki++) {
                        const int kk = K_CANDIDATES[ki];
                        for (; used < kk && used < (int)order.size(); used++) {
                            const int64_t o = order[used];
                            y -= (int64_t)xr[o] * wj[o];
                        }
                        const int64_t ay = y < 0 ? -y : y;
                        if (ay > pk[ki]) pk[ki] = ay;
                    }
                }
            }
        });
    }
    for (auto &t : th) t.join();
    for (int ki = 0; ki < N_K; ki++) {
        peaks[ki] = 0;
        for (int ti = 0; ti < nth; ti++) peaks[ki] = std::max(peaks[ki], local[ti][ki]);
    }
}

static void usage() {
    fprintf(stderr,
        "usage: shielded-calib [--threads N] [--verbose] [--omit-tight] [--backend path.so ...] [--lib-dir DIR] <model.gguf> <out.calib>\n"
        "  --max-k-div D allow at most K/D outlier channels per site (default 64): every held-back channel is\n"
        "                a TEE-side multiply per output per row, so on a K=896 x N=151936 lm_head 32 channels\n"
        "                cost 4.9 M MACs per token for one bit of exponent; 0 = no bound\n"
        "  --keep-tight  include sites that cannot reach the headroom target even at the smallest exponent\n"
        "                (default: such a site is left out and stays in the enclave; a wider input would\n"
        "                otherwise wrap the field there and abort the request)\n"
        "  --backend  ggml backend module to load (the CPU one, when ggml is a shared build); repeatable\n"
        "  --lib-dir  directory to load every ggml backend module from (GGML_LIB in the Makefile)\n"
        "  env GGML_CPU_SO is honoured as one --backend\n");
    exit(2);
}

int main(int argc, char **argv) {
    int threads = (int)std::max(1u, std::thread::hardware_concurrency());
    capture cap;
    std::vector<std::string> backends;
    std::string lib_dir, model_path, out_path;
    bool omit_tight = true;
    int  max_k_div = 64;                            /* outliers per site <= K / max_k_div; see --max-k-div */                        /* a site below TARGET stays in the enclave unless --keep-tight */
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        if (a == "--threads" && i + 1 < argc) threads = atoi(argv[++i]);
        else if (a == "--verbose") cap.verbose = true;
        else if (a == "--omit-tight") omit_tight = true;
        else if (a == "--keep-tight") omit_tight = false;
        else if (a == "--max-k-div" && i + 1 < argc) max_k_div = std::max(1, atoi(argv[++i]));
        else if (a == "--backend" && i + 1 < argc) backends.push_back(argv[++i]);
        else if (a == "--lib-dir" && i + 1 < argc) lib_dir = argv[++i];
        else if (a[0] == '-') usage();
        else if (model_path.empty()) model_path = a;
        else if (out_path.empty()) out_path = a;
        else usage();
    }
    if (model_path.empty() || out_path.empty()) usage();
    if (const char *e = getenv("GGML_CPU_SO")) if (*e) backends.push_back(e);

    for (const auto &b : backends)
        fprintf(stderr, "[calib] backend %s: %s\n", b.c_str(), ggml_backend_load(b.c_str()) ? "loaded" : "FAILED");
    if (!lib_dir.empty()) ggml_backend_load_all_from_path(lib_dir.c_str());
    llama_backend_init();
    if (ggml_backend_dev_count() == 0) {
        fprintf(stderr, "[calib] no ggml device: pass --backend <libggml-cpu.so> or --lib-dir\n");
        return 2;
    }
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        ggml_backend_dev_t d = ggml_backend_dev_get(i);
        if (ggml_backend_dev_type(d) != GGML_BACKEND_DEVICE_TYPE_CPU && cap.verbose)
            fprintf(stderr, "[calib] device %zu (%s) is not the CPU; n_gpu_layers=0 keeps the weights readable\n",
                    i, ggml_backend_dev_name(d));
    }

    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = 0;            /* the rows must be host memory we can read */
    llama_model *model = llama_model_load_from_file(model_path.c_str(), mp);
    if (!model) { fprintf(stderr, "[calib] model load failed\n"); return 2; }
    const llama_vocab *vocab = llama_model_get_vocab(model);

    /* Tokenise everything first: the context is sized to hold the longest text
     * as one ubatch, so each text is one graph and one prefill. */
    const int n_texts = (int)(sizeof(CALIB_TEXTS) / sizeof(CALIB_TEXTS[0]));
    std::vector<std::vector<llama_token>> ids(n_texts);
    uint32_t longest = 0; int64_t n_tokens = 0;
    for (int i = 0; i < n_texts; i++) {
        std::vector<llama_token> t(4096);
        int n = llama_tokenize(vocab, CALIB_TEXTS[i], (int)strlen(CALIB_TEXTS[i]), t.data(), (int)t.size(), true, true);
        if (n < 0) { fprintf(stderr, "[calib] tokenize failed on text %d\n", i); return 2; }
        t.resize(n); ids[i] = t;
        longest = std::max(longest, (uint32_t)n); n_tokens += n;
    }

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = cp.n_batch = cp.n_ubatch = std::max(512u, (longest + 63) / 64 * 64);
    cp.n_threads = cp.n_threads_batch = threads;
    cp.cb_eval = eval_cb;
    cp.cb_eval_user_data = &cap;
    llama_context *ctx = llama_init_from_model(model, cp);
    if (!ctx) { fprintf(stderr, "[calib] context failed\n"); return 2; }

    for (int i = 0; i < n_texts; i++) {
        llama_memory_clear(llama_get_memory(ctx), true);
        llama_batch b = llama_batch_init((int32_t)ids[i].size(), 0, 1);
        b.n_tokens = (int32_t)ids[i].size();
        for (int32_t k = 0; k < b.n_tokens; k++) {
            b.token[k] = ids[i][k]; b.pos[k] = k; b.n_seq_id[k] = 1; b.seq_id[k][0] = 0;
            b.logits[k] = 1;        /* every position reaches lm_head, as in calibrate.py */
        }
        cap.decode_id++;
        cap.ptr_group.clear();
        const int rc = llama_decode(ctx, b);
        llama_batch_free(b);
        if (rc != 0) { fprintf(stderr, "[calib] llama_decode failed on text %d (rc %d)\n", i, rc); return 2; }
    }
    fprintf(stderr, "[calib] %d texts, %lld tokens, %zu sites captured", n_texts, (long long)n_tokens, cap.sites.size());
    if (!cap.skipped.empty()) fprintf(stderr, ", %zu q8_0 matmuls not claimable", cap.skipped.size());
    fprintf(stderr, "\n");
    for (const auto &u : cap.unmapped_sharing)
        fprintf(stderr, "[calib] WARNING: %s share one activation in the graph but sh_group_key keeps them apart: "
                        "each is calibrated on its own here, but the backend would mask one plaintext twice -- "
                        "extend sh_group_key before offloading both\n", u.c_str());

    /* ---- choose (k, act_frac) per site --------------------------------- */
    const double limit = TARGET * (double)SH_HALF_M;
    struct result { int af, k; int64_t peak; double headroom; std::vector<int64_t> outliers; size_t members; };
    std::map<std::string, result> chosen;
    std::vector<int8_t> wbuf; std::vector<int> fw;
    std::set<std::string> refused;
    int n_tight = 0;
    for (auto &kv : cap.sites) {
        const std::string &g = kv.first;
        site &s = kv.second;
        const int64_t K = s.K, m = s.m_total;

        /* pass A: rank channels by max|x| over every row */
        std::vector<float> cmax((size_t)K, 0.0f);
        for (int64_t r = 0; r < m; r++) {
            const float *x = s.rows.data() + (size_t)r * K;
            for (int64_t k = 0; k < K; k++) { const float a = fabsf(x[k]); if (a > cmax[k]) cmax[k] = a; }
        }
        std::vector<int64_t> order((size_t)K);
        for (int64_t k = 0; k < K; k++) order[k] = k;
        const int kmax = std::min<int64_t>(K, K_CANDIDATES[N_K - 1]);
        /* argsort(-c), stable, so ties resolve to the lower channel like numpy's */
        std::stable_sort(order.begin(), order.end(), [&](int64_t a, int64_t b) { return cmax[a] > cmax[b]; });
        order.resize(kmax);

        /* x_field at the reference exponent: rint(x * 2^REF_AF) */
        std::vector<int32_t> xq((size_t)m * K);
        for (size_t i = 0; i < xq.size(); i++) xq[i] = (int32_t)llrint((double)s.rows[i] * (double)(1 << REF_AF));

        /* pass B: peak per candidate k, max over the group's members */
        int64_t peaks[N_K] = { 0 };
        bool ok = true;
        for (const auto &wn : s.weights) {
            const ggml_tensor *w = wn.second;
            const int64_t N = w->ne[1];
            wbuf.resize((size_t)K * N); fw.resize((size_t)N);
            if (sh_prepare_weight_rows(w->data, K, N, wbuf.data(), fw.data()) < 0) {
                fprintf(stderr, "[calib] %s: no weight exponent fits the int8 lane; the backend would refuse it too\n", wn.first.c_str());
                refused.insert(wn.first); ok = false; break;
            }
            int64_t p[N_K];
            peak_for_weight(xq, m, K, wbuf.data(), N, order, p);
            for (int ki = 0; ki < N_K; ki++) peaks[ki] = std::max(peaks[ki], p[ki]);
        }
        if (!ok) continue;

        /* The outlier budget: at most K / max_k_div channels, because every
         * held-back channel is a TEE-side multiply per output per row -- on the
         * 0.5B's lm_head (K=896, N=151936) the unbounded rule took 32 channels
         * for ONE bit of exponent (peak 16.0M -> 14.1M) at 4.9M MACs per token,
         * 0.4 ms of a 4.6 ms token. A site that cannot reach the target within
         * the budget gets the whole candidate list back (the second pass): wrap
         * safety outranks TEE time. */
        const int kbound = max_k_div > 0 ? (int)std::min<int64_t>(kmax, K / max_k_div) : kmax;
        result best; best.af = -1; best.k = 0; best.peak = 0;
        for (int pass = 0; pass < 2; pass++) {
        if (pass == 1) {
            const bool tight0 = best.af == AF_MIN && (double)best.peak * ldexp(1.0, AF_MIN - REF_AF) > limit;
            if (!tight0 || kbound >= kmax) break;
        }
        for (int ki = 0; ki < N_K; ki++) {
            const int kk = K_CANDIDATES[ki];
            if (kk > kmax) break;
            if (pass == 0 && kk > kbound) break;
            const int64_t p = peaks[ki];
            int af;
            if (p <= 0) af = AF_MAX;
            else {
                af = REF_AF + (int)floor(log2(limit / (double)p));
                af = std::max(AF_MIN, std::min(AF_MAX, af));
            }
            /* Smallest k that reaches the best exponent: holding back channels is
             * cheap but not free, and every held-back channel is TEE work. One
             * refinement over calibrate.py: once the exponent is pinned at AF_MIN
             * the target is out of reach, and then the k with the smallest peak
             * is the one that keeps the most headroom -- Qwen3-4B's blk.35
             * ffn_down needs it. */
            const bool tight = af == AF_MIN && (double)p * ldexp(1.0, AF_MIN - REF_AF) > limit;
            if (best.af < 0 || af > best.af || (tight && af == best.af && p < best.peak)) { best.af = af; best.k = kk; best.peak = p; }
        }
        }
        best.headroom = (double)SH_HALF_M / std::max(1.0, (double)best.peak * ldexp(1.0, best.af - REF_AF));
        if (best.headroom < 1.0 / TARGET) {
            fprintf(stderr, "[calib] %s: only %.2fx headroom at act_frac=%d with %d outliers (target %.0fx): an input "
                            "wider than the calibration text can wrap the field there, which the runtime Freivalds "
                            "check turns into a dead request rather than a wrong answer; %s\n",
                    g.c_str(), best.headroom, best.af, best.k, 1.0 / TARGET,
                    omit_tight ? "OMITTED, the backend keeps it in the enclave" : "--omit-tight leaves it in the enclave");
            n_tight++;
            if (omit_tight) { std::vector<float>().swap(s.rows); continue; }
        }
        best.outliers.assign(order.begin(), order.begin() + best.k);
        std::sort(best.outliers.begin(), best.outliers.end());
        best.members = s.members.size();
        if (cap.verbose) {
            fprintf(stderr, "[calib] %-34s K=%-6lld m=%-4lld members=%zu k=%-3d act_frac=%-3d peak_ref=%lld headroom=%.2fx  peaks/k:",
                    g.c_str(), (long long)K, (long long)m, s.members.size(), best.k, best.af, (long long)best.peak, best.headroom);
            for (int ki = 0; ki < N_K && K_CANDIDATES[ki] <= kmax; ki++) fprintf(stderr, " %lld", (long long)peaks[ki]);
            fprintf(stderr, "\n");
        }
        /* The emitted key is what the backend looks up (sh_group_key of each
         * member). When the fold names a tensor this model does not have -- an
         * architecture whose attn_gate shares the norm output with attn_q rather
         * than with an attn_qkv -- emitting the folded name would let the backend
         * offload that member as a SECOND group under a second pad. Emit the site
         * under its first member's own name instead: the backend then finds no
         * calibration for those members and keeps them in the enclave, which is
         * the safe reading of a fold the table does not understand. */
        std::string emit_key = g;
        if (!s.members.count(g)) {
            emit_key = *s.members.begin();
            fprintf(stderr, "[calib] WARNING: %s folds to %s, which this model does not have; emitted as %s and the "
                            "backend will keep its members in the enclave until sh_group_key learns this architecture\n",
                    strip_blk(emit_key).c_str(), strip_blk(g).c_str(), emit_key.c_str());
        }
        chosen[emit_key] = std::move(best);
        std::vector<float>().swap(s.rows);
    }

    /* ---- export-calib.py's format, byte for byte ------------------------ */
    FILE *f = fopen(out_path.c_str(), "w");
    if (!f) { fprintf(stderr, "[calib] cannot write %s\n", out_path.c_str()); return 2; }
    fprintf(f, "# shielded-calib 2\n");             /* 2 = per-column exponents, SHIELDED_AF_DELTA=0 */
    fprintf(f, "# from %s: %zu sites, reference exponent %d\n", model_path.c_str(), chosen.size(), REF_AF);
    fprintf(f, "# shielded-calib (C, engine-observed): %d texts, %lld tokens, per-column weight encoding -> SHIELDED_AF_DELTA=0\n",
            n_texts, (long long)n_tokens);
    for (const auto &kv : chosen) {
        fprintf(f, "site %s %d %zu", kv.first.c_str(), kv.second.af, kv.second.outliers.size());
        for (int64_t o : kv.second.outliers) fprintf(f, " %lld", (long long)o);
        fprintf(f, "\n");
    }
    fclose(f);

    /* summary: per site kind (attn_q, ffn_down, ...), like calibrate.py's main */
    std::map<std::string, std::vector<const result *>> by_kind;
    for (const auto &kv : chosen) {
        std::string kind = kv.first;
        const size_t dot2 = kind.rfind('.');
        if (dot2 != std::string::npos) kind = kind.substr(0, dot2);
        const size_t dot1 = kind.rfind('.');
        if (dot1 != std::string::npos) kind = kind.substr(dot1 + 1);
        by_kind[kind].push_back(&kv.second);
    }
    fprintf(stderr, "[calib] wrote %s (%zu sites%s)\n", out_path.c_str(), chosen.size(),
            n_tight ? (omit_tight ? ", tight sites omitted" : ", INCLUDING tight sites") : "");
    fprintf(stderr, "  %-14s %5s %-16s %-14s %10s %10s\n", "site", "n", "act_frac", "k", "min-head", "med-head");
    for (auto &kv : by_kind) {
        std::vector<double> h; std::set<int> afs, ks;
        for (const result *r : kv.second) { h.push_back(r->headroom); afs.insert(r->af); ks.insert(r->k); }
        std::sort(h.begin(), h.end());
        std::string afl, kl;
        for (int a : afs) afl += (afl.empty() ? "" : ",") + std::to_string(a);
        for (int k : ks) kl += (kl.empty() ? "" : ",") + std::to_string(k);
        fprintf(stderr, "  %-14s %5zu %-16s %-14s %9.2fx %9.2fx\n", kv.first.c_str(), h.size(), afl.c_str(), kl.c_str(),
                h.front(), h[h.size() / 2]);
    }
    for (const auto &r : refused) fprintf(stderr, "  refused: %s\n", r.c_str());

    llama_free(ctx); llama_model_free(model);
    return 0;
}
