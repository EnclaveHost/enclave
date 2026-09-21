/*
 * engine_local.cpp -- the WHOLE model inside the protected VM: no worker, no pads, nothing blinded
 * because nothing leaves. The phone-only tier of the anchor (LOCAL.md).
 *
 * engine.cpp splits a model between the VM and an untrusted GPU; this engine keeps every weight,
 * activation, KV row and sampled token on the VM's own CPU. Same attested payload, same model
 * admission (the payload's one-read stage: whole-file digest against the pin, per-tensor digests),
 * same verified loading as engine.cpp (27B-FEASIBILITY.md s.11): llama parses the header the stage
 * hashed from PRIVATE MEMORY, then every tensor is read from the staged file into private memory,
 * hashed against the table BEFORE it is exposed, and placed in the buffer type llama chose. The
 * difference is the CPU module: libggml-cpu-repack.so (GGML_CPU_REPACK=ON), so Q4_0/Q8_0 matmul
 * weights are repacked FROM the verified bytes into the i8mm/dotprod block layouts. engine.cpp's
 * bundled module is built without repacking because its shielded encoder reads plain rows.
 *
 * It serves a conversation, not one prompt: requests arrive as lines on an accepted vsock
 * connection (the chat port), the KV cache is kept across turns, text streams back per token.
 *
 *   -> GEN <max_new_tokens> <temperature_milli> <hex utf-8 user message>
 *   -> RESET                              forget the conversation (KV cleared)
 *   -> BYE                                end the engine
 *   <- READY ctx=<n> threads=<n> vocab=<n> model=<hex digest> load_s=<f>
 *   <- TXT <hex utf-8 bytes>              one per sampled piece (may split a multi-byte character)
 *   <- STATS status=<eos|budget|ctx_full> prefill_tokens=.. prefill_tok_s=.. decode_tokens=.. decode_tok_s=.. ctx_used=.. ctx=..
 *   <- ERR <reason>                       the turn was refused; the conversation is unchanged
 *
 * Measured on the Pixel 10 Pro XL (Tensor G5, six big cores, Gemma 4 E2B Q4_0, this llama.cpp pin,
 * native): 16.3 tok/s decode, 169 tok/s prefill. A protected VM runs compute at native speed when
 * its owner is in the top-app or foreground cpuset (LOCAL.md has the numbers and the traps).
 */
#include "llama.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"

#include <cerrno>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <fcntl.h>
#include <string>
#include <sys/resource.h>
#include <unistd.h>
#include <vector>
#include <android/log.h>
#include "anchor_gguf.h"
#include "anchor_header_file.h"
#include "anchor_striped_read.h"
#include "engine_local_proto.h"
#include "anchor_plain_buft.h"
#include "ggml-tpu.h"
#include "llama-model.h"
#include "common.h"
#include "sampling.h"
#include "speculative.h"

static int (*g_ctl_writer)(const char *, size_t) = nullptr;
extern "C" void engine_local_set_ctl_writer(int (*fn)(const char *, size_t)) { g_ctl_writer = fn; }
static const anchor_gguf_table *g_table = nullptr;
static const anchor_hash_ops *g_hops = nullptr;
extern "C" void engine_local_set_model_table(const anchor_gguf_table *t, const anchor_hash_ops *h) { g_table = t; g_hops = h; }
/* Shielded-TPU decode (ggml-tpu.cpp): set before engine_local_main. The projection matmuls of a decode step then leave the VM
 * as masked int16 rows; everything else in this file is unchanged. */
static std::string g_tpu_bundle; static int g_tpu_fd = -1, g_tpu_bank = 0, g_tpu_refill = 0;
extern "C" int engine_local_set_tpu(const char *bundle, int worker_fd, int bank, int refill) { if (!bundle || !*bundle || worker_fd < 0) return -1; g_tpu_bundle = bundle; g_tpu_fd = worker_fd; g_tpu_bank = bank; g_tpu_refill = refill; return 0; }
/* Speculative rows (TPU.md, LOCAL.md): an OPTIONAL drafter proposes up to n_max tokens and the target verifies them as extra
 * rows of ONE step; on the Shielded-TPU path those rows ride the same 140 exchanges. The drafter needs no authentication:
 * the target checks every proposal, so a wrong or hostile drafter changes the speed and never the text. */
static std::string g_draft_path; static int g_draft_max = 4; static ggml_threadpool *g_pool = nullptr;
extern "C" int engine_local_set_draft(const char *path, int n_max) { if (!path || !*path || n_max < 1 || n_max > 4) return -1; g_draft_path = path; g_draft_max = n_max; return 0; }
/* exported by the pinned llama fork: every model tensor by name (tied weights may appear twice) */
extern const std::vector<std::pair<std::string, ggml_tensor *>> &llama_internal_get_tensor_map(const llama_model *);

