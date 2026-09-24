// build_conv integration: the REAL llama graph path, CPU backend, a small model
// of the same hybrid architecture (delta-net conv + attention). Run it twice,
// ENCLAVE_GGML_CONV_INPLACE=1 and =0 (the switch is read once per process);
// each run writes every step's logits to one file, and the two files must be
// byte-identical. Scenarios:
//
//   plain     one sequence, no rollback snapshots: prefill, 24 greedy steps
//             (the identity gather: the fused op's path)
//   spec      one sequence, n_rs_seq = 1 as the speculative bench uses it:
//             2-token "verify" batches, rollbacks of 1 via seq_rm, resumes,
//             single-token steps (rollback reads a snapshot: the fallback path)
//   multi     three sequences: batches carrying all three, and batches
//             carrying one of them (memory wider than one cell: fallback)
//   lifetime  memory cleared and the context reused; a full seq_rm and a
//             re-prefill; alternating ubatch sizes so graph reuse runs across
//             the state changes
//
//   conv-graph-test MODEL.gguf OUT.bin [SCENARIO]   (plain|spec|multi|lifetime; default all)
//
// multi aborts (GGML_ASSERT(ggml_can_repeat) in ggml_mul, from qwen35
// build_layer_attn) with or without the fused op, on the fork AND on the official
// llamacpp-toolchain tree: the first 2-8 token single-sequence decode enters
// ensure_slot_alt (llamacpp-graph-slot.patch), which reserves with n_seqs = 1
// against a memory context sized for n_seq_max. LLAMA_GRAPH_SLOT_ALT=0 makes it
// complete (shielded/WRAPUP-27B-INTEGRATION.md). It runs only when named.
#include "llama.h"
#include "ggml-backend.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

static FILE * out;
static int steps;
static long long bytes_written, rows_dumped;

static void dump(llama_context * ctx, int n_logits_rows, int n_vocab, const char * tag) {
    for (int i = 0; i < n_logits_rows; i++) {
        const float * lg = llama_get_logits_ith(ctx, i);
        if (!lg) { fprintf(stderr, "%s: no logits for row %d\n", tag, i); exit(3); }
        if (fwrite(lg, sizeof(float), (size_t) n_vocab, out) != (size_t) n_vocab) {
            fprintf(stderr, "%s: short write of the logit dump\n", tag); exit(4);
        }
        bytes_written += (long long) n_vocab * (long long) sizeof(float);
        rows_dumped++;
    }
    steps++;
}

static int argmax(const float * lg, int n) { int b = 0; for (int i = 1; i < n; i++) if (lg[i] > lg[b]) b = i; return b; }

// decode tokens for one sequence starting at pos, all rows produce logits
static void decode_seq(llama_context * ctx, llama_seq_id seq, llama_pos pos, const std::vector<llama_token> & toks,
                       int n_vocab, const char * tag) {
    llama_batch b = llama_batch_init((int) toks.size(), 0, 1);
    for (size_t i = 0; i < toks.size(); i++) {
        b.token[i] = toks[i]; b.pos[i] = pos + (llama_pos) i; b.n_seq_id[i] = 1; b.seq_id[i][0] = seq; b.logits[i] = 1;
    }
    b.n_tokens = (int) toks.size();
    if (llama_decode(ctx, b) != 0) { fprintf(stderr, "%s: decode failed\n", tag); exit(2); }
    dump(ctx, b.n_tokens, n_vocab, tag);
    llama_batch_free(b);
}

static std::vector<llama_token> tokenize(const llama_vocab * v, const std::string & s) {
    std::vector<llama_token> t(s.size() + 16);
    const int n = llama_tokenize(v, s.c_str(), (int) s.size(), t.data(), (int) t.size(), true, true);
    t.resize(n > 0 ? n : 0);
    return t;
}

