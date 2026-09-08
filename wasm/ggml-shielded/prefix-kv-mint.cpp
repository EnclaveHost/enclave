/* prefix-kv-mint: the platform's shared-prefix service, offline.
 *
 *   GGML_CPU_SO=libggml-cpu.so prefix-kv-mint model.gguf --prefix-file P --out kv.bin \
 *       --calib model.calib --key <Ed25519 sk, 128 hex, or a file holding "sk <hex>">
 *
 * Prefills the prefix in the clear (it is public), saves the sequence state
 * with llama_state_seq_save_file, and signs the sidecar (prefix-kv.h). Prints
 * the public key a consumer pins (SHIELDED_PREFIX_KV_PK). No shielded backend
 * is loaded: nothing here is private. */
#include "llama.h"
#include "ggml-backend.h"
#include "prefix-kv.h"
#include "shielded-pads.h"
#include "shielded-sha256.h"
extern "C" {
#include "tweetnacl.h"
}
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <climits>
#ifdef SH_PREFIX_WITH_MTP
#include "anchor_mtp.h"
#include "prefix-mtp.h"
#include <unistd.h>
#include <sys/stat.h>
#endif

static bool read_file(const char *path, std::string &out) {
    FILE *f = fopen(path, "rb"); if (!f) return false;
    char buf[65536]; size_t n;
    while ((n = fread(buf, 1, sizeof buf, f)) > 0) out.append(buf, n);
    const bool ok = !ferror(f); fclose(f); return ok;
}
static bool calibration_digest(const char *path, uint8_t out[32]) {
    std::string s; if (!read_file(path, s)) return false;
    uint8_t h[64]; crypto_hash(h, (const uint8_t *)s.data(), s.size()); memcpy(out, h, 32); return true;
}

int main(int argc, char **argv) {
    const char *model_path = argc > 1 ? argv[1] : nullptr, *prefix_file = nullptr, *out = nullptr, *calib = nullptr, *key = nullptr;
    int threads = 8, want_mtp = 0;
    if (argc > 1 && argc % 2) { fprintf(stderr, "options require values\n"); return 2; }
    for (int i = 2; i + 1 < argc; i += 2) {
        if (!strcmp(argv[i], "--prefix-file")) prefix_file = argv[i + 1];
        else if (!strcmp(argv[i], "--out")) out = argv[i + 1];
        else if (!strcmp(argv[i], "--calib")) calib = argv[i + 1];
        else if (!strcmp(argv[i], "--key")) key = argv[i + 1];
        else if (!strcmp(argv[i], "--threads")) threads = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--mtp")) {
            if (strcmp(argv[i + 1], "0") && strcmp(argv[i + 1], "1")) { fprintf(stderr, "--mtp must be 0 or 1\n"); return 2; }
            want_mtp = argv[i + 1][0] == '1';
        }
        else { fprintf(stderr, "unknown option %s\n", argv[i]); return 2; }
    }
    if (!model_path || !prefix_file || !out || !calib || !key) {
        fprintf(stderr, "usage: GGML_CPU_SO=.. prefix-kv-mint model.gguf --prefix-file P --out kv --calib C --key <sk hex | file> [--threads N] [--mtp 0|1]\n");
        return 2;
    }
    if (threads <= 0 || threads > 256) { fprintf(stderr, "--threads must be 1..256\n"); return 2; }
#ifndef SH_PREFIX_WITH_MTP
    if (want_mtp) { fprintf(stderr, "MTP producer needs build-prefix-mtp.sh; this build supports target state only\n"); return 2; }
#endif
    std::string prefix; if (!read_file(prefix_file, prefix)) { fprintf(stderr, "cannot read %s\n", prefix_file); return 2; }
    if (prefix.empty() || prefix.size() > INT_MAX - 512) { fprintf(stderr, "prefix text is empty or too large\n"); return 2; }
    uint8_t digest[32], model_digest[32]; uint64_t model_bytes = 0;
    if (!calibration_digest(calib, digest)) { fprintf(stderr, "cannot read calib %s\n", calib); return 2; }
    /* The publisher runs on trusted storage with an immutable input model.
     * Compute its full identity; a calibration label is not a model hash. */
    if (sh_sha256_file(model_path, model_digest, &model_bytes) || !model_bytes) { fprintf(stderr, "cannot hash model %s\n", model_path); return 2; }
    uint8_t sk[64];
    {
        std::string k = key;
        if (k.size() != 128) { std::string s; if (!read_file(key, s)) { fprintf(stderr, "cannot read key %s\n", key); return 2; }
            const size_t at = s.find("sk "); if (at == std::string::npos || s.size() < at + 3 + 128) { fprintf(stderr, "key file needs an 'sk <128 hex>' line\n"); return 2; }
            k = s.substr(at + 3, 128); }
        if (!sh_pads_hex2bin(k.c_str(), sk, 64)) { fprintf(stderr, "bad key hex\n"); return 2; }
    }
    if (const char *cpu_so = getenv("GGML_CPU_SO")) { if (!ggml_backend_load(cpu_so)) { fprintf(stderr, "cpu backend failed to load\n"); return 2; } }
    llama_backend_init();
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = 0;
    if (want_mtp) mp.load_mtp = true;
    llama_model *model = llama_model_load_from_file(model_path, mp);
    if (!model) { fprintf(stderr, "model load failed\n"); return 2; }
    const llama_vocab *vocab = llama_model_get_vocab(model);
    std::vector<llama_token> toks(prefix.size() + 16);
    // Match the consumers' uncached text policy: BOS as needed, literal markers.
    int n = llama_tokenize(vocab, prefix.c_str(), (int)prefix.size(), toks.data(), (int)toks.size(), true, false);
    if (n <= 0 || n > INT_MAX - 256) { fprintf(stderr, "tokenize failed or prefix too large\n"); return 2; }
    toks.resize(n);
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = (uint32_t)(n + 256); cp.n_batch = 512; cp.n_ubatch = 512; cp.n_threads = threads; cp.n_threads_batch = threads;
    llama_context *ctx = llama_init_from_model(model, cp);
    if (!ctx) { fprintf(stderr, "ctx failed\n"); return 2; }
