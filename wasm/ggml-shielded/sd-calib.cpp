/*
 * sd-calib -- calibrate a stable-diffusion.cpp model (diffusion transformer and
 * LLM text encoder) for the shielded backend. The diffusion sibling of
 * shielded-calib: same decisions, same constants, same output format, observed
 * through stable-diffusion.cpp's backend eval callback instead of libllama's.
 *
 * WHAT IT DECIDES -- per activation group, as shielded-calib does:
 *   act_frac   the fixed-point exponent (a PUBLIC model constant, never adapted
 *              per request) and
 *   outliers   the channels the TEE keeps, so the offloaded product stays under
 *              TARGET = 25% of M/2 for everything calibration saw.
 * The runtime Freivalds check turns the headroom into a guarantee: an unseen
 * input that wraps the field aborts the request, never returns noise.
 *
 * WHAT IS DIFFERENT FROM shielded-calib, AND WHY
 *   Scale. A diffusion step pushes every image token through every linear: a
 *   512px Z-Image step is ~1,100 rows per site, eight steps per image, ~280
 *   sites. Keeping every row (shielded-calib's approach) is tens of GB. So:
 *     pass A (channel ranking, max|x|) runs over EVERY row, online;
 *     pass B (peak product per outlier count) runs over a bounded row set per
 *     site: the rows with the largest L2 and L-inf norms (the ones that make
 *     extreme products) plus a uniform reservoir sample.
 *   A row pass B did not see can still be wider than every row it did; that is
 *   what the 2-bit TARGET margin and the runtime check are for.
 *
 *   Shared timestep inputs. Every DiT block's adaLN_modulation reads the SAME
 *   timestep embedding through a different weight. Offloading them would mask
 *   one plaintext under ~30 pads in one step (the case shielded-group-key.h
 *   exists to prevent); they are single-row and cheap, so this tool does not
 *   calibrate them and the backend keeps them in the enclave.
 *
 * Nothing here is a runtime path: a separate host tool that sees plaintext
 * activations of PUBLIC prompts, compiled into nothing the enclave ships.
 */
#include "stable-diffusion.h"
#include "ggml-backend.h"
#include "ggml.h"

extern "C" {
#include "shielded-field.h"
}
#include "shielded-source-quant.h"
#include "shielded-group-key.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <map>
#include <random>
#include <set>
#include <string>
#include <thread>
#include <vector>

/* Public prompts, mixed on purpose: photographs, people, text rendering,
 * illustration, dense detail. Which channels light up is input-dependent. */
static const char *PROMPTS[] = {
    "A candid photo of an elderly fisherman mending a net on a wooden dock at golden hour, weathered hands, "
    "gulls in the background, shallow depth of field",
    "A vintage travel poster for a mountain town, bold art-deco style, large title text that reads "
    "\"ALPINE EXPRESS\" and smaller text \"Daily departures 7:15\"",
    "Studio product shot of a glass perfume bottle on black velvet, dramatic rim lighting, reflections, 85mm",
    "A busy night market in Taipei, neon signs with Chinese characters, steam rising from food stalls, rain on the street",
    "Watercolor illustration of a fox reading a book under a giant mushroom, soft pastel palette, children's book style",
    "Isometric 3D render of a tiny cozy bedroom with a desk, plants, a cat on the bed, warm lamp light",
    "Macro photograph of a dragonfly on a reed covered in morning dew, extreme detail, bokeh",
    "A minimalist infographic titled \"WATER CYCLE\" with arrows, clouds, a mountain and labels "
    "\"evaporation\", \"condensation\", \"precipitation\"",
};

static const int K_CANDIDATES[] = { 0, 4, 8, 16, 32 };
static const int N_K = (int)(sizeof(K_CANDIDATES) / sizeof(K_CANDIDATES[0]));
static const double TARGET = 0.25;
static const int AF_MIN = 3, AF_MAX = 14;
static const int REF_AF = 8;

struct row_set {
    /* bounded "most extreme" rows by one score; min-heap on score */
    size_t cap = 0;
    std::vector<std::pair<float, std::vector<float>>> heap;
    void offer(float score, const float *x, int64_t K) {
        auto cmp = [](const std::pair<float, std::vector<float>> &a, const std::pair<float, std::vector<float>> &b) {
            return a.first > b.first;
        };
        if (heap.size() < cap) {
            heap.emplace_back(score, std::vector<float>(x, x + K));
            std::push_heap(heap.begin(), heap.end(), cmp);
        } else if (cap && score > heap.front().first) {
            std::pop_heap(heap.begin(), heap.end(), cmp);
            heap.back().first = score;
            heap.back().second.assign(x, x + K);
            std::push_heap(heap.begin(), heap.end(), cmp);
        }
    }
};