static llama_context * make_ctx(llama_model * m, uint32_t n_seq_max, uint32_t n_rs_seq) {
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = 512; cp.n_batch = 512; cp.n_ubatch = 512;
    cp.n_seq_max = n_seq_max; cp.n_rs_seq = n_rs_seq;
    // CONV_TEST_KV_UNIFIED=1: one KV stream for all sequences (as the engine's
    // server contexts use); otherwise llama's default, one stream per sequence
    { const char * u = getenv("CONV_TEST_KV_UNIFIED"); if (u && u[0] == '1') cp.kv_unified = true; }
    cp.n_threads = 8; cp.n_threads_batch = 8;
    llama_context * c = llama_init_from_model(m, cp);
    if (!c) { fprintf(stderr, "context failed\n"); exit(2); }
    return c;
}

int main(int argc, char ** argv) {
    if (argc < 3) { fprintf(stderr, "usage: conv-graph-test MODEL OUT\n"); return 2; }
    const std::string only = argc > 3 ? argv[3] : "";
    if (!only.empty() && only != "plain" && only != "spec" && only != "multi" && only != "lifetime") {
        fprintf(stderr, "unknown scenario '%s' (plain|spec|multi|lifetime)\n", only.c_str()); return 2;
    }
    out = fopen(argv[2], "wb");
    if (!out) { fprintf(stderr, "cannot open output %s\n", argv[2]); return 2; }
    auto want = [&](const char * s) { return only.empty() ? strcmp(s, "multi") != 0 : only == s; };
    llama_backend_init();
    // a GGML_BACKEND_DL build: load exactly the CPU backend from the tree under test
    const char * cpu = getenv("CONV_TEST_CPU_BACKEND");
    if (!cpu || !ggml_backend_load(cpu)) { fprintf(stderr, "set CONV_TEST_CPU_BACKEND to the tree's libggml-cpu.so\n"); return 2; }
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = 0;
    llama_model * model = llama_model_load_from_file(argv[1], mp);
    if (!model) { fprintf(stderr, "model failed\n"); return 2; }
    const llama_vocab * vocab = llama_model_get_vocab(model);
    const int n_vocab = llama_vocab_n_tokens(vocab);
    const std::vector<llama_token> p1 = tokenize(vocab, "Explain in one paragraph why the sky is blue.");
    const std::vector<llama_token> p2 = tokenize(vocab, "List three prime numbers and say why each is prime.");
    const std::vector<llama_token> p3 = tokenize(vocab, "def fib(n):");

    if (want("plain")) {
    fprintf(stderr, "[conv-graph-test] scenario: plain\n");
    {   // plain
        llama_context * ctx = make_ctx(model, 1, 0);
        decode_seq(ctx, 0, 0, p1, n_vocab, "plain-prefill");
        llama_pos pos = (llama_pos) p1.size();
        llama_token t = argmax(llama_get_logits_ith(ctx, (int) p1.size() - 1), n_vocab);
        for (int i = 0; i < 24; i++) { decode_seq(ctx, 0, pos++, {t}, n_vocab, "plain-step"); t = argmax(llama_get_logits_ith(ctx, 0), n_vocab); }
        llama_free(ctx);
    }
    }
    if (want("spec")) {
    fprintf(stderr, "[conv-graph-test] scenario: spec\n");
    {   // spec: verify batches of 2, rollback 1 on alternate rounds, resume
        llama_context * ctx = make_ctx(model, 1, 1);
        decode_seq(ctx, 0, 0, p1, n_vocab, "spec-prefill");
        llama_pos pos = (llama_pos) p1.size();
        llama_token t = argmax(llama_get_logits_ith(ctx, (int) p1.size() - 1), n_vocab);
        for (int r = 0; r < 12; r++) {
            const llama_token guess = (llama_token) ((t * 7 + r) % n_vocab);        // a draft that is usually wrong
            decode_seq(ctx, 0, pos, {t, guess}, n_vocab, "spec-verify");
            const llama_token t1 = argmax(llama_get_logits_ith(ctx, 0), n_vocab);
            if (r % 2 == 0 || t1 != guess) {
                // reject the draft: drop its position, resume from t1
                if (!llama_memory_seq_rm(llama_get_memory(ctx), 0, pos + 1, -1)) { fprintf(stderr, "rollback refused\n"); return 2; }
                pos += 1; t = t1;
                decode_seq(ctx, 0, pos++, {t}, n_vocab, "spec-resume");
                t = argmax(llama_get_logits_ith(ctx, 0), n_vocab);
            } else {
                pos += 2; t = argmax(llama_get_logits_ith(ctx, 1), n_vocab);
            }
        }
        llama_free(ctx);
    }
    }
    if (want("multi")) {
    fprintf(stderr, "[conv-graph-test] scenario: multi\n");
    {   // multi: three sequences
        llama_context * ctx = make_ctx(model, 3, 0);
        const std::vector<llama_token> * ps[3] = {&p1, &p2, &p3};
        llama_pos pos[3];
        llama_token t[3];
        for (int s = 0; s < 3; s++) {
            decode_seq(ctx, s, 0, *ps[s], n_vocab, "multi-prefill");
            pos[s] = (llama_pos) ps[s]->size();
            t[s] = argmax(llama_get_logits_ith(ctx, (int) ps[s]->size() - 1), n_vocab);
        }
        for (int i = 0; i < 8; i++) {
            if (i % 3 == 2) {   // one sequence alone, in a memory three cells wide
                const int s = i % 3;
                decode_seq(ctx, s, pos[s]++, {t[s]}, n_vocab, "multi-single");
                t[s] = argmax(llama_get_logits_ith(ctx, 0), n_vocab);
                continue;
            }
            llama_batch b = llama_batch_init(3, 0, 1);
            for (int s = 0; s < 3; s++) { b.token[s] = t[s]; b.pos[s] = pos[s]++; b.n_seq_id[s] = 1; b.seq_id[s][0] = s; b.logits[s] = 1; }
            b.n_tokens = 3;
            if (llama_decode(ctx, b) != 0) { fprintf(stderr, "multi decode failed\n"); return 2; }
            dump(ctx, 3, n_vocab, "multi-all");
            for (int s = 0; s < 3; s++) t[s] = argmax(llama_get_logits_ith(ctx, s), n_vocab);
            llama_batch_free(b);
        }
        llama_free(ctx);
    }
    }
    if (want("lifetime")) {
    fprintf(stderr, "[conv-graph-test] scenario: lifetime\n");
    {   // lifetime: clear and reuse; full seq_rm and re-prefill; alternating ubatch sizes
        llama_context * ctx = make_ctx(model, 1, 1);
        for (int round = 0; round < 3; round++) {
            if (round == 1) llama_memory_clear(llama_get_memory(ctx), true);
            if (round == 2) llama_memory_seq_rm(llama_get_memory(ctx), 0, -1, -1);
            decode_seq(ctx, 0, 0, round == 1 ? p2 : p1, n_vocab, "life-prefill");
            llama_pos pos = (llama_pos) (round == 1 ? p2 : p1).size();
            llama_token t = argmax(llama_get_logits_ith(ctx, (int) (round == 1 ? p2 : p1).size() - 1), n_vocab);
            for (int i = 0; i < 6; i++) {
                if (i % 2) { decode_seq(ctx, 0, pos, {t, t}, n_vocab, "life-2"); pos += 2; t = argmax(llama_get_logits_ith(ctx, 1), n_vocab); }
                else { decode_seq(ctx, 0, pos++, {t}, n_vocab, "life-1"); t = argmax(llama_get_logits_ith(ctx, 0), n_vocab); }
            }
        }
        llama_free(ctx);
    }
    }
    if (fflush(out) != 0 || ferror(out) || fclose(out) != 0) { fprintf(stderr, "the logit dump did not close cleanly\n"); return 4; }
    // zero executed scenarios, or a dump that does not account for every row, is a failure
    if (steps <= 0 || rows_dumped <= 0 || bytes_written != rows_dumped * (long long) n_vocab * (long long) sizeof(float)) {
        fprintf(stderr, "incomplete run: steps=%d rows=%lld bytes=%lld\n", steps, rows_dumped, bytes_written); return 5;
    }
    printf("steps=%d rows=%lld bytes=%lld n_vocab=%d\n", steps, rows_dumped, bytes_written, n_vocab);
    llama_model_free(model);
    return 0;
}