#ifdef SH_PREFIX_WITH_MTP
    anchor_mtp *mtp = want_mtp ? anchor_mtp_new(model, ctx, cp.n_ctx, 512, threads) : nullptr;
    if (want_mtp && !mtp) { fprintf(stderr, "model or runtime has no usable MTP head\n"); return 2; }
#endif
    for (int at = 0; at < n; at += 512) {
        const int b = n - at < 512 ? n - at : 512;
#ifdef SH_PREFIX_WITH_MTP
        if (mtp) {
            llama_batch batch = llama_batch_init(b, 0, 1);
            if (!batch.token || !batch.pos || !batch.seq_id || !batch.n_seq_id || !batch.logits) {
                llama_batch_free(batch); fprintf(stderr, "prefix batch allocation failed\n"); return 2;
            }
            for (int i = 0; i < b; i++) {
                batch.token[i] = toks[at + i]; batch.pos[i] = at + i;
                batch.n_seq_id[i] = 1; batch.seq_id[i][0] = 0; batch.logits[i] = 1;
            }
            batch.n_tokens = b;
            const int rc = llama_decode(ctx, batch); llama_batch_free(batch);
            if (rc || anchor_mtp_harvest(mtp, ctx, b) || anchor_mtp_observe(mtp, at, toks.data() + at, b)) {
                fprintf(stderr, "MTP prefill/observe failed at %d\n", at); return 2;
            }
            continue;
        }
#endif
        if (llama_decode(ctx, llama_batch_get_one(toks.data() + at, b))) { fprintf(stderr, "prefill failed at %d\n", at); return 2; }
    }
    size_t wrote = 0; char err[256];
#ifdef SH_PREFIX_WITH_MTP
    if (mtp) {
        // These are publisher-owned temporary files, never consumer storage.
        struct temporaries {
            std::vector<std::string> paths;
            ~temporaries() { for (const auto &p : paths) unlink(p.c_str()); }
            std::string create(const char *base) {
                std::string p = std::string(base) + ".component-XXXXXX";
                int fd = mkstemp(p.data()); if (fd < 0) return {};
                close(fd); paths.push_back(p); return p;
            }
        } tmp;
        const auto target_path = tmp.create(out), head_path = tmp.create(out);
        if (target_path.empty() || head_path.empty() ||
            !llama_state_seq_save_file(ctx, target_path.c_str(), 0, toks.data(), toks.size()) ||
            !llama_state_seq_save_file(anchor_mtp_ctx(mtp), head_path.c_str(), 0, toks.data(), toks.size())) {
            fprintf(stderr, "cannot save target/head sequence files\n"); return 2;
        }
        std::string target_data, head_data;
        if (!read_file(target_path.c_str(), target_data) || !read_file(head_path.c_str(), head_data)) {
            fprintf(stderr, "cannot read publisher sequence files\n"); return 2;
        }
        sh_prefix_kv_snapshot target{reinterpret_cast<uint8_t *>(target_data.data()), target_data.size(), uint64_t(n)};
        sh_prefix_kv_snapshot head{reinterpret_cast<uint8_t *>(head_data.data()), head_data.size(), uint64_t(n)};
        std::vector<float> pending(anchor_mtp_n_embd(mtp));
        if (anchor_mtp_pending_export(mtp, pending.data(), pending.size()) ||
            sh_prefix_mtp_write(out, &target, &head, pending.data(), pending.size(), err, sizeof err)) {
            fprintf(stderr, "cannot write MTP prefix container\n"); return 2;
        }
        struct stat st; if (stat(out, &st) == 0 && st.st_size > 0) wrote = size_t(st.st_size);
    } else
#endif
    wrote = llama_state_seq_save_file(ctx, out, 0, toks.data(), (size_t)n);
    if (!wrote) { fprintf(stderr, "state save failed\n"); return 2; }
    if (sh_prefix_kv_sign_v2(out, model_digest, digest, prefix.data(), prefix.size(), (uint64_t)n, sk, err, sizeof err)) { fprintf(stderr, "sign failed: %s\n", err); return 2; }
    uint8_t pk[32]; memcpy(pk, sk + 32, 32); char pkh[65]; sh_pads_bin2hex(pk, 32, pkh);
    char dh[65]; sh_pads_bin2hex(model_digest, 32, dh);
    printf("prefix-kv: %s: %d tokens, %zu bytes, model SHA256 %.16s..., signed v2 (%s); pin SHIELDED_PREFIX_KV_PK=%s\n", out, n, wrote, dh, want_mtp ? "target + MTP head" : "target", pkh);
#ifdef SH_PREFIX_WITH_MTP
    if (mtp) anchor_mtp_free(mtp);
#endif
    llama_free(ctx); llama_model_free(model);
    return 0;
}