struct site {
    int64_t K = 0;
    int64_t m_total = 0;
    std::vector<float> cmax;                 /* pass A: max|x| per channel over EVERY row */
    row_set by_l2, by_linf;
    std::vector<std::vector<float>> reservoir;
    int64_t seen = 0;
    std::set<std::string> members;
    std::map<std::string, const ggml_tensor *> weights;
};

struct capture {
    std::map<std::string, site> sites;
    int graph_id = 0;
    std::set<std::pair<std::pair<int, const void *>, std::string>> stored;
    std::map<const void *, std::string> ptr_group;
    std::set<std::string> unmapped_sharing;
    std::set<std::string> skipped;
    size_t top_rows = 128, sample_rows = 128;
    std::mt19937_64 rng{ 0x5eedc0de };
    bool verbose = false;
};
static capture g_cap;

static bool excluded(const std::string &name) {
    if (name.find("adaLN_modulation") != std::string::npos || name.find("t_embedder") != std::string::npos) return true;
    /* caption-token layers: only image rows are calibrated (see the lead rows below) */
    if (name.find("context_refiner") != std::string::npos || name.find("cap_embedder") != std::string::npos) return true;
    /* SD_CALIB_ONLY=<prefix>[,<prefix>...]: observe only these sites (to add a few to an
     * existing calibration) */
    static const char *only = getenv("SD_CALIB_ONLY");
    if (!only || !*only) return false;
    for (const char *p = only; *p;) {
        const char *e = strchr(p, ',');
        const size_t n = e ? (size_t)(e - p) : strlen(p);
        if (n && name.compare(0, n, p, n) == 0) return false;
        if (!e) break;
        p = e + 1;
    }
    return true;
}

/* sh_claimable minus the MIN_MACS / batch policy, as shielded-calib. */
static bool claimable(const ggml_tensor *op) {
    if (op->op != GGML_OP_MUL_MAT) return false;
    const ggml_tensor *src0 = op->src[0], *src1 = op->src[1];
    if (!src0 || !src1) return false;
    if (!sh_source_type_ok(src0->type)) return false;
    if (!sh_source_geometry_ok(src0->type, src0->ne[0])) return false;
    if (src1->type != GGML_TYPE_F32 || op->type != GGML_TYPE_F32) return false;
    if (!ggml_is_contiguous(src0) || !ggml_is_contiguous(src1)) return false;
    if (src0->ne[2] != 1 || src0->ne[3] != 1) return false;
    if (src1->ne[2] != 1 || src1->ne[3] != 1) return false;
    if (src0->ne[0] % SH_QK != 0 || src0->ne[0] % 16 != 0) return false;
    const char *nm = ggml_get_name(src0);
    if (!nm || !*nm) return false;
    return !excluded(nm);
}

