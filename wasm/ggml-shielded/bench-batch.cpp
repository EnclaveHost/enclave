/* bench-batch -- the cost of a decode step that carries m rows.
 *
 * Every decode step is a full pass over the weights; on the shielded tier it
 * is ~49 masked exchanges (gate|up, down, lm_head). One exchange serves every
 * row in the batch, so the two ways to amortise it are the same measurement:
 * a speculative VERIFY pass of k = m-1 drafts, and m concurrent users batched
 * into one step, both submit m tokens to ONE llama_decode. This tool measures
 * exactly that: after a real prompt, n steps of m consecutive positions on one
 * sequence, logits requested for every row (a verify pass reads them all),
 * and reports ms per step and the tok/s-equivalent m / step.
 *
 * Same conventions as bench-run so the rows line up: BACKENDS (colon list of
 * module paths), N_GPU_LAYERS, THREADS, LABEL, one JSON line on stdout. The
 * tokens fed are a real greedy continuation recorded first (m = 1), then
 * replayed m at a time from the prompt boundary, so the KV holds plausible
 * text; the text itself is irrelevant, the COST per step is what is measured.
 * The shielded backend keeps m <= SHIELDED_MAX_M (8) on the card by policy;
 * wider batches stay in the enclave, which is why the sweep stops at 8.
 */
#include "llama.h"
#include "ggml-backend.h"
#include "ggml.h"
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <dlfcn.h>

static int env_int(const char *k, int d) { const char *v = getenv(k); return v ? atoi(v) : d; }

