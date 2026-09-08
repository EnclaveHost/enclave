/* shielded-dealer: mint a .pads shipment for a model (shielded/dealer/PLAN.md).
 *
 *   SHIELDED_SO=libggml-shielded.so GGML_CPU_SO=libggml-cpu.so SHIELDED_CALIB=model.calib \
 *   shielded-dealer model.gguf --out seed-0-64.pads --seed <64 hex> --seed-id <32 hex> \
 *                  --pk <consumer X25519 public key, 64 hex> [--index0 0] [--count 64] [--mtp 1]
 *
 * Loads the model exactly as the engine does (the same registration, grouping
 * and field encoding), against a worker that is never contacted, and mints
 * through the backend's ggml_backend_shielded_mint. The model digest recorded
 * in the shipment is SHA-512/256 of the calibration file. Prints the shipment
 * path and the group table so a consumer can be checked against it. */
#include "ggml-backend.h"
#include "llama.h"
#include "shielded-pads.h"
#include "shielded-dealer-stream.h"
extern "C" {
#include "tweetnacl.h"
}
#include <dlfcn.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>

typedef int (*mint_fn)(const char *, const char *, const char *, uint64_t, uint64_t, const char *, const char *);

static bool file_digest(const char *path, uint8_t out[32]) {
    FILE *f = fopen(path, "rb");
    if (!f) return false;
    std::vector<unsigned char> buf;
    unsigned char chunk[1 << 16];
    size_t n;
    while ((n = fread(chunk, 1, sizeof chunk, f)) > 0) buf.insert(buf.end(), chunk, chunk + n);
    const bool read_ok = !ferror(f);
    const int close_rc = fclose(f);
    if (!read_ok || close_rc || buf.empty()) return false;
    unsigned char h[64];
    crypto_hash(h, buf.data(), buf.size());
    memcpy(out, h, 32);
    return true;
}

struct stream_context {
    mint_fn mint = nullptr;
    std::string directory, digest;
    std::vector<sh_dealer_stream_asset> assets;
    struct stat directory_stamp = {};
    bool unchanged() const {
        struct stat st;
        if (stat(directory.c_str(), &st) || !S_ISDIR(st.st_mode) || st.st_dev != directory_stamp.st_dev ||
                st.st_ino != directory_stamp.st_ino) return false;
        for (const auto &asset : assets) if (!asset.unchanged()) return false;
        return true;
    }
};

static sh_dealer_stream_result stream_mint(const sh_dealer_stream_job &job, void *opaque) {
    auto &s = *static_cast<stream_context *>(opaque);
    if (!s.unchanged()) return SH_DEALER_STREAM_ASSET_CHANGED;
    const std::string path = s.directory + "/" + job.seed_id + "-" + std::to_string(job.index0) + "-" +
        std::to_string(job.count) + ".pads";
    return s.mint(job.seed, job.seed_id, s.digest.c_str(), job.index0, job.count, job.pad_pk, path.c_str()) == 0 ?
        SH_DEALER_STREAM_OK : SH_DEALER_STREAM_MINT_FAILED;
}

