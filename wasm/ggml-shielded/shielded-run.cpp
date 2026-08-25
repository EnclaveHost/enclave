/*
 * shielded-run -- drive a whole GGUF through the shielded ggml backend.
 *
 * Exists because engine builds link their backends statically, so
 * ggml_backend_load_all() short-circuits on `if (!ggml_backend_reg_count())` and
 * GGML_BACKEND_PATH is silently ignored. This loads the module explicitly, then
 * runs an ordinary llama.cpp generation on top of it.
 *
 * What it is for is the measurement, not the tokens: run it once with a worker
 * and once without (SHIELDED_PORT pointing nowhere). The completions must be
 * CHARACTER-IDENTICAL, because the offloaded path is exact -- so any difference
 * between them is an offload bug, and any difference from a plain CPU run is the
 * fixed-point encoding, which is a separate and much larger effect. Keeping those
 * two apart is the whole point; conflating them is how "the GPU is wrong" and
 * "the encoding is lossy" get mistaken for each other.
 */
#include "llama.h"
#include "ggml-backend.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include <dlfcn.h>
typedef void (*stats_fn)(uint64_t*, uint64_t*, uint64_t*, uint64_t*);
static stats_fn shielded_stats = nullptr;

int main(int argc, char **argv) {
    const char *backend = getenv("SHIELDED_SO");
    const char *model_path = argc > 1 ? argv[1] : nullptr;
    const char *prompt = argc > 2 ? argv[2] : "The capital of France is";
    int n_predict = argc > 3 ? atoi(argv[3]) : 8;
    if (!model_path) { fprintf(stderr, "usage: shielded-run <model.gguf> [prompt] [n]\n"); return 2; }

    if (backend) {
        ggml_backend_reg_t r = ggml_backend_load(backend);
        fprintf(stderr, "[run] shielded backend: %s\n", r ? "loaded" : "FAILED TO LOAD");
        if (!r) return 2;
        /* The counters live in the module ggml dlopened, so reach them the
         * same way rather than linking against it. */
        void *h = dlopen(backend, RTLD_NOW | RTLD_NOLOAD);
        if (!h) h = dlopen(backend, RTLD_NOW);
        shielded_stats = h ? (stats_fn)dlsym(h, "ggml_backend_shielded_stats") : nullptr;
        fprintf(stderr, "[run] stats symbol: %s\n", shielded_stats ? "resolved" : "NOT RESOLVED");
    }
    llama_backend_init();
    for (size_t i = 0; i < ggml_backend_dev_count(); i++)
        fprintf(stderr, "[run] device %zu: %s\n", i, ggml_backend_dev_name(ggml_backend_dev_get(i)));

    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = 0;                       /* no in-enclave card; ACCEL is separate */
    llama_model *model = llama_model_load_from_file(model_path, mp);
    if (!model) { fprintf(stderr, "model load failed\n"); return 2; }
    const llama_vocab *vocab = llama_model_get_vocab(model);

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = 512; cp.n_batch = 512; cp.n_threads = 8; cp.n_threads_batch = 8;
    llama_context *ctx = llama_init_from_model(model, cp);
    if (!ctx) { fprintf(stderr, "ctx failed\n"); return 2; }

    std::vector<llama_token> toks(256);
    int n = llama_tokenize(vocab, prompt, (int)strlen(prompt), toks.data(), (int)toks.size(), true, false);
    if (n < 0) { fprintf(stderr, "tokenize failed\n"); return 2; }
    toks.resize(n);
    fprintf(stderr, "[run] %d prompt tokens\n", n);

    llama_batch batch = llama_batch_get_one(toks.data(), n);
    if (llama_decode(ctx, batch)) { fprintf(stderr, "decode(prompt) failed\n"); return 2; }

    std::string out;
    llama_token cur = 0;
    for (int i = 0; i < n_predict; i++) {
        const float *logits = llama_get_logits_ith(ctx, -1);
        const int n_vocab = llama_vocab_n_tokens(vocab);
        int best = 0; float bv = logits[0];
        for (int t = 1; t < n_vocab; t++) if (logits[t] > bv) { bv = logits[t]; best = t; }
        cur = best;
        if (llama_vocab_is_eog(vocab, cur)) break;
        char buf[256];
        int L = llama_token_to_piece(vocab, cur, buf, sizeof buf, 0, false);
        if (L > 0) out.append(buf, L);
        llama_batch b1 = llama_batch_get_one(&cur, 1);
        if (llama_decode(ctx, b1)) { fprintf(stderr, "decode failed at %d\n", i); break; }
    }

    uint64_t off = 0, loc = 0, macs = 0, vf = 0;
    if (shielded_stats) shielded_stats(&off, &loc, &macs, &vf);
    printf("\n=== shielded ===\n");
    printf("prompt      : %s\n", prompt);
    printf("completion  : %s\n", out.c_str());
    printf("offloaded   : %llu nodes\n", (unsigned long long)off);
    printf("local       : %llu nodes\n", (unsigned long long)loc);
    printf("GMAC        : %.2f\n", (double)macs / 1e9);
    printf("verify fail : %llu\n", (unsigned long long)vf);
    llama_free(ctx); llama_model_free(model);
    return vf == 0 ? 0 : 1;
}
