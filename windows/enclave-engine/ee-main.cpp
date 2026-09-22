/* ee-main.cpp -- the shielded engine as a VBS enclave: the trusted half of the consumer node.
 *
 * Inside VTL1: llama.cpp's CPU path, the shielded backend (masks every linear op and offloads
 * it to the untrusted GPU worker over a call-out the host relays), the per-boot keys the node's
 * attestation binds, and the attestation itself. The host (ee-host.c, VTL0) is plumbing: it
 * loads this DLL, hands over the model bytes and the environment, owns the worker socket and
 * the log, and enters threads. It never sees an activation, a pad or a private key.
 *
 * Exports (CallEnclave routines, each with a struct in host memory, see ee-rt.h):
 *   EeInit      runtime + keys            EeLoad      model + context + threadpool
 *   EeGenerate  greedy completion         EeAttest    report over the binding transcript
 *   EeThread    host-entered thread body (never called by the host on its own) */
#include <windows.h>
#include <ntenclv.h>
typedef struct _TRUSTLET_BINDING_DATA *PTRUSTLET_BINDING_DATA;
#include <winenclaveapi.h>
#include <string>
#include <vector>
#include <cstring>
#include <cstdio>
#include "ee-rt.h"
#include "llama.h"
#include "ggml.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "ggml-shielded.h"
extern "C" {
#include "tweetnacl.h"
}
#include "shielded-sha256.h"

extern "C" const IMAGE_ENCLAVE_CONFIG __enclave_config = {
    sizeof(IMAGE_ENCLAVE_CONFIG), IMAGE_ENCLAVE_MINIMUM_CONFIG_SIZE,
    0,                        /* PolicyFlags: not debuggable */
    0, 0, 0,
    { 0xEC, 0x1A, 0x5E, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01 }, /* FamilyID: Enclave Host */
    { 0xEC, 0x1A, 0x5E, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01 }, /* ImageID: the shielded engine */
    0x00010000,               /* ImageVersion 1.0 */
    1,                        /* SecurityVersion */
    /* EnclaveSize 64 GB. It holds the model, its KV cache, the pads AND a tenant's app: the wasm
     * runtime interprets the app's linear memory out of this same range, and the platform's own
     * apps declare floors of a gigabyte and up (the s3-ipfs-adapter's is 1024 MB, an LLM app's is
     * 4096). This is a RESERVATION of the enclave's address space, not a commitment of the
     * machine's memory: VTL1 pages are committed as they are touched, so an enclave serving one
     * small app costs what that app uses, and the number here only decides the ceiling.
     * NOTE: the measurement does not change with this number - it is sha256 over the family,
     * image and author IDs above - so growing the enclave does not invalidate the registry row.
     * The machine has 111.8 GiB, so this leaves Windows and the shielded worker about 48. */
    0x1000000000ULL,
    64,                       /* NumberOfThreads: host-entered threads (refill pool + compute pool + callers) */
    IMAGE_ENCLAVE_FLAG_PRIMARY_IMAGE
};

static uint8_t g_sign_pk[32], g_sign_sk[64], g_box_pk[32], g_box_sk[32];
static bool g_inited = false, g_backends = false;
static llama_model *g_model; static llama_context *g_ctx; static const llama_vocab *g_vocab; static ggml_threadpool *g_tp;
static int g_n_batch = 512;

static void set_err(char *dst, const char *m) { strncpy(dst, m, 255); dst[255] = 0; }
static void log_cb(enum ggml_log_level lvl, const char *text, void *) {
    static bool all = ee_getenv("EE_LOG_ALL") != nullptr;
    if (all || lvl == GGML_LOG_LEVEL_WARN || lvl == GGML_LOG_LEVEL_ERROR) ee_write_log(text, strlen(text));
}

extern "C" __declspec(dllexport) void *WINAPI EeInit(void *param) {
    ee_init_params *p = (ee_init_params *)param;
    if (!p) return (void *)(intptr_t)-1;
    if (g_inited) { p->status = 0; memcpy(p->sign_pk, g_sign_pk, 32); memcpy(p->box_pk, g_box_pk, 32); return (void *)1; }
    const int rc = ee_rt_init(p);
    if (rc) { p->status = rc; set_err(p->error, "init parameters rejected"); return (void *)(intptr_t)-2; }
    crypto_sign_keypair(g_sign_pk, g_sign_sk);          /* Ed25519 transport key, this boot's identity */
    crypto_box_keypair(g_box_pk, g_box_sk);             /* X25519 pad key: seeds are boxed to it */
    memcpy(p->sign_pk, g_sign_pk, 32); memcpy(p->box_pk, g_box_pk, 32);
    g_inited = true; p->status = 0;
    ee_log("[enclave] runtime up: %u cpus, %u files, %u slots of %llu bytes\n", ee_cpu_count(), p->n_files, p->n_slots, (unsigned long long)p->slot_bytes);
    return (void *)1;
}
extern "C" __declspec(dllexport) void *WINAPI EeThread(void *param) { return g_inited ? ee_thread_entry(param) : (void *)(intptr_t)-1; }