static bool eval_cb(struct ggml_tensor *t, bool ask, void *) {
    capture *c = &g_cap;
    if (ask) {
        if (t->op == GGML_OP_MUL_MAT && t->src[0] && sh_source_type_ok(t->src[0]->type)) {
            if (claimable(t)) return true;
            const char *nm = ggml_get_name(t->src[0]);
            if (nm && *nm && c->skipped.insert(nm).second && c->verbose)
                fprintf(stderr, "[sd-calib] %s: not claimable (shape/layout/excluded); stays in the enclave\n", nm);
        }
        return false;
    }
    if (!claimable(t)) return true;
    const ggml_tensor *w = t->src[0], *a = t->src[1];
    const std::string name = ggml_get_name(w);
    /* SD_CALIB_LEAD=1: the joint layers' CAPTION rows instead (sites keyed "lead:<group>"),
     * for a backend that exchanges them under their own calibration (SHIELDED_CALIB_LEAD). */
    static const bool lead_mode = [] { const char *e = getenv("SD_CALIB_LEAD"); return e && e[0] == '1'; }();
    const bool joint = name.rfind("model.diffusion_model.layers.", 0) == 0;
    const std::string g = (lead_mode && joint ? "lead:" : "") + sh_group_key(name);
    site &s = c->sites[g];
    const int64_t K = w->ne[0], m = a->ne[1];
    if (s.K == 0) {
        s.K = K;
        s.cmax.assign((size_t)K, 0.0f);
        s.by_l2.cap = c->top_rows;
        s.by_linf.cap = c->top_rows;
    }
    if (s.K != K) { fprintf(stderr, "[sd-calib] %s: K=%lld but group %s has K=%lld\n", name.c_str(), (long long)K, g.c_str(), (long long)s.K); exit(2); }
    s.members.insert(name);
    s.weights[name] = w;

    auto pg = c->ptr_group.find(a);
    if (pg == c->ptr_group.end()) c->ptr_group[a] = g;
    else if (pg->second != g) c->unmapped_sharing.insert(pg->second + " + " + g);

    if (!c->stored.insert({ { c->graph_id, (const void *)a }, g }).second) return true;
    const float *x = (const float *)a->data;
    /* The joint layers' caption rows stay in the enclave at run time (the model's
     * lead-rows hint, sd_get_accel_lead_rows): calibrate those sites on the image
     * rows only, which is all the backend will ever offload there. */
    int64_t r0 = 0, r1 = m;
    if (joint) {
        const int lead = sd_get_accel_lead_rows();
        if (lead > 0 && lead < m) { if (lead_mode) r1 = lead; else r0 = lead; }
    }
    for (int64_t r = r0; r < r1; r++) {
        const float *xr = x + (size_t)r * K;
        double l2 = 0; float linf = 0;
        for (int64_t k = 0; k < K; k++) {
            const float v = fabsf(xr[k]);
            if (v > s.cmax[k]) s.cmax[k] = v;
            if (v > linf) linf = v;
            l2 += (double)v * v;
        }
        s.by_l2.offer((float)l2, xr, K);
        s.by_linf.offer(linf, xr, K);
        s.seen++;
        if (s.reservoir.size() < c->sample_rows) s.reservoir.emplace_back(xr, xr + K);
        else {
            const uint64_t j = c->rng() % (uint64_t)s.seen;
            if (j < c->sample_rows) s.reservoir[j].assign(xr, xr + K);
        }
    }
    s.m_total += r1 - r0;
    return true;
}

/* A new graph = a new activation pointer space; reset per-graph sharing state.
 * stable-diffusion.cpp does not tell us, so the progress callback marks steps. */
static void progress_cb(int, int, float, void *) {
    g_cap.graph_id++;
    g_cap.ptr_group.clear();
}

