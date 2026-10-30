/* sd-actsnr: per site, the SNR of Shield's activation encoding (round(x*2^af), outlier channels exact)
 * on real activations of a plain-CPU render. Observe-only host tool; shipped nowhere. */
#include "stable-diffusion.h"
#include "ggml-backend.h"
#include "ggml.h"
extern "C" {
#include "shielded-field.h"
}
#include "shielded-source-quant.h"
#include "shielded-group-key.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <sstream>
#include <fstream>
#include <string>
#include <vector>
struct cal { int af; std::set<int64_t> out; double sx = 0, se = 0; int64_t rows = 0; double pk_txt = 0, pk_img = 0; std::vector<float> img; int64_t K = 0; };
static int64_t g_img_tokens = 0;
static std::map<std::string, cal> g;
static bool claimable(const ggml_tensor *op) {
    if (op->op != GGML_OP_MUL_MAT) return false;
    const ggml_tensor *a = op->src[0], *b = op->src[1];
    if (!a || !b || b->type != GGML_TYPE_F32 || !ggml_is_contiguous(b)) return false;
    const char *nm = ggml_get_name(a);
    return nm && *nm && g.count(sh_group_key(nm));
}
static bool cb(struct ggml_tensor *t, bool ask, void *) {
    if (ask) return claimable(t);
    if (!claimable(t)) return true;
    cal &c = g[sh_group_key(ggml_get_name(t->src[0]))];
    const ggml_tensor *a = t->src[1];
    const int64_t K = a->ne[0], m = a->ne[1];
    const float *x = (const float *)a->data;
    const double s = ldexp(1.0, c.af);
    const int64_t first_img = m > g_img_tokens ? m - g_img_tokens : 0;   /* [caption rows, image rows] */
    c.K = K;
    for (int64_t r = 0; r < m; r++) {
        double pk = 0;
        for (int64_t k = 0; k < K; k++) if (!c.out.count(k)) pk = std::max(pk, (double)std::fabs(x[r * K + k]));
        if (r < first_img) c.pk_txt = std::max(c.pk_txt, pk); else c.pk_img = std::max(c.pk_img, pk);
        if (r >= first_img && c.img.size() < (size_t)(64 * K)) c.img.insert(c.img.end(), x + r * K, x + (r + 1) * K);
    }
    for (int64_t r = 0; r < m; r++)
        for (int64_t k = 0; k < K; k++) {
            const double v = x[r * K + k];
            c.sx += v * v;
            if (!c.out.count(k)) { const double q = std::nearbyint(v * s) / s; c.se += (v - q) * (v - q); }
        }
    c.rows += m;
    return true;
}
static void logcb(enum sd_log_level_t l, const char *t, void *) { if (l >= SD_LOG_WARN) fputs(t, stderr); }
int main(int argc, char **argv) {
    if (argc < 6) { fprintf(stderr, "usage: sd-actsnr CALIB DIFFUSION LLM VAE SIZE [STEPS]\n"); return 2; }
    std::ifstream f(argv[1]); std::string line;
    while (std::getline(f, line)) {
        if (line.rfind("site ", 0)) continue;
        std::istringstream is(line.substr(5)); std::string name; int af, n; is >> name >> af >> n;
        cal c; c.af = af; for (int i = 0; i < n; i++) { int64_t o; is >> o; c.out.insert(o); } g[name] = c;
    }
    g_img_tokens = (int64_t)(atoi(argv[5]) / 16) * (atoi(argv[5]) / 16);
    sd_set_log_callback(logcb, nullptr);
    sd_ctx_params_t cp; sd_ctx_params_init(&cp);
    cp.diffusion_model_path = argv[2]; cp.llm_path = argv[3]; cp.vae_path = argv[4];
    cp.n_threads = 12; cp.diffusion_flash_attn = true; cp.enable_mmap = true; cp.backend = "CPU";
    sd_ctx_t *ctx = new_sd_ctx(&cp); if (!ctx) return 2;
    sd_set_backend_eval_callback(cb, nullptr);
    sd_img_gen_params_t gp; sd_img_gen_params_init(&gp);
    gp.prompt = "A candid photo of an elderly fisherman mending a net on a wooden dock at golden hour";
    gp.width = gp.height = atoi(argv[5]); gp.seed = 3; gp.sample_params.sample_steps = argc > 6 ? atoi(argv[6]) : 4;
    gp.sample_params.guidance.txt_cfg = 1.0f; gp.sample_params.sample_method = EULER_SAMPLE_METHOD;
    sd_image_t *out = nullptr; int n = 0;
    if (!generate_image(ctx, &gp, &out, &n)) return 2;
    for (auto &kv : g) if (kv.second.rows) {
        cal &c = kv.second;
        /* image rows only: the exponent gains floor(log2(peak_all / peak_img)) bits at the same product bound */
        const double pk_all = std::max(c.pk_txt, c.pk_img);
        const int gain = c.pk_img > 0 ? (int)std::floor(std::log2(pk_all / c.pk_img)) : 0;
        const double s2 = ldexp(1.0, c.af + gain);
        double sx = 0, se = 0;
        for (size_t i = 0; i < c.img.size(); i++) {
            const int64_t k = (int64_t)(i % c.K);
            const double v = c.img[i]; sx += v * v;
            if (!c.out.count(k)) { const double q = std::nearbyint(v * s2) / s2; se += (v - q) * (v - q); }
        }
        printf("%-62s af=%-2d k=%-2zu act SNR %5.1f dB | peak txt %8.2f img %8.2f -> +%d bits, image-row SNR %5.1f dB\n", kv.first.c_str(), c.af, c.out.size(),
               10 * log10(c.sx / std::max(c.se, 1e-30)), c.pk_txt, c.pk_img, gain, 10 * log10(sx / std::max(se, 1e-30)));
    }
    return 0;
}