extern "C" __declspec(dllexport) void *WINAPI EeLoad(void *param) {
    ee_load_params *p = (ee_load_params *)param;
    if (!p || !g_inited) return (void *)(intptr_t)-1;
    if (g_model) { p->status = 0; return (void *)1; }
    char name[260]; { const char *m = p->model; size_t k = 0; while (m && m[k] && k < 259) { name[k] = m[k]; k++; } name[k] = 0; }
    const int n_threads = p->n_threads > 0 && p->n_threads <= 64 ? p->n_threads : 4;
    const int n_ctx = p->n_ctx > 0 && p->n_ctx <= 32768 ? p->n_ctx : 1024;
    g_n_batch = p->n_batch > 0 && p->n_batch <= 4096 ? p->n_batch : 512;
    const int64_t t0 = ee_now_us();
    try {
        if (!g_backends) { ggml_backend_register(ggml_backend_shielded_reg()); llama_backend_init(); llama_log_set(log_cb, nullptr); g_backends = true; }
        p->n_devices = 0;
        for (size_t i = 0; i < ggml_backend_dev_count() && p->n_devices < 8; i++) { strncpy(p->devices[p->n_devices], ggml_backend_dev_name(ggml_backend_dev_get(i)), 63); p->devices[p->n_devices][63] = 0; p->n_devices++; }
        llama_model_params mp = llama_model_default_params(); mp.n_gpu_layers = 0; mp.load_mode = LLAMA_LOAD_MODE_NONE;
        llama_model *model = llama_model_load_from_file(name, mp);
        if (!model) { p->status = -2; set_err(p->error, "model load failed"); return (void *)(intptr_t)-2; }
        llama_context_params cp = llama_context_default_params();
        cp.n_ctx = n_ctx; cp.n_batch = g_n_batch; cp.n_threads = n_threads; cp.n_threads_batch = n_threads;
        llama_context *ctx = llama_init_from_model(model, cp);
        if (!ctx) { llama_model_free(model); p->status = -3; set_err(p->error, "context failed"); return (void *)(intptr_t)-3; }
        ggml_threadpool_params tpp = ggml_threadpool_params_default(n_threads);
        g_tp = ggml_threadpool_new(&tpp);
        if (g_tp) llama_attach_threadpool(ctx, g_tp, g_tp);
        g_model = model; g_ctx = ctx; g_vocab = llama_model_get_vocab(model);
        p->n_vocab = llama_vocab_n_tokens(g_vocab); p->n_embd = llama_model_n_embd(model); p->n_layer = llama_model_n_layer(model);
        p->load_us = ee_now_us() - t0; p->status = 0;
        ee_log("[enclave] model ready: %d layers, %d vocab, ctx %d, %d threads, %.1f s\n", p->n_layer, p->n_vocab, n_ctx, n_threads, p->load_us / 1e6);
        return (void *)1;
    } catch (const std::exception &e) { p->status = -9; set_err(p->error, e.what()); return (void *)(intptr_t)-9; }
      catch (...) { p->status = -10; set_err(p->error, "unknown exception"); return (void *)(intptr_t)-10; }
}