/* diagnostics go to the owner's control channel (the payload's locked writer); chat lines go to the chat fd only */
/* the VM's memory and this process's page-ins, for the log: a slow turn with climbing major faults is the page cache, not the engine */
static std::string mem_line() {
    long avail = -1, cached = -1; if (FILE *f = fopen("/proc/meminfo", "r")) { char l[128]; while (fgets(l, sizeof l, f)) { sscanf(l, "MemAvailable: %ld", &avail); sscanf(l, "Cached: %ld", &cached); } fclose(f); }
    struct rusage ru; getrusage(RUSAGE_SELF, &ru); char o[160]; snprintf(o, sizeof o, "mem available %ld MiB, page cache %ld MiB, major faults %ld", avail / 1024, cached / 1024, ru.ru_majflt); return o;
}
static void outf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void outf(const char *fmt, ...) {
    char line[2048]; va_list ap; va_start(ap, fmt); int n = vsnprintf(line, sizeof line - 1, fmt, ap); va_end(ap);
    if (n < 0) return; if ((size_t)n > sizeof line - 2) n = sizeof line - 2;
    line[n] = '\n'; line[n + 1] = 0;
    __android_log_print(ANDROID_LOG_INFO, "anchor-local", "%.*s", n, line);
    if (g_ctl_writer) g_ctl_writer(line, (size_t)n + 1);
}
static void quiet_log(enum ggml_log_level level, const char *text, void *) {
    if (level == GGML_LOG_LEVEL_ERROR || level == GGML_LOG_LEVEL_WARN) { fputs(text, stderr); fflush(stderr); }
}
static const anchor_gguf_tensor *table_find(const char *name) {
    if (!g_table) return nullptr;
    for (size_t i = 0; i < g_table->n; i++) if (!strcmp(g_table->t[i].name, name)) return &g_table->t[i];
    return nullptr;
}
static int digest_matches(const anchor_gguf_tensor *e, const void *bytes, size_t n) {
    uint8_t ctx[256], d[32]; g_hops->init(ctx); g_hops->update(ctx, (const uint8_t *)bytes, n); g_hops->final(ctx, d);
    return memcmp(d, e->digest, 32) == 0;
}
static bool chat_write(int fd, const std::string &line) {
    std::string b = line + "\n"; size_t off = 0;
    while (off < b.size()) { ssize_t w = write(fd, b.data() + off, b.size() - off); if (w < 0 && errno == EINTR) continue; if (w <= 0) return false; off += (size_t)w; }
    return true;
}
/* one request line, bounded: a message is at most ENGINE_LOCAL_MAX_LINE bytes of hex + verb */
static int chat_read_line(int fd, std::string &out) {
    out.clear(); char buf[4096]; static std::string pending;
    for (;;) {
        size_t nl = pending.find('\n');
        if (nl != std::string::npos) { out = pending.substr(0, nl); pending.erase(0, nl + 1); return 0; }
        if (pending.size() > ENGINE_LOCAL_MAX_LINE) { pending.clear(); return -2; }
        ssize_t r = read(fd, buf, sizeof buf); if (r < 0 && errno == EINTR) continue; if (r <= 0) return -1;
        pending.append(buf, (size_t)r);
    }
}

/* Verified loading, as engine.cpp does it, for a CPU-only model: metadata from the verified header in private
 * memory (no_alloc: the loader reads and allocates nothing), then each tensor from the staged file, hashed against
 * the staged table before it is placed; a repack buffer type repacks FROM those verified bytes. */