static void peak_for_weight(const std::vector<int32_t> &xq, int64_t m, int64_t K,
                            const int8_t *w, int64_t N, const std::vector<int64_t> &order,
                            int64_t peaks[], int threads) {
    const int nth = std::max(1, std::min(threads, 64));
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

static void log_cb(enum sd_log_level_t level, const char *text, void *) {
    if (level >= SD_LOG_WARN || getenv("SD_CALIB_LOG")) fputs(text, stderr);
}

static void usage() {
    fprintf(stderr,
        "usage: sd-calib --diffusion D.gguf --llm L.gguf --vae V.safetensors [--sizes 512,1024] [--prompts N]\n"
        "                [--steps 8] [--cfg 1.0] [--threads N] [--top-rows 128] [--sample-rows 128]\n"
        "                [--max-k-div 64] [--keep-tight] [--verbose] <out.calib>\n");
    exit(2);
}

int main(int argc, char **argv) {
    int threads = (int)std::max(1u, std::thread::hardware_concurrency());
    std::string diffusion, llm, vae, out_path, sizes_arg = "512";
    int n_prompts = (int)(sizeof(PROMPTS) / sizeof(PROMPTS[0]));
    int steps = 8, max_k_div = 64;
    float cfg = 1.0f;
    bool omit_tight = true;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        if (a == "--diffusion" && i + 1 < argc) diffusion = argv[++i];
        else if (a == "--llm" && i + 1 < argc) llm = argv[++i];
        else if (a == "--vae" && i + 1 < argc) vae = argv[++i];
        else if (a == "--sizes" && i + 1 < argc) sizes_arg = argv[++i];
        else if (a == "--prompts" && i + 1 < argc) n_prompts = std::max(1, std::min(n_prompts, atoi(argv[++i])));
        else if (a == "--steps" && i + 1 < argc) steps = atoi(argv[++i]);
        else if (a == "--cfg" && i + 1 < argc) cfg = (float)atof(argv[++i]);
        else if (a == "--threads" && i + 1 < argc) threads = atoi(argv[++i]);
        else if (a == "--top-rows" && i + 1 < argc) g_cap.top_rows = (size_t)atoi(argv[++i]);
        else if (a == "--sample-rows" && i + 1 < argc) g_cap.sample_rows = (size_t)atoi(argv[++i]);
        else if (a == "--max-k-div" && i + 1 < argc) max_k_div = std::max(1, atoi(argv[++i]));
        else if (a == "--keep-tight") omit_tight = false;
        else if (a == "--verbose") g_cap.verbose = true;
        else if (a[0] == '-') usage();
        else if (out_path.empty()) out_path = a;
        else usage();
    }
    if (diffusion.empty() || llm.empty() || vae.empty() || out_path.empty()) usage();
    if (getenv("SD_ACCEL_BACKEND")) { fprintf(stderr, "[sd-calib] unset SD_ACCEL_BACKEND: calibration observes the plain CPU graph\n"); return 2; }
    std::vector<int> sizes;
    for (size_t p = 0; p < sizes_arg.size();) {
        const size_t q = sizes_arg.find(',', p);
        sizes.push_back(atoi(sizes_arg.substr(p, q == std::string::npos ? std::string::npos : q - p).c_str()));
        if (q == std::string::npos) break;
        p = q + 1;
    }

    sd_set_log_callback(log_cb, nullptr);
    sd_ctx_params_t cp;
    sd_ctx_params_init(&cp);
    cp.diffusion_model_path = diffusion.c_str();
    cp.llm_path = llm.c_str();
    cp.vae_path = vae.c_str();
    cp.n_threads = threads;
    cp.diffusion_flash_attn = true;
    cp.enable_mmap = true;
    cp.backend = "CPU";
    sd_ctx_t *ctx = new_sd_ctx(&cp);
    if (!ctx) { fprintf(stderr, "[sd-calib] new_sd_ctx failed\n"); return 2; }
    sd_set_backend_eval_callback(eval_cb, nullptr);
    sd_set_progress_callback(progress_cb, nullptr);

    int images = 0;
    for (int sz : sizes) {
        for (int pi = 0; pi < n_prompts; pi++) {
            sd_img_gen_params_t gp;
            sd_img_gen_params_init(&gp);
            gp.prompt = PROMPTS[pi];
            gp.width = sz; gp.height = sz;
            gp.seed = 1000 + pi;
            gp.sample_params.sample_steps = steps;
            gp.sample_params.guidance.txt_cfg = cfg;
            gp.sample_params.sample_method = EULER_SAMPLE_METHOD;
            g_cap.graph_id++; g_cap.ptr_group.clear();
            sd_image_t *out = nullptr; int n_out = 0;
            if (!generate_image(ctx, &gp, &out, &n_out)) { fprintf(stderr, "[sd-calib] generation failed\n"); return 2; }
            for (int k = 0; k < n_out; k++) free(out[k].data);
            free(out);
            images++;
            fprintf(stderr, "[sd-calib] image %d (%dpx, prompt %d): %zu sites so far\n", images, sz, pi, g_cap.sites.size());
        }
    }
    sd_set_backend_eval_callback(nullptr, nullptr);
    for (const auto &u : g_cap.unmapped_sharing)
        fprintf(stderr, "[sd-calib] WARNING: %s share one activation but sh_group_key keeps them apart; extend it\n", u.c_str());

    const double limit = TARGET * (double)SH_HALF_M;
    struct result { int af, k; int64_t peak; double headroom; std::vector<int64_t> outliers; size_t members; };
    std::map<std::string, result> chosen;
    std::vector<int8_t> wbuf; std::vector<int> fw;
    int n_tight = 0, n_refused = 0;
    for (auto &kv : g_cap.sites) {
        const std::string &g = kv.first;
        site &s = kv.second;
        const int64_t K = s.K;
        std::vector<int64_t> order((size_t)K);
        for (int64_t k = 0; k < K; k++) order[k] = k;
        const int kmax = (int)std::min<int64_t>(K, K_CANDIDATES[N_K - 1]);
        std::stable_sort(order.begin(), order.end(), [&](int64_t a, int64_t b) { return s.cmax[a] > s.cmax[b]; });
        order.resize(kmax);

        std::vector<const std::vector<float> *> rows;
        for (auto &h : s.by_l2.heap) rows.push_back(&h.second);
        for (auto &h : s.by_linf.heap) rows.push_back(&h.second);
        for (auto &r : s.reservoir) rows.push_back(&r);
        const int64_t m = (int64_t)rows.size();
        std::vector<int32_t> xq((size_t)m * K);
        const double max_ref = std::min((double)std::numeric_limits<int32_t>::max(),
            (double)std::numeric_limits<int64_t>::max() / (127.0 * K)) - 1.0;
        for (int64_t r = 0; r < m; r++)
            for (int64_t k = 0; k < K; k++) {
                const double x = (double)(*rows[r])[k] * (double)(1 << REF_AF);
                if (!std::isfinite(x) || fabs(x) > max_ref) { fprintf(stderr, "[sd-calib] %s: activation outside the reference bound\n", g.c_str()); return 2; }
                xq[(size_t)r * K + k] = (int32_t)llrint(x);
            }

        int64_t peaks[N_K] = { 0 };
        bool ok = true;
        for (const auto &wn : s.weights) {
            const ggml_tensor *w = wn.second;
            const int64_t N = w->ne[1];
            wbuf.resize((size_t)K * N); fw.resize((size_t)N);
            if (sh_prepare_rows_any(w->data, w->type, K, N, 0, N, wbuf.data(), fw.data()) < 0) {
                fprintf(stderr, "[sd-calib] %s: no weight exponent fits the int8 lane; the backend refuses it too\n", wn.first.c_str());
                ok = false; n_refused++; break;
            }
            int64_t p[N_K];
            peak_for_weight(xq, m, K, wbuf.data(), N, order, p, threads);
            for (int ki = 0; ki < N_K; ki++) peaks[ki] = std::max(peaks[ki], p[ki]);
        }
        if (!ok) continue;

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
                else { af = REF_AF + (int)floor(log2(limit / (double)p)); af = std::max(AF_MIN, std::min(AF_MAX, af)); }
                const bool tight = af == AF_MIN && (double)p * ldexp(1.0, AF_MIN - REF_AF) > limit;
                if (best.af < 0 || af > best.af || (tight && af == best.af && p < best.peak)) { best.af = af; best.k = kk; best.peak = p; }
            }
        }
        best.headroom = (double)SH_HALF_M / std::max(1.0, (double)best.peak * ldexp(1.0, best.af - REF_AF));
        if (best.headroom < 1.0 / TARGET) {
            fprintf(stderr, "[sd-calib] %s: only %.2fx headroom at act_frac=%d with %d outliers; %s\n",
                    g.c_str(), best.headroom, best.af, best.k, omit_tight ? "OMITTED, stays in the enclave" : "kept (--keep-tight)");
            n_tight++;
            if (omit_tight) continue;
        }
        best.outliers.assign(order.begin(), order.begin() + best.k);
        std::sort(best.outliers.begin(), best.outliers.end());
        best.members = s.members.size();
        if (g_cap.verbose)
            fprintf(stderr, "[sd-calib] %-70s K=%-6lld rows=%-9lld members=%zu k=%-3d af=%-3d headroom=%.2fx\n",
                    g.c_str(), (long long)K, (long long)s.m_total, s.members.size(), best.k, best.af, best.headroom);
        std::string emit_key = g;
        if (!s.members.count(g)) {
            emit_key = *s.members.begin();
            fprintf(stderr, "[sd-calib] WARNING: %s folds to %s, absent here; emitted under its own name, members stay in the enclave\n",
                    emit_key.c_str(), g.c_str());
        }
        chosen[emit_key] = std::move(best);
    }

    FILE *f = fopen(out_path.c_str(), "w");
    if (!f) { fprintf(stderr, "[sd-calib] cannot write %s\n", out_path.c_str()); return 2; }
    fprintf(f, "# shielded-calib 2\n");
    fprintf(f, "# sd-calib: %s + %s, %zu sites, reference exponent %d\n",
            diffusion.substr(diffusion.find_last_of('/') + 1).c_str(), llm.substr(llm.find_last_of('/') + 1).c_str(),
            chosen.size(), REF_AF);
    fprintf(f, "# %d public images (sizes %s, %d steps, cfg %.1f); pass B rows per site <= %zu (top L2, top Linf, reservoir)\n",
            images, sizes_arg.c_str(), steps, cfg, 2 * g_cap.top_rows + g_cap.sample_rows);
    for (const auto &kv : chosen) {
        fprintf(f, "site %s %d %zu", kv.first.c_str(), kv.second.af, kv.second.outliers.size());
        for (int64_t o : kv.second.outliers) fprintf(f, " %lld", (long long)o);
        fprintf(f, "\n");
    }
    fclose(f);
    fprintf(stderr, "[sd-calib] wrote %s: %zu sites (%d tight omitted, %d refused, %zu matmuls not claimable)\n",
            out_path.c_str(), chosen.size(), n_tight, n_refused, g_cap.skipped.size());
    free_sd_ctx(ctx);
    return 0;
}