int main(int argc, char **argv) {
    const char *model_path = argc > 1 ? argv[1] : nullptr;
    const char *prompt     = argc > 2 ? argv[2] : "Explain in one paragraph why the sky is blue.";
    const int   n_steps    = argc > 3 ? atoi(argv[3]) : 64;
    if (!model_path) { fprintf(stderr, "usage: bench-batch <model.gguf> [prompt] [n_steps]   (env M=1..8)\n"); return 2; }
    const int m = env_int("M", 1);
    if (m < 1 || m > 64) { fprintf(stderr, "M out of range\n"); return 2; }
    const int n_rec = env_int("N_RECORD", 64); /* greedy tokens recorded, cycled */

    if (const char *list = getenv("BACKENDS")) {
        std::string s(list);
        size_t p = 0;
        while (p <= s.size()) {
            size_t c = s.find(':', p);
            std::string one = s.substr(p, c == std::string::npos ? std::string::npos : c - p);
            if (!one.empty())
                fprintf(stderr, "[bench] backend %s: %s\n", one.c_str(),
                        ggml_backend_load(one.c_str()) ? "loaded" : "FAILED");
            if (c == std::string::npos) break;
            p = c + 1;
        }
    }
    llama_backend_init();
    for (size_t i = 0; i < ggml_backend_dev_count(); i++)
        fprintf(stderr, "[bench] device %zu: %s\n", i, ggml_backend_dev_name(ggml_backend_dev_get(i)));

    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = env_int("N_GPU_LAYERS", 0);
    llama_model *model = llama_model_load_from_file(model_path, mp);
    if (!model) { fprintf(stderr, "model load failed\n"); return 2; }
    const llama_vocab *vocab = llama_model_get_vocab(model);
    const int nv = llama_vocab_n_tokens(vocab);

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = 1024; cp.n_batch = 1024;
    cp.n_threads = cp.n_threads_batch = env_int("THREADS", 8);
    llama_context *ctx = llama_init_from_model(model, cp);
    if (!ctx) { fprintf(stderr, "ctx failed\n"); return 2; }

    std::vector<llama_token> toks(512);
    int n = llama_tokenize(vocab, prompt, (int)strlen(prompt), toks.data(), (int)toks.size(), true, false);
    if (n < 0) { fprintf(stderr, "tokenize failed\n"); return 2; }
    toks.resize(n);

    auto argmax = [&](const float *lg) { int b = 0; for (int t = 1; t < nv; t++) if (lg[t] > lg[b]) b = t; return b; };

    /* 1. prompt, then record a real greedy continuation (m = 1) */
    if (llama_decode(ctx, llama_batch_get_one(toks.data(), n))) { fprintf(stderr, "decode(prompt) failed\n"); return 2; }
    std::vector<llama_token> rec;
    {
        int t = argmax(llama_get_logits_ith(ctx, -1));
        for (int i = 0; i < n_rec; i++) {
            rec.push_back(t);
            if (llama_decode(ctx, llama_batch_get_one(&t, 1))) { fprintf(stderr, "record decode failed\n"); return 2; }
            t = argmax(llama_get_logits_ith(ctx, -1));
            if (llama_vocab_is_eog(vocab, t)) t = rec[0]; /* keep the stream flowing */
        }
    }
    /* 2. back to the prompt boundary; the m-wide steps start there */
    llama_memory_seq_rm(llama_get_memory(ctx), 0, n, -1);

    llama_batch batch = llama_batch_init(m, 0, 1);
    auto step = [&](int pos0, int idx) -> int {
        for (int j = 0; j < m; j++) {
            batch.token[j]     = rec[(size_t)(idx * m + j) % rec.size()];
            batch.pos[j]       = pos0 + j;
            batch.n_seq_id[j]  = 1;
            batch.seq_id[j][0] = 0;
            batch.logits[j]    = 1; /* a verify pass reads every row */
        }
        batch.n_tokens = m;
        return llama_decode(ctx, batch);
    };

    /* one uncounted warm step (graph build / shielded first-touch), then n */
    int pos = n;
    if (step(pos, 0)) { fprintf(stderr, "warm step failed\n"); return 2; }
    pos += m;
    std::vector<double> ms; ms.reserve(n_steps);
    const int64_t t0 = ggml_time_us();
    int done = 0;
    for (int i = 0; i < n_steps; i++) {
        if (pos + m > (int)cp.n_ctx - 1) break;
        const int64_t a = ggml_time_us();
        if (step(pos, i + 1)) { fprintf(stderr, "step %d failed\n", i); break; }
        /* a device backend runs llama_decode asynchronously (it returned in
         * 0.04 ms on CUDA before this); the step ends when its logits are
         * readable on the host, which is what a verify pass waits for */
        llama_synchronize(ctx);
        volatile float sink = llama_get_logits_ith(ctx, m - 1)[0]; (void)sink;
        ms.push_back((ggml_time_us() - a) / 1e3);
        pos += m; done++;
    }
    const int64_t t1 = ggml_time_us();
    std::vector<double> sorted(ms); std::sort(sorted.begin(), sorted.end());
    const double med = sorted.empty() ? 0 : sorted[sorted.size() / 2];
    const double mean = done ? (t1 - t0) / 1e3 / done : 0;

    printf("{\"label\":\"%s\",\"m\":%d,\"prompt_tokens\":%d,\"steps\":%d,"
           "\"step_ms_mean\":%.3f,\"step_ms_median\":%.3f,\"step_ms_min\":%.3f,"
           "\"tok_s_equiv\":%.2f,\"tok_s_equiv_median\":%.2f}\n",
           getenv("LABEL") ? getenv("LABEL") : "?", m, n, done,
           mean, med, sorted.empty() ? 0 : sorted[0],
           mean > 0 ? m * 1e3 / mean : 0, med > 0 ? m * 1e3 / med : 0);
    fflush(stdout); /* the result must survive a teardown crash below (seen: shielded m>=2, exit 139 after the stats line) */
    if (const char *sh = getenv("SHIELDED_SO_FOR_STATS")) {
        void *h = dlopen(sh, RTLD_NOW | RTLD_NOLOAD);
        if (h) {
            typedef void (*stats_fn)(uint64_t*, uint64_t*, uint64_t*, uint64_t*);
            stats_fn f = (stats_fn)dlsym(h, "ggml_backend_shielded_stats");
            uint64_t off=0, loc=0, macs=0, vf=0;
            if (f) { f(&off,&loc,&macs,&vf);
                fprintf(stderr, "[bench] shielded: offloaded=%llu local=%llu GMAC=%.2f verify_fail=%llu\n",
                        (unsigned long long)off,(unsigned long long)loc,(double)macs/1e9,(unsigned long long)vf); }
        }
    }
    llama_batch_free(batch);
    llama_free(ctx); llama_model_free(model);
    return 0;
}
