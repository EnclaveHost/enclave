/* tpu-host-test.cpp -- the Shielded-TPU backend against the exact reference worker, on the workstation.
 *   tpu-host-test <model.gguf> <lanes.etpu|-> "<user message>" <n_predict> [bank_positions]
 * "-" as the bundle = plain llama.cpp (the baseline text). With a bundle: every claimed matmul crosses a socketpair as masked
 * int16 rows to ggml_backend_tpu_reference_worker (the arithmetic the TPU must perform). Greedy, so the two texts compare. */
#include "llama.h"
#include "ggml-backend.h"
#include "anchor_plain_buft.h"
#include "ggml-tpu.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <sys/socket.h>
#include <thread>
#include <vector>
int main(int argc, char **argv) {
    if (argc < 5) { fprintf(stderr, "usage\n"); return 2; }
    const bool tpu = strcmp(argv[2], "-") != 0; const int n_predict = atoi(argv[4]); const int bank = argc > 5 ? atoi(argv[5]) : 0;
    ggml_backend_load_all(); llama_backend_init();
    std::thread worker; int sp[2] = {-1, -1};
    if (tpu) {
        if (ggml_backend_tpu_open_bundle(argv[2]) != 0) return 2;
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, sp) != 0) return 2;
        worker = std::thread([&] { ggml_backend_tpu_reference_worker(sp[1]); });
        ggml_backend_tpu_set_link(sp[0], 5);
        ggml_backend_register(ggml_backend_tpu_reg());
        if (bank > 0) fprintf(stderr, "minted %d positions per group in %.1f s\n", bank, ggml_backend_tpu_mint(bank, 16));
    }
    llama_model_params mp = llama_model_default_params(); mp.n_gpu_layers = 0;
    static llama_model_tensor_buft_override ov[2] = { { ANCHOR_TPU_CLAIM_PATTERN, nullptr }, { nullptr, nullptr } };
    if (tpu) { ov[0].buft = anchor_plain_buft(); mp.tensor_buft_overrides = ov; }
    llama_model *model = llama_model_load_from_file(argv[1], mp); if (!model) return 2;
    const llama_vocab *vocab = llama_model_get_vocab(model);
    llama_context_params cp = llama_context_default_params(); cp.n_ctx = 2048; cp.n_batch = 512; cp.n_threads = 16; cp.n_threads_batch = 16;
    llama_context *ctx = llama_init_from_model(model, cp); if (!ctx) return 2;
    std::string text = std::string("<|turn>user\n") + argv[3] + "<turn|>\n<|turn>model\n";
    std::vector<llama_token> toks(text.size() + 16); int n = llama_tokenize(vocab, text.c_str(), (int)text.size(), toks.data(), (int)toks.size(), true, true); toks.resize(n);
    if (llama_decode(ctx, llama_batch_get_one(toks.data(), n))) return 2;
    llama_sampler *smpl = llama_sampler_chain_init(llama_sampler_chain_default_params()); llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
    std::string out; const int64_t t0 = ggml_time_us(); int gen = 0;
    for (; gen < n_predict; gen++) {
        llama_token tok = llama_sampler_sample(smpl, ctx, -1); if (llama_vocab_is_eog(vocab, tok)) break;
        char piece[256]; int pn = llama_token_to_piece(vocab, tok, piece, sizeof piece, 0, false); if (pn > 0) out.append(piece, pn);
        if (llama_decode(ctx, llama_batch_get_one(&tok, 1))) return 2;
    }
    const double sec = (ggml_time_us() - t0) / 1e6;
    printf("TEXT %s\n", out.c_str()); printf("DECODE %d tokens %.2f tok/s (prompt %d tokens)\n", gen, gen / sec, n);
    if (tpu) { ggml_backend_tpu_stats_t st; ggml_backend_tpu_get_stats(&st, 0);
        printf("TPU exchanges=%llu (%.1f per token) rows=%llu out=%.1f KB/token in=%.1f KB/token mask=%.2f ms link=%.2f ms unmask=%.2f ms per exchange; outliers kept in the VM=%llu (%.4f%% of entries) saturated=%llu inline pads=%llu redrawn=%llu bank_min=%llu\n",
               (unsigned long long)st.exchanges, (double)st.exchanges / (gen ? gen : 1), (unsigned long long)st.rows, st.bytes_out / 1024.0 / (gen ? gen : 1), st.bytes_in / 1024.0 / (gen ? gen : 1),
               st.mask_us / 1e3 / st.exchanges, st.link_us / 1e3 / st.exchanges, st.unmask_us / 1e3 / st.exchanges, (unsigned long long)st.outlier_entries, 100.0 * st.outlier_entries / (st.bytes_out / 2.0 + 1),
               (unsigned long long)st.saturated, (unsigned long long)st.pads_minted_inline, (unsigned long long)st.pads_redrawn, (unsigned long long)st.bank_min);
        shutdown(sp[0], SHUT_RDWR); worker.join(); }
    return 0;
}