int main(int argc, char **argv) {
    const char *model_path = argc > 1 ? argv[1] : nullptr;
    const char *out = nullptr, *seed = nullptr, *seed_id = nullptr, *pk = nullptr, *ranges = nullptr, *worker = nullptr, *jobs = nullptr;
    const char *stream_directory = nullptr;
    uint64_t index0 = 0, count = 64;
    bool mtp = false, range_options = false;
    if (argc > 1 && (argc - 2) % 2) { fprintf(stderr, "options require values\n"); return 2; }
    for (int i = 2; i + 1 < argc; i += 2) {
        if (!strcmp(argv[i], "--out")) out = argv[i + 1];
        else if (!strcmp(argv[i], "--ranges")) ranges = argv[i + 1];   /* i0:count,i0:count,...; --out is then a template with {index0} and {count} */
        else if (!strcmp(argv[i], "--seed")) seed = argv[i + 1];
        else if (!strcmp(argv[i], "--seed-id")) seed_id = argv[i + 1];
        else if (!strcmp(argv[i], "--pk")) pk = argv[i + 1];
        else if (!strcmp(argv[i], "--index0")) { index0 = strtoull(argv[i + 1], nullptr, 10); range_options = true; }
        else if (!strcmp(argv[i], "--count")) { count = strtoull(argv[i + 1], nullptr, 10); range_options = true; }
        else if (!strcmp(argv[i], "--mtp")) {
            if (strcmp(argv[i + 1], "0") && strcmp(argv[i + 1], "1")) { fprintf(stderr, "--mtp requires 0 or 1\n"); return 2; }
            mtp = !strcmp(argv[i + 1], "1");
        }
        else if (!strcmp(argv[i], "--worker")) worker = argv[i + 1];   /* host:port of the DEALER'S OWN worker: r goes to it unmasked, u = r.W comes back at GPU speed */
        else if (!strcmp(argv[i], "--jobs")) jobs = argv[i + 1];       /* many seeds, ONE model load: lines of "seed seed_id pk out-template ranges" */
        else if (!strcmp(argv[i], "--jobs-stdin")) stream_directory = argv[i + 1];
        else { fprintf(stderr, "unknown option %s\n", argv[i]); return 2; }
    }
    const char *backend = getenv("SHIELDED_SO"), *calib = getenv("SHIELDED_CALIB");
    const char *cpu_so = getenv("GGML_CPU_SO");
    stream_context stream;
    FILE *protocol = nullptr;
    if (stream_directory) {
        if (out || seed || seed_id || pk || ranges || jobs || worker || range_options || !model_path || !backend || !calib || !cpu_so) {
            fprintf(stderr, "--jobs-stdin requires model, calibration and explicit CPU/backend libraries; only --mtp may accompany it\n"); return 2;
        }
        char *resolved = realpath(stream_directory, nullptr);
        if (!resolved) { fprintf(stderr, "cannot resolve stream output directory\n"); return 2; }
        stream.directory = resolved; free(resolved);
        if (stat(stream.directory.c_str(), &stream.directory_stamp) || !S_ISDIR(stream.directory_stamp.st_mode)) {
            fprintf(stderr, "stream output directory is not a directory\n"); return 2;
        }
        for (const char *path : {model_path, calib, backend, cpu_so}) {
            sh_dealer_stream_asset asset;
            if (!asset.capture(path)) { fprintf(stderr, "cannot identify a stream asset\n"); return 2; }
            stream.assets.push_back(asset);
        }
        // Reserve stdout exclusively for the private protocol. Any library
        // chatter, including ordinary printf, is sent to the parent's stderr.
        fflush(stdout);
        const int protocol_fd = fcntl(STDOUT_FILENO, F_DUPFD_CLOEXEC, 3);
        if (protocol_fd < 0) { fprintf(stderr, "cannot open protocol output\n"); return 2; }
        protocol = fdopen(protocol_fd, "w");
        if (!protocol || dup2(STDERR_FILENO, STDOUT_FILENO) < 0) {
            if (protocol) fclose(protocol); else close(protocol_fd);
            fprintf(stderr, "cannot isolate protocol output\n"); return 2;
        }
        signal(SIGPIPE, SIG_IGN); // A lost parent becomes an I/O failure, never a successful acknowledgment.
        if (setvbuf(stdin, nullptr, _IONBF, 0)) { fprintf(stderr, "cannot configure private input\n"); return 2; }
        // No inherited pool/operator endpoint in this opt-in CPU-only mode.
        setenv("SHIELDED_HOST", "127.0.0.1", 1); setenv("SHIELDED_PORT", "1", 1);
        setenv("SHIELDED_RESERVE_BYTES", "1099511627776", 1);
        unsetenv("SHIELDED_WORKERS"); unsetenv("SHIELDED_ZERO_PADS");
    }
    /* A jobs file (the dealer daemon's pass): each line names a consumer's
     * seed, seed id, pad key, output template and ranges; the weights load
     * and register once for all of them. Seeds are secrets: the file is the
     * daemon's, 0600, and gone after the pass. */
    struct job { std::string seed, seed_id, pk, out, ranges; };
    std::vector<job> joblist;
    if (jobs) {
        FILE *jf = fopen(jobs, "r");
        if (!jf) { fprintf(stderr, "cannot read jobs %s\n", jobs); return 2; }
        char line[4096];
        while (fgets(line, sizeof line, jf)) {
            char a[130], b[40], c[70], o[2048], r[1500];
            if (line[0] == '#' || line[0] == '\n') continue;
            if (sscanf(line, "%129s %39s %69s %2047s %1499s", a, b, c, o, r) != 5) {
                sh_dealer_stream_wipe(a, sizeof a); sh_dealer_stream_wipe(line, sizeof line);
                fprintf(stderr, "bad jobs line (contents redacted)\n"); fclose(jf); return 2;
            }
            joblist.push_back({ a, b, c, o, r });
            sh_dealer_stream_wipe(a, sizeof a); sh_dealer_stream_wipe(line, sizeof line);
        }
        fclose(jf);
        if (joblist.empty()) { fprintf(stderr, "jobs file %s is empty\n", jobs); return 2; }
    } else if (model_path && out && seed && seed_id && pk) {
        joblist.push_back({ seed, seed_id, pk, out, ranges ? ranges : "" });
    }
    if (!model_path || (!stream_directory && joblist.empty()) || !backend || !calib) {
        fprintf(stderr, "usage: SHIELDED_SO=.. GGML_CPU_SO=.. SHIELDED_CALIB=.. shielded-dealer model.gguf --out F --seed H64 --seed-id H32 --pk H64 [--index0 N] [--count N] [--mtp 0|1] | [--ranges i0:n,i0:n --out template{index0}{count}] | --jobs-stdin DIR [--mtp 0|1]\n");
        return 2;
    }
    /* The weights register against a link that is never connected: a port
     * nothing listens on, and the whole card budget so every site registers. */
    if (worker) {
        /* Minting through a worker the dealer owns: zero pads, so the wire
         * carries r itself and the product IS u. Never point this at an
         * operator's worker - it would learn every mask it later unmasks. */
        std::string w = worker; const size_t c = w.rfind(':');
        if (c == std::string::npos) { fprintf(stderr, "--worker needs host:port\n"); return 2; }
        setenv("SHIELDED_HOST", w.substr(0, c).c_str(), 1);
        setenv("SHIELDED_PORT", w.substr(c + 1).c_str(), 1);
        setenv("SHIELDED_ZERO_PADS", "1", 1);
        setenv("SHIELDED_PAD_CHECK", "1", 1);      /* builds the mod-M check vectors the mint verifies the worker with */
    } else {
        setenv("SHIELDED_HOST", "127.0.0.1", 0);
        setenv("SHIELDED_PORT", "1", 0);
        setenv("SHIELDED_RESERVE_BYTES", "1099511627776", 0);   /* dead link: the whole "card" so every site registers */
    }
    setenv("SHIELDED_WARM_MS", "0", 0);
    if (cpu_so) {
        if (!ggml_backend_load(cpu_so)) { fprintf(stderr, "cpu backend failed to load\n"); return 2; }
    }
    ggml_backend_reg_t r = ggml_backend_load(backend);
    if (!r) { fprintf(stderr, "shielded backend failed to load\n"); return 2; }
    void *h = dlopen(backend, RTLD_NOW | RTLD_NOLOAD);
    if (!h) h = dlopen(backend, RTLD_NOW);
    mint_fn mint = h ? (mint_fn)dlsym(h, worker ? "ggml_backend_shielded_mint_worker" : "ggml_backend_shielded_mint") : nullptr;
    if (!mint) { fprintf(stderr, "ggml_backend_shielded_mint%s not exported by %s%s\n", worker ? "_worker" : "", backend, worker ? " (--worker needs the dealer build: SHIELDED_SO=libggml-shielded-dealer.so)" : ""); return 2; }

    llama_backend_init();
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = 0;
    mp.load_mtp = mtp;
    llama_model *model = llama_model_load_from_file(model_path, mp);
    if (!model) { fprintf(stderr, "model load failed\n"); return 2; }
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = 512; cp.n_batch = 512; cp.n_threads = 8; cp.n_threads_batch = 8;
    llama_context *ctx = llama_init_from_model(model, cp);
    if (!ctx) { fprintf(stderr, "context failed\n"); return 2; }
    /* The head's context reservation discovers its calibrated weights, just
     * as anchor_mtp_new does on the phone. It must happen BEFORE the first
     * target graph plans the shared link. Otherwise the dealer mints only
     * target groups, and an MTP consumer rejects every shipment at binding. */
    llama_context *head = nullptr;
    if (mtp) {
        if (llama_model_n_layer_nextn(model) <= 0) { fprintf(stderr, "--mtp 1 requires a model with an MTP head\n"); llama_free(ctx); llama_model_free(model); return 2; }
        llama_context_params hp = cp;
        hp.ctx_type = LLAMA_CONTEXT_TYPE_MTP;
        hp.n_batch = 8; hp.n_seq_max = 1; hp.kv_unified = true;
        head = llama_init_from_model(model, hp);
        if (!head) { fprintf(stderr, "MTP context failed; refusing target-only pads\n"); llama_free(ctx); llama_model_free(model); return 2; }
        fprintf(stderr, "dealer MTP head reserved before target registration\n");
    }
    /* Registration happens when the FIRST graph is planned (sh_plan places
     * every pending calibrated site and registers it with the link), not at
     * context creation; so decode one token. The connect to the dead port
     * fails and that token is computed in the clear, which is fine here. */
    {
        const llama_vocab *vocab = llama_model_get_vocab(model);
        std::vector<llama_token> toks(16);
        const char *probe = "Hello";
        int n = llama_tokenize(vocab, probe, (int)strlen(probe), toks.data(), (int)toks.size(), true, false);
        if (n <= 0) { fprintf(stderr, "tokenize failed\n"); return 2; }
        toks.resize(n);
        llama_batch batch = llama_batch_get_one(toks.data(), n);
        if (llama_decode(ctx, batch)) { fprintf(stderr, "probe decode failed\n"); return 2; }
    }

    uint8_t digest[32]; char digest_hex[65];
    if (!file_digest(calib, digest)) { fprintf(stderr, "cannot read calib %s\n", calib); return 2; }
    sh_pads_bin2hex(digest, 32, digest_hex);
    int result = 0;
    if (stream_directory) {
        stream.mint = mint; stream.digest = digest_hex;
        if (!stream.unchanged()) {
            fprintf(protocol, "PADS-ERROR 0 asset-changed\n"); fflush(protocol); result = 1;
        } else if (fprintf(protocol, "PADS-READY 1 mtp=%d calib=%s\n", mtp ? 1 : 0, digest_hex) < 0 || fflush(protocol)) {
            result = 1;
        } else {
            result = sh_dealer_stream_run(stdin, protocol, stream_mint, &stream);
        }
        if (fclose(protocol) && !result) result = 1;
    }
    /* One model load, any number of shipments for any number of seeds: the
     * loop that keeps banks ahead of their ledgers mints every missing range
     * of every consumer in one process. */
    for (const job &jb : joblist) {
        std::vector<std::pair<uint64_t, uint64_t>> plan;
        if (!jb.ranges.empty()) {
            const std::string &r = jb.ranges;
            for (size_t at = 0; at < r.size();) {
                size_t comma = r.find(',', at); if (comma == std::string::npos) comma = r.size();
                const std::string one = r.substr(at, comma - at); at = comma + 1;
                const size_t colon = one.find(':');
                if (colon == std::string::npos) { fprintf(stderr, "bad range %s\n", one.c_str()); return 2; }
                plan.emplace_back(strtoull(one.substr(0, colon).c_str(), nullptr, 10), strtoull(one.substr(colon + 1).c_str(), nullptr, 10));
            }
        } else plan.emplace_back(index0, count);
        for (auto &pr : plan) {
            std::string path = jb.out;
            auto sub = [&](const char *key, uint64_t v) { for (size_t k; (k = path.find(key)) != std::string::npos;) path.replace(k, strlen(key), std::to_string(v)); };
            sub("{index0}", pr.first); sub("{count}", pr.second);
            const int rc = mint(jb.seed.c_str(), jb.seed_id.c_str(), digest_hex, pr.first, pr.second, jb.pk.c_str(), path.c_str());
            if (rc != 0) { fprintf(stderr, "mint failed: %d\n", rc); return 1; }
            printf("minted %s: indices [%llu, %llu), model digest %s\n", path.c_str(), (unsigned long long)pr.first,
                   (unsigned long long)(pr.first + pr.second), digest_hex);
            fflush(stdout);
        }
    }
    if (head) llama_free(head);
    llama_free(ctx);
    llama_model_free(model);
    return result;
}