static int generate_text(const std::string &prompt, int n_predict_in, std::string &out, ee_session_params *st) {
    const int n_predict = n_predict_in > 0 && n_predict_in <= 4096 ? n_predict_in : 16;
    try {
        std::vector<llama_token> toks(prompt.size() + 16);
        int n = llama_tokenize(g_vocab, prompt.c_str(), (int)prompt.size(), toks.data(), (int)toks.size(), true, false);
        if (n < 0) { toks.resize((size_t)-n); n = llama_tokenize(g_vocab, prompt.c_str(), (int)prompt.size(), toks.data(), (int)toks.size(), true, false); }
        if (n <= 0 || n > g_n_batch) { set_err(st->error, "prompt does not fit one batch"); return -3; }
        llama_memory_clear(llama_get_memory(g_ctx), true);
        const int64_t t0 = ee_now_us();
        llama_batch batch = llama_batch_get_one(toks.data(), n);
        if (llama_decode(g_ctx, batch)) { set_err(st->error, "prompt decode failed"); return -4; }
        st->prompt_us = ee_now_us() - t0;
        int n_gen = 0; const int64_t t1 = ee_now_us(); int rc = 0;
        for (int i = 0; i < n_predict; i++) {
            const float *logits = llama_get_logits_ith(g_ctx, -1); const int n_vocab = llama_vocab_n_tokens(g_vocab);
            int best = 0; float bv = logits[0];
            for (int t = 1; t < n_vocab; t++) if (logits[t] > bv) { bv = logits[t]; best = t; }   /* greedy, first index on ties: the same rule as shielded-run */
            llama_token cur = best;
            if (llama_vocab_is_eog(g_vocab, cur)) break;
            char buf[256]; const int L = llama_token_to_piece(g_vocab, cur, buf, sizeof buf, 0, false);
            llama_batch b1 = llama_batch_get_one(&cur, 1);
            if (llama_decode(g_ctx, b1)) { set_err(st->error, "decode failed"); rc = -5; break; }
            if (L > 0) out.append(buf, (size_t)L);
            n_gen++;
        }
        st->decode_us = ee_now_us() - t1; st->n_tokens = n_gen;
        ggml_backend_shielded_stats(&st->offloaded, &st->local, &st->macs, &st->verify_fail);
        return rc;
    } catch (const std::exception &e) { set_err(st->error, e.what()); return -9; }
}
extern "C" __declspec(dllexport) void *WINAPI EeGenerate(void *param) {
    ee_gen_params *p = (ee_gen_params *)param;
    if (!p || !g_ctx) { if (p) { p->status = -1; set_err(p->error, "no model"); } return (void *)(intptr_t)-1; }
    if (!p->prompt || p->prompt_len == 0 || p->prompt_len > (1u << 20)) { p->status = -2; set_err(p->error, "prompt size"); return (void *)(intptr_t)-2; }
    std::string prompt((const char *)p->prompt, (size_t)p->prompt_len), text;   /* copied in: host memory is read once */
    ee_session_params st{}; const int rc = generate_text(prompt, p->n_predict, text, &st);
    p->n_tokens = st.n_tokens; p->prompt_us = st.prompt_us; p->decode_us = st.decode_us; p->offloaded = st.offloaded; p->local = st.local; p->macs = st.macs; p->verify_fail = st.verify_fail;
    if (rc && rc != -5) { p->status = rc; memcpy(p->error, st.error, sizeof p->error); return (void *)(intptr_t)rc; }
    const uint64_t cap = p->out_cap; const size_t k = text.size() < cap ? text.size() : (size_t)cap;
    if (p->out && cap) memcpy(p->out, text.data(), k); p->out_len = k; p->status = rc;
    return (void *)1;
}

/* A boxed session: the only path on which a prompt or an answer exists in the clear is inside VTL1. */
static int generate_text(const std::string &prompt, int n_predict, std::string &out, ee_session_params *st);
extern "C" __declspec(dllexport) void *WINAPI EeSession(void *param) {
    ee_session_params *p = (ee_session_params *)param;
    if (!p || !g_ctx) { if (p) { p->status = -1; set_err(p->error, "no model"); } return (void *)(intptr_t)-1; }
    if (!p->in || p->in_len < 32 + 24 + 16 + 4 || p->in_len > (1u << 20)) { p->status = -2; set_err(p->error, "session blob size"); return (void *)(intptr_t)-2; }
    std::vector<uint8_t> in(p->in, p->in + p->in_len);                       /* copied in: read once */
    const uint8_t *client_pk = in.data(), *nonce = in.data() + 32; const size_t clen = in.size() - 56;
    std::vector<uint8_t> c(16 + clen, 0), m(16 + clen, 0); memcpy(c.data() + 16, in.data() + 56, clen);   /* BOXZEROBYTES padding */
    if (crypto_box_open(m.data(), c.data(), (unsigned long long)c.size(), nonce, client_pk, g_box_sk) != 0) { p->status = -3; set_err(p->error, "session: box does not open (wrong key or tampered)"); return (void *)(intptr_t)-3; }
    const uint8_t *req = m.data() + 32; const size_t rlen = m.size() - 32;   /* ZEROBYTES padding */
    const int n_predict = (int)(req[0] | (req[1] << 8) | (req[2] << 16) | (req[3] << 24));
    std::string prompt((const char *)req + 4, rlen - 4), text;
    const int rc = generate_text(prompt, n_predict, text, p);
    if (rc) { p->status = rc; return (void *)(intptr_t)rc; }
    std::vector<uint8_t> reply(32 + 4 + text.size(), 0);
    reply[32] = (uint8_t)p->n_tokens; reply[33] = (uint8_t)(p->n_tokens >> 8); reply[34] = (uint8_t)(p->n_tokens >> 16); reply[35] = (uint8_t)(p->n_tokens >> 24);
    memcpy(reply.data() + 36, text.data(), text.size());
    uint8_t rn[24]; ee_random(rn, 24);
    std::vector<uint8_t> boxed(reply.size(), 0);
    crypto_box(boxed.data(), reply.data(), (unsigned long long)reply.size(), rn, client_pk, g_box_sk);
    const size_t olen = 24 + boxed.size() - 16;
    if (!p->out || p->out_cap < olen) { p->status = -4; set_err(p->error, "out buffer"); return (void *)(intptr_t)-4; }
    memcpy(p->out, rn, 24); memcpy(p->out + 24, boxed.data() + 16, boxed.size() - 16); p->out_len = olen; p->status = 0;
    return (void *)1;
}