static llama_model *load_verified(int model_fd, std::vector<ggml_backend_buffer_t> &owned, int read_threads) {
    if (!g_table || !g_hops || !g_table->header || !g_table->header_len) { outf("LOCAL refused: no verified model table from the payload"); return nullptr; }
    FILE *hf = anchor_header_file_open(g_table->header, g_table->header_len, g_table->file_size);
    if (!hf) { outf("LOCAL refused: cannot serve the verified header from memory: %s", strerror(errno)); return nullptr; }
    llama_model_params mp = llama_model_default_params(); mp.n_gpu_layers = 0;
    static llama_model_tensor_buft_override tpu_ov[2] = { { ANCHOR_TPU_CLAIM_PATTERN, nullptr }, { nullptr, nullptr } };
    if (g_tpu_fd >= 0) { tpu_ov[0].buft = anchor_plain_buft(); mp.tensor_buft_overrides = tpu_ov; }   /* claimed weights: plain host buffers, so the scheduler offers their matmuls to the TPU backend */
    mp.no_alloc = true; mp.load_mode = LLAMA_LOAD_MODE_NONE; mp.use_extra_bufts = true;
    llama_model *model = llama_model_load_from_file_ptr(hf, mp);
    fclose(hf);
    if (!model) { outf("LOCAL refused: model metadata did not load from the verified header"); return nullptr; }
    int src; do { src = fcntl(model_fd, F_DUPFD_CLOEXEC, 0); } while (src < 0 && errno == EINTR);
    if (src < 0) { outf("LOCAL refused: cannot hold the staged model: %s", strerror(errno)); llama_model_free(model); return nullptr; }
    std::vector<uint8_t> tmp; size_t n_repack = 0, n_cpu = 0; uint64_t vbytes = 0; bool ok = true;
    for (const auto &kv : llama_internal_get_tensor_map(model)) {
        ggml_tensor *t = kv.second; const std::string &name = kv.first;
        if (t->data) continue;                                             /* a tied weight appears twice in the map */
        const anchor_gguf_tensor *e = table_find(name.c_str());
        if (!e) { outf("LOCAL refused: %s is not in the staged table", name.c_str()); ok = false; break; }
        bool same = (uint32_t)t->type == e->type && ggml_nbytes(t) == e->size;
        for (int i = 0; i < 4 && same; i++) same = (uint64_t)t->ne[i] == e->ne[i];
        if (!same) { outf("LOCAL refused: %s: type/dims/size differ between the verified header and the table", name.c_str()); ok = false; break; }
        ggml_backend_buffer_type_t buft = t->buffer ? ggml_backend_buffer_get_type(t->buffer) : ggml_backend_cpu_buffer_type();   /* llama's choice */
        tmp.resize((size_t)e->size);
        const bool whole = anchor_striped_pread(src, g_table->data_start + e->offset, tmp.data(), e->size, read_threads, (uint64_t)16 << 20) == 0;
        posix_fadvise(src, (off_t)(g_table->data_start + e->offset), (off_t)e->size, POSIX_FADV_DONTNEED);   /* read once, then out of the guest's cache */
        if (!whole) { outf("LOCAL refused: %s: short read from the staged model", name.c_str()); ok = false; break; }
        if (!digest_matches(e, tmp.data(), (size_t)e->size)) { outf("LOCAL refused: %s: bytes in the staged model differ from its digest at stage time", name.c_str()); ok = false; break; }
        ggml_backend_buffer_t buf = ggml_backend_buft_alloc_buffer(buft, ggml_backend_buft_get_alloc_size(buft, t));
        if (!buf) { outf("LOCAL refused: %s: no memory for %zu bytes", name.c_str(), (size_t)e->size); ok = false; break; }
        t->buffer = nullptr;
        if (ggml_backend_tensor_alloc(buf, t, ggml_backend_buffer_get_base(buf)) != GGML_STATUS_SUCCESS) { outf("LOCAL refused: %s: tensor placement failed", name.c_str()); ggml_backend_buffer_free(buf); ok = false; break; }
        ggml_backend_tensor_set(t, tmp.data(), 0, (size_t)e->size);        /* a repack type repacks FROM the verified bytes here */
        ggml_backend_buffer_set_usage(buf, GGML_BACKEND_BUFFER_USAGE_WEIGHTS); owned.push_back(buf);
        const char *bname = ggml_backend_buft_name(buft);
        if (strstr(bname, "REPACK") || strstr(bname, "AARCH64")) n_repack++; else n_cpu++;
        vbytes += e->size;
    }
    close(src);
    if (!ok) { llama_model_free(model); for (ggml_backend_buffer_t b : owned) ggml_backend_buffer_free(b); owned.clear(); return nullptr; }
    model->hparams.no_alloc = false;   /* the pinned fork's flag: every tensor is real now, contexts may allocate */
    outf("LOCAL verified loader: %zu tensors (%.1f MiB) hashed against the staged table before use: %zu repacked from verified bytes, %zu plain CPU",
         n_repack + n_cpu, vbytes / 1048576.0, n_repack, n_cpu);
    if (n_repack == 0) outf("LOCAL WARNING: nothing was repacked: the CPU module is not the repacking build, decode will run on the generic kernels");
    return model;
}

struct turn_stats { int n_prefill = 0, n_decode = 0; double prefill_s = 0, decode_s = 0; const char *status = "budget"; };

