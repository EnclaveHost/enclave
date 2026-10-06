// KV runs numerics: build a fragmented unified pool (two other sequences' cells between the probe sequence's shared
// prefix and its own tail), then decode 2-token steps on the probe sequence and dump every logit row. Run once with
// ENCLAVE_GGML_KV_RUNS=0 and once with 1 and compare the dumps.   usage: kvruns-check MODEL OUT.bin
#include "llama.h"
#include "ggml-backend.h"
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <chrono>
static void decode(llama_context * ctx, llama_seq_id seq, int pos0, const std::vector<llama_token> & toks, bool logits_all) {
    const int nb = 64;
    for (size_t i = 0; i < toks.size(); i += nb) {
        const int n = (int) std::min<size_t>(nb, toks.size() - i);
        llama_batch b = llama_batch_init(n, 0, 1);
        for (int j = 0; j < n; ++j) {
            b.token[j] = toks[i + j]; b.pos[j] = pos0 + (int) i + j; b.n_seq_id[j] = 1; b.seq_id[j][0] = seq;
            b.logits[j] = logits_all || (i + j + 1 == toks.size());
        }
        b.n_tokens = n;
        if (llama_decode(ctx, b) != 0) { fprintf(stderr, "decode failed\n"); exit(1); }
        llama_batch_free(b);
    }
}
int main(int argc, char ** argv) {
    ggml_backend_load_all_from_path("/home/steven/Projects/enclave-runtime-park/rig/backends");
    llama_backend_init();
    auto mp = llama_model_default_params();
    llama_model * model = llama_model_load_from_file(argv[1], mp);
    auto cp = llama_context_default_params();
    cp.n_ctx = 65536; cp.n_batch = 64; cp.n_ubatch = 64; cp.n_seq_max = 4; cp.kv_unified = true;
    cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED; cp.n_threads = 8; cp.n_threads_batch = 8;
    llama_context * ctx = llama_init_from_model(model, cp);
    const int n_vocab = llama_vocab_n_tokens(llama_model_get_vocab(model));
    unsigned s = 12345; auto rnd = [&] { s = s * 1103515245u + 12345u; return (llama_token) (1000 + (s >> 8) % 50000); };
    const int n_o2 = getenv("O2") ? atoi(getenv("O2")) : 9000;
    const int n_o1 = getenv("O1") ? atoi(getenv("O1")) : 9000, n_tail = getenv("TAIL") ? atoi(getenv("TAIL")) : 700;
    std::vector<llama_token> pre(1500), o1(n_o1), o2(9000), tail(n_tail);
    for (auto & t : pre) t = rnd(); for (auto & t : o1) t = rnd(); for (auto & t : o2) t = rnd(); for (auto & t : tail) t = rnd();
    decode(ctx, 1, 0, pre, false);                         // shared prefix: cells [0, 1500)
    decode(ctx, 1, 1500, o1, false);                       // other conversation: cells above it
    o2.resize(n_o2);
    if (n_o2) decode(ctx, 2, 0, o2, false);                // a third one above that
    llama_memory_t mem = llama_get_memory(ctx);
    llama_memory_seq_cp(mem, 1, 0, 0, 1500);               // probe sequence borrows the prefix cells
    decode(ctx, 0, 1500, tail, false);                     // and its own tail lands above both others
    FILE * f = fopen(argv[2], "wb");
    std::vector<llama_token> step(2);
    double ms = 0;
    int pos = 1500 + n_tail;
    for (int k = 0; k < 24; ++k) {                         // decode-shaped 2-token steps
        step[0] = rnd(); step[1] = rnd();
        auto t0 = std::chrono::steady_clock::now();
        decode(ctx, 0, pos, step, true);
        ms += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        pos += 2;
        for (int j = 0; j < 2; ++j) fwrite(llama_get_logits_ith(ctx, j), sizeof(float), n_vocab, f);
    }
    // two sequences in one batch, the way the runtime batches concurrent sessions' decode steps
    for (int k = 0; k < 8 && n_o2; ++k) {
        llama_batch b = llama_batch_init(4, 0, 1);
        const int ps[4] = {pos, pos + 1, n_o2 + 2*k, n_o2 + 2*k + 1};
        const llama_seq_id ss[4] = {0, 0, 2, 2};
        for (int j = 0; j < 4; ++j) { b.token[j] = rnd(); b.pos[j] = ps[j]; b.n_seq_id[j] = 1; b.seq_id[j][0] = ss[j]; b.logits[j] = 1; }
        b.n_tokens = 4;
        if (llama_decode(ctx, b) != 0) { fprintf(stderr, "batch decode failed\n"); exit(1); }
        llama_batch_free(b);
        pos += 2;
        for (int j = 0; j < 4; ++j) fwrite(llama_get_logits_ith(ctx, j), sizeof(float), n_vocab, f);
    }
    fclose(f);
    fprintf(stderr, "steps 24, %.2f ms/step\n", ms / 24);
    llama_free(ctx); llama_model_free(model);
    return 0;
}