/* The app runtime's `generate` import (ee-app.cpp): a tenant's app calling the model that lives in
 * this same enclave. The prompt and the completion exist in the clear only inside VTL1, and the
 * card underneath still only ever sees masked activations, so an app here gets the enclave's
 * inference without the enclave's model or its pads ever crossing to VTL0. */
extern "C" int ee_engine_generate(const char *prompt, size_t plen, int n_predict,
                                  char *out, size_t cap, size_t *out_len) {
    if (!g_ctx) return -1;
    if (!prompt || !plen || plen > (1u << 20) || !out || !cap || !out_len) return -2;
    std::string p(prompt, plen), text;
    ee_session_params st{};
    const int rc = generate_text(p, n_predict, text, &st);
    if (rc && rc != -5) return rc;
    const size_t k = text.size() < cap ? text.size() : cap;
    memcpy(out, text.data(), k);
    *out_len = k;
    return 0;
}

/* The binding transcript (windows/vbs/EVIDENCE.md): "enclave-vbs-bind-v1\n" || spki(44) || padKey(32) || nonce(32).
 * The enclave rebuilds the key part from ITS OWN keys and refuses anything else: the host cannot make
 * it attest a key it does not hold. challenge = sha256(bound) goes into the report's EnclaveData. */
static const uint8_t ED25519_SPKI_PREFIX[12] = { 0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00 };
extern "C" __declspec(dllexport) void *WINAPI EeAttest(void *param) {
    ee_attest_params *p = (ee_attest_params *)param;
    if (!p || !g_inited) return (void *)(intptr_t)-1;
    if (!p->bound || p->bound_len != 128) { p->status = -2; set_err(p->error, "bound must be 128 bytes"); return (void *)(intptr_t)-2; }
    uint8_t bound[128]; memcpy(bound, p->bound, 128);
    if (memcmp(bound, "enclave-vbs-bind-v1\n", 20) || memcmp(bound + 20, ED25519_SPKI_PREFIX, 12) || memcmp(bound + 32, g_sign_pk, 32) || memcmp(bound + 64, g_box_pk, 32)) {
        p->status = -3; set_err(p->error, "refused: the transcript does not name this enclave's own keys"); return (void *)(intptr_t)-3;
    }
    uint8_t challenge[32]; { sha256_ctx c; sha_init(&c); sha_update(&c, bound, 128); sha_final(&c, challenge); }
    uint8_t data[ENCLAVE_REPORT_DATA_LENGTH]; memset(data, 0, sizeof data); memcpy(data, challenge, 32);
    static uint8_t rep[16384]; UINT32 sz = 0;
    const HRESULT hr = EnclaveGetAttestationReport(data, rep, sizeof rep, &sz);
    p->hr = (int32_t)hr;
    if (FAILED(hr) || sz > sizeof rep) { p->status = -4; set_err(p->error, "EnclaveGetAttestationReport failed"); return (void *)(intptr_t)-4; }
    if (p->report && p->report_cap >= sz) memcpy(p->report, rep, sz);
    p->report_len = sz;
    uint8_t sm[128 + 64]; unsigned long long smlen = 0;
    crypto_sign(sm, &smlen, bound, 128, g_sign_sk);
    memcpy(p->signature, sm, 64); memcpy(p->challenge, challenge, 32);
    p->status = 0; return (void *)1;
}

BOOL WINAPI DllMain(HINSTANCE, DWORD, LPVOID) { return TRUE; }