extern "C" int engine_local_main(int chat_fd, int model_fd, const char *lib_dir, int n_threads, int n_ctx) {
    if (n_threads < 1) n_threads = 1; if (n_threads > 16) n_threads = 16;
    if (n_ctx < 512) n_ctx = 512; if (n_ctx > 32768) n_ctx = 32768;
    { const char *es = getenv("ANCHOR_ENCRYPTED_STORE"); char p[600]; snprintf(p, sizeof p, "%s/engine-local.err", es && *es ? es : "/data/local/tmp");
      if (!freopen(p, "w", stderr)) outf("LOCAL stderr not captured (%s: %s)", p, strerror(errno)); }
    setvbuf(stderr, NULL, _IONBF, 0);
    llama_log_set(quiet_log, nullptr);
    const std::string cpu_so = std::string(lib_dir) + "/libggml-cpu-repack.so";
    if (!ggml_backend_load(cpu_so.c_str())) { outf("LOCAL refused: the repacking CPU backend did not load (%s)", cpu_so.c_str()); return 2; }
    typedef void (*tpu_stats_fn)(ggml_backend_tpu_stats_t *, int); tpu_stats_fn tpu_stats = nullptr;
    if (g_tpu_fd >= 0) {
        const std::string tpu_so = std::string(lib_dir) + "/libggml-tpu.so";
        if (!ggml_backend_load(tpu_so.c_str())) { outf("LOCAL refused: the Shielded-TPU backend did not load (%s)", tpu_so.c_str()); return 2; }
        void *th = dlopen(tpu_so.c_str(), RTLD_NOW);
        auto open_b = th ? (int (*)(const char *))dlsym(th, "ggml_backend_tpu_open_bundle") : nullptr; auto set_l = th ? (void (*)(int, int))dlsym(th, "ggml_backend_tpu_set_link") : nullptr;
        auto mint = th ? (double (*)(int, int))dlsym(th, "ggml_backend_tpu_mint") : nullptr; tpu_stats = th ? (tpu_stats_fn)dlsym(th, "ggml_backend_tpu_get_stats") : nullptr;
        if (!open_b || !set_l || !mint || !tpu_stats) { outf("LOCAL refused: the Shielded-TPU backend lacks its entry points"); return 2; }
        if (open_b(g_tpu_bundle.c_str()) != 0) { outf("LOCAL refused: the lane bundle did not open (engine-local.err has the reason)"); return 2; }
        set_l(g_tpu_fd, 5);
        outf("LOCAL tpu: backend loaded, bundle open, worker link set (5 rows per exchange)");
    }
    llama_backend_init();
    const int64_t t_load0 = ggml_time_us();
    std::vector<ggml_backend_buffer_t> owned;
    int read_threads = 4; { const char *e = getenv("ANCHOR_SOURCE_READ_THREADS"); if (e) { int v = atoi(e); if (v == 0 || (v >= 2 && v <= 8)) read_threads = v; } }
    llama_model *model = load_verified(model_fd, owned, read_threads);
    if (!model) return 2;
    const double load_s = (ggml_time_us() - t_load0) / 1e6;
    const llama_vocab *vocab = llama_model_get_vocab(model);
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = (uint32_t)n_ctx; cp.n_batch = 512; cp.n_threads = n_threads; cp.n_threads_batch = n_threads;
    if (!g_draft_path.empty()) cp.n_rs_seq = (uint32_t)g_draft_max;   /* as llama.cpp's server sets it for an MTP drafter */
    llama_context *ctx = llama_init_from_model(model, cp);
    if (!ctx) { outf("LOCAL refused: context creation failed (ctx %d)", n_ctx); llama_model_free(model); for (auto b : owned) ggml_backend_buffer_free(b); return 2; }
    /* one persistent CPU pool: without it every graph respawns the threads (REPORT.md 12) */
    { void *cpu_h = dlopen(cpu_so.c_str(), RTLD_NOW);
      typedef ggml_threadpool *(*tp_new_fn)(ggml_threadpool_params *);
      tp_new_fn tp_new = cpu_h ? (tp_new_fn)dlsym(cpu_h, "ggml_threadpool_new") : nullptr;
      /* ggml's default pool. What decides the rate in this guest is the HOST's placement of the vCPU threads (the owner requests
       * the uclamp boost for it, Main.java); poll=100 and high-capacity pinning were tried once on a heat-soaked phone and the
       * measurement was confounded (LOCAL.md), so neither is adopted. */
      if (tp_new) { ggml_threadpool_params tpp = ggml_threadpool_params_default(n_threads); g_pool = tp_new(&tpp); if (g_pool) llama_attach_threadpool(ctx, g_pool, g_pool); }
      outf("LOCAL context ready: ctx %d, %d threads, persistent pool=%s, model loaded in %.1f s", n_ctx, n_threads, tp_new ? "yes" : "no", load_s); }
    char model_hex[65] = ""; if (g_table->has_whole) for (int i = 0; i < 32; i++) snprintf(model_hex + 2 * i, 3, "%02x", g_table->whole_digest[i]);
    /* Pads last: the model load above is the VM's biggest consumer of memory, and the lane bundle's pages must still be resident
     * when decode walks them (a bundle page that went back to the encrypted store costs a disk read per touched page). */
    if (g_tpu_fd >= 0) { void *th = dlopen((std::string(lib_dir) + "/libggml-tpu.so").c_str(), RTLD_NOW);
        auto warm = th ? (double (*)(int, int *))dlsym(th, "ggml_backend_tpu_warm_bundle") : nullptr; auto mint = th ? (double (*)(int, int))dlsym(th, "ggml_backend_tpu_mint") : nullptr;
        auto refill = th ? (void (*)(int, int))dlsym(th, "ggml_backend_tpu_refill_start") : nullptr;
        if (warm) { int locked = 0; const double sec = warm(n_threads, &locked); outf("LOCAL tpu: lane bundle paged in from the encrypted store in %.1f s (%s) | %s", sec, locked ? "locked in memory" : "NOT locked: it can be evicted", mem_line().c_str()); }
        if (mint && g_tpu_bank > 0) { const double sec = mint(g_tpu_bank, n_threads); outf("LOCAL tpu: minted %d pad positions per group in %.1f s (%.1f positions per second on %d threads) | %s", g_tpu_bank, sec, g_tpu_bank / sec, n_threads, mem_line().c_str());
                              /* opt-in: minting while decoding keeps the vCPUs busy, and busy vCPUs slow the link (measured 4.3 -> 7.7 ms per exchange with 4 minters) */
                              if (refill && g_tpu_refill > 0) { refill(g_tpu_bank, g_tpu_refill); outf("LOCAL tpu: %d background minters keep the bank at %d positions", g_tpu_refill, g_tpu_bank); }
                              /* the link window is idle for about 3.9 ms of every exchange and a pad depends on nothing,
                               * so decode mints its own there; with this on, g_tpu_refill 0 costs the worker no cores */
                              if (auto wmint = (void (*)(int, int))dlsym(th, "ggml_backend_tpu_window_mint")) { wmint(g_tpu_bank, 8); outf("LOCAL tpu: minting inside the link window to a bank of %d positions", g_tpu_bank); } } }
    { char l[256]; snprintf(l, sizeof l, "READY ctx=%d threads=%d vocab=%d model=%s load_s=%.1f", n_ctx, n_threads, llama_vocab_n_tokens(vocab), model_hex[0] ? model_hex : "-", load_s); chat_write(chat_fd, l); }

    /* the drafter: its own context in MTP mode, sharing the target's memory (llama.cpp's speculative helper does the rest) */
    common_speculative *spec = nullptr; common_speculative_init_result_ptr spec_init; common_params sp;
    if (!g_draft_path.empty()) {
        sp.n_ctx = n_ctx; sp.n_batch = 512; sp.n_gpu_layers = 0; sp.cpuparams.n_threads = n_threads; sp.cpuparams_batch.n_threads = n_threads; sp.warmup = false;
        sp.speculative.types = { COMMON_SPECULATIVE_TYPE_DRAFT_MTP }; sp.speculative.draft.mparams.path = g_draft_path; sp.speculative.draft.n_max = g_draft_max; sp.speculative.draft.n_gpu_layers = 0;
        common_params pd = common_base_params_to_speculative(sp);
        spec_init = common_speculative_init_from_params(pd, model, ctx);
        if (!spec_init || !spec_init->context()) { outf("LOCAL refused: the drafter did not load (%s)", g_draft_path.c_str()); return 2; }
        if (g_pool) llama_attach_threadpool(spec_init->context(), g_pool, g_pool);
        sp.speculative.draft.ctx_tgt = ctx; sp.speculative.draft.ctx_dft = spec_init->context();
        spec = common_speculative_init(sp.speculative, 1);
        if (!spec) { outf("LOCAL refused: speculative decoding did not initialize"); return 2; }
        outf("LOCAL drafter ready: up to %d proposals per step (%d rows verified at once)", g_draft_max, g_draft_max + 1);
    }
    llama_memory_t mem = llama_get_memory(ctx);
    std::vector<llama_token> hist; llama_token pending = -1;   /* hist: every token in the KV; pending: a token already shown to the user that the KV has not seen yet (speculative turns end on one) */
    int n_past = 0; bool open_turn = false;   /* open_turn: the last reply ended without its end-of-turn marker in the KV (always: a sampled EOG is never fed back) */
    std::string line; int served = 0;
    for (;;) {
        const int rl = chat_read_line(chat_fd, line);
        if (rl == -2) { chat_write(chat_fd, "ERR request line too long"); continue; }
        if (rl < 0 || line == "BYE") break;
        if (line == "RESET") { llama_memory_clear(mem, true); n_past = 0; open_turn = false; hist.clear(); pending = -1; chat_write(chat_fd, "STATS status=reset ctx_used=0 ctx=" + std::to_string(n_ctx)); continue; }
        engine_local_request rq;
        if (!engine_local_parse_gen(line.c_str(), &rq)) { chat_write(chat_fd, "ERR malformed request (GEN <max_new_tokens 1..8192> <temperature_milli 0..2000> <hex message>)"); continue; }
        std::string msg; if (!engine_local_unhex(rq.hex, msg) || msg.empty()) { chat_write(chat_fd, "ERR message is not valid hex"); continue; }
        /* Gemma 4's turn format (the checkpoint's chat_template.jinja): <bos> once, then
         * <|turn>user\n...<turn|>\n<|turn>model\n ; the previous reply's <turn|>\n is supplied here because the
         * sampled end-of-turn token was never decoded into the KV. */
        std::string text = (open_turn ? "<turn|>\n" : "") + std::string("<|turn>user\n") + msg + "<turn|>\n<|turn>model\n";
        std::vector<llama_token> toks(text.size() + 16);
        int n = llama_tokenize(vocab, text.c_str(), (int)text.size(), toks.data(), (int)toks.size(), /*add_special=*/n_past == 0, /*parse_special=*/true);
        if (n < 0) { chat_write(chat_fd, "ERR tokenize failed"); continue; }
        toks.resize(n);
        if (pending >= 0) { toks.insert(toks.begin(), pending); n++; }
        if (n_past + n + 8 > n_ctx) { chat_write(chat_fd, "ERR context full (" + std::to_string(n_past) + " used + " + std::to_string(n) + " new > " + std::to_string(n_ctx) + "): send RESET to start a new conversation"); continue; }
        turn_stats st; st.n_prefill = n;
        if (spec) {   /* ---- a speculative turn: prefill all but the last prompt token, then draft -> verify rows -> accept ---- */
            const int64_t t0s = ggml_time_us(); bool bad = false; llama_batch batch = llama_batch_init(512, 0, 1);
            for (int i = 0; i + 1 < n && !bad; ) { common_batch_clear(batch); for (; i + 1 < n && batch.n_tokens < 512; i++) common_batch_add(batch, toks[i], n_past + i, { 0 }, false);
                if (llama_decode(ctx, batch) || !common_speculative_process(spec, batch)) bad = true; }
            if (bad) { llama_batch_free(batch); llama_memory_seq_rm(mem, 0, n_past, -1); chat_write(chat_fd, "ERR prefill failed; the turn was rolled back"); continue; }
            for (int i = 0; i + 1 < n; i++) hist.push_back(toks[i]);
            n_past += n - 1; pending = -1; st.prefill_s = (ggml_time_us() - t0s) / 1e6;
            common_params_sampling sps; sps.temp = rq.temperature_milli / 1000.0f; sps.top_k = 64; sps.top_p = 0.95f;
            common_sampler_ptr smpl(common_sampler_init(model, sps));
            common_speculative_begin(spec, 0, hist);
            llama_token id_last = toks[n - 1]; llama_tokens draft; int drafted = 0, accepted = 0, steps = 0; bool peer_gone = false, done = false; const int64_t t1s = ggml_time_us();
            while (!done) {
                int room = n_ctx - n_past - 2; if (room < 1) { st.status = "ctx_full"; break; }
                draft.clear(); auto &dp = common_speculative_get_draft_params(spec, 0);
                dp.drafting = true; dp.n_max = room - 1 < g_draft_max ? (room - 1 < 0 ? 0 : room - 1) : g_draft_max; dp.n_past = n_past; dp.id_last = id_last; dp.prompt = &hist; dp.result = &draft;
                common_speculative_draft(spec);
                if ((int)draft.size() > g_draft_max) draft.resize((size_t)g_draft_max);
                common_batch_clear(batch); common_batch_add(batch, id_last, n_past, { 0 }, true);
                for (size_t i = 0; i < draft.size(); i++) common_batch_add(batch, draft[i], n_past + 1 + (llama_pos)i, { 0 }, true);
                if (llama_decode(ctx, batch) || !common_speculative_process(spec, batch)) { st.status = "decode_failed"; break; }
                const std::vector<llama_token> ids = common_sampler_sample_and_accept_n(smpl.get(), ctx, draft);   /* the accepted proposals, then one token of the target's own */
                steps++; drafted += (int)draft.size(); accepted += (int)ids.size() - 1;
                hist.push_back(id_last); n_past += (int)ids.size();                  /* id_last and the accepted proposals are in the KV now */
                for (size_t i = 0; i + 1 < ids.size(); i++) hist.push_back(ids[i]);
                llama_memory_seq_rm(mem, 0, n_past, -1);                                /* the rejected rows */
                common_speculative_accept(spec, 0, (uint16_t)(ids.size() - 1));
                /* show the step's tokens. The KV holds id_last and the accepted proposals ids[0..m-1]; ids[m] (the target's own
                 * sample) is not in it yet. A turn that stops at ids[i] rolls the KV back to just before ids[i]: after an
                 * end-of-turn nothing is pending (the marker is re-supplied as text next turn), after the budget ids[i] is. */
                const int m = (int)ids.size() - 1;
                auto rollback_before = [&](int i) { const int keep = n_past - (m - i); if (keep < n_past) { llama_memory_seq_rm(mem, 0, keep, -1); hist.resize(hist.size() - (size_t)(n_past - keep)); n_past = keep; } };
                for (int i = 0; i <= m; i++) {
                    if (llama_vocab_is_eog(vocab, ids[(size_t)i])) { st.status = "eos"; rollback_before(i); pending = -1; done = true; break; }
                    char piece[256]; const int pn = llama_token_to_piece(vocab, ids[(size_t)i], piece, sizeof piece, 0, false);
                    if (pn > 0 && !chat_write(chat_fd, "TXT " + engine_local_hex((const uint8_t *)piece, (size_t)pn))) { peer_gone = true; done = true; break; }
                    if (++st.n_decode >= rq.max_new) { rollback_before(i); pending = ids[(size_t)i]; done = true; break; }
                }
                if (!done) id_last = ids.back();
            }
            if (!done) pending = id_last;                                               /* ctx_full / decode_failed: shown (or the prompt's last token), not in the KV */
            st.decode_s = (ggml_time_us() - t1s) / 1e6; llama_batch_free(batch); open_turn = true; served++;
            if (peer_gone) break;
            char s2[512]; snprintf(s2, sizeof s2, "STATS status=%s prefill_tokens=%d prefill_tok_s=%.2f decode_tokens=%d decode_tok_s=%.2f ctx_used=%d ctx=%d steps=%d drafted=%d accepted=%d tokens_per_step=%.2f",
                                   st.status, st.n_prefill, st.prefill_s > 0 ? (st.n_prefill - 1) / st.prefill_s : 0.0, st.n_decode, st.decode_s > 0 ? st.n_decode / st.decode_s : 0.0, n_past, n_ctx, steps, drafted, accepted, steps ? (double)st.n_decode / steps : 0.0);
            if (!chat_write(chat_fd, s2)) break;
            outf("LOCAL turn %d: %s", served, s2 + 6);
            if (tpu_stats) { ggml_backend_tpu_stats_t ts; tpu_stats(&ts, 1); const double ex = ts.exchanges ? (double)ts.exchanges : 1.0;
                outf("LOCAL tpu turn %d: exchanges=%llu (%.1f/step, %.2f rows each) ms per exchange: mask %.3f link %.3f unmask %.3f | pads inline %llu refilled %llu bank_min %llu | outliers kept %llu saturated %llu",
                     served, (unsigned long long)ts.exchanges, ex / (steps ? steps : 1), ts.rows / ex, ts.mask_us / ex / 1e3, ts.link_us / ex / 1e3, ts.unmask_us / ex / 1e3, (unsigned long long)ts.pads_minted_inline, (unsigned long long)ts.pads_refilled, (unsigned long long)ts.bank_min, (unsigned long long)ts.outlier_entries, (unsigned long long)ts.saturated); }
            continue;
        }
        const int64_t t0 = ggml_time_us(); bool failed = false;
        for (int i = 0; i < n && !failed; i += 512) {
            const int k = n - i < 512 ? n - i : 512;
            if (llama_decode(ctx, llama_batch_get_one(toks.data() + i, k))) failed = true;
        }
        if (failed) { llama_memory_seq_rm(mem, 0, n_past, -1); chat_write(chat_fd, "ERR prefill failed; the turn was rolled back"); continue; }
        n_past += n; st.prefill_s = (ggml_time_us() - t0) / 1e6; pending = -1; hist.insert(hist.end(), toks.begin(), toks.end());
        llama_sampler *smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
        if (rq.temperature_milli == 0) llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
        else { llama_sampler_chain_add(smpl, llama_sampler_init_top_k(64)); llama_sampler_chain_add(smpl, llama_sampler_init_top_p(0.95f, 1));
               llama_sampler_chain_add(smpl, llama_sampler_init_temp(rq.temperature_milli / 1000.0f)); llama_sampler_chain_add(smpl, llama_sampler_init_dist(LLAMA_DEFAULT_SEED)); }
        const int64_t t1 = ggml_time_us(); bool peer_gone = false;
        for (int g = 0; g < rq.max_new; g++) {
            llama_token tok = llama_sampler_sample(smpl, ctx, -1);
            if (llama_vocab_is_eog(vocab, tok)) { st.status = "eos"; break; }
            char piece[256]; const int pn = llama_token_to_piece(vocab, tok, piece, sizeof piece, 0, /*special=*/false);
            if (pn > 0 && !chat_write(chat_fd, "TXT " + engine_local_hex((const uint8_t *)piece, (size_t)pn))) { peer_gone = true; break; }
            if (n_past + 1 >= n_ctx) { st.status = "ctx_full"; break; }
            if (llama_decode(ctx, llama_batch_get_one(&tok, 1))) { st.status = "decode_failed"; break; }
            n_past++; st.n_decode++; hist.push_back(tok);
        }
        st.decode_s = (ggml_time_us() - t1) / 1e6;
        llama_sampler_free(smpl); open_turn = true; served++;
        if (peer_gone) break;
        char s[384]; snprintf(s, sizeof s, "STATS status=%s prefill_tokens=%d prefill_tok_s=%.2f decode_tokens=%d decode_tok_s=%.2f ctx_used=%d ctx=%d",
                              st.status, st.n_prefill, st.prefill_s > 0 ? st.n_prefill / st.prefill_s : 0.0, st.n_decode, st.decode_s > 0 ? st.n_decode / st.decode_s : 0.0, n_past, n_ctx);
        if (!chat_write(chat_fd, s)) break;
        outf("LOCAL turn %d: %s", served, s + 6);   /* the owner's log sees the counters, never the text */
        if (tpu_stats) { ggml_backend_tpu_stats_t ts; tpu_stats(&ts, 1); const double ex = ts.exchanges ? (double)ts.exchanges : 1.0;
            outf("LOCAL tpu turn %d: exchanges=%llu (%.1f/token) ms per exchange: mask %.3f link %.3f (corr %.3f mint %.3f wait %.3f) unmask %.3f | KB/token out %.0f in %.0f | pads inline %llu (%.1f ms each) bank_min %llu | outliers kept %llu saturated %llu redrawn %llu | %s",
                 served, (unsigned long long)ts.exchanges, ex / (st.n_decode ? st.n_decode : 1), ts.mask_us / ex / 1e3, ts.link_us / ex / 1e3, ts.corr_us / ex / 1e3, ts.window_mint_us / ex / 1e3, ts.wait_us / ex / 1e3, ts.unmask_us / ex / 1e3,
                 ts.bytes_out / 1024.0 / (st.n_decode ? st.n_decode : 1), ts.bytes_in / 1024.0 / (st.n_decode ? st.n_decode : 1), (unsigned long long)ts.pads_minted_inline,
                 ts.pads_minted_inline ? ts.mint_inline_us / 1e3 / ts.pads_minted_inline : 0.0, (unsigned long long)ts.bank_min, (unsigned long long)ts.outlier_entries, (unsigned long long)ts.saturated, (unsigned long long)ts.pads_redrawn, mem_line().c_str()); }
    }
    if (g_tpu_fd >= 0) { if (void *th = dlopen((std::string(lib_dir) + "/libggml-tpu.so").c_str(), RTLD_NOW)) { auto stop = (void (*)(void))dlsym(th, "ggml_backend_tpu_refill_stop"); if (stop) stop(); } }
    outf("LOCAL engine ending after %d turns", served);
    llama_free(ctx); llama_model_free(model); for (ggml_backend_buffer_t b : owned) ggml_backend_buffer_free(b);
    return 0;
}
