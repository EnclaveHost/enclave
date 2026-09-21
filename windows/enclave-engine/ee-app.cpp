/* ee-app.cpp -- a tenant's app, running INSIDE the enclave.
 *
 * The runtime is windows/enclave-rt (wasmtime, no_std, interpreting Pulley bytecode); this file is
 * the enclave-side glue: the three CallEnclave entry points the host drives, and the four host
 * functions the app's world (enclave:app) is allowed to call.
 *
 * WHY THIS SHAPE. VTL1 has no sockets, so the app cannot be a server. VTL0 owns the socket, reads
 * one request, and calls in with the bytes; the app's code, its memory and its model calls stay in
 * here. Everything that crosses is a length-prefixed frame in HOST memory, copied in before it is
 * looked at (the host can change its own memory under us at any time, so nothing is read twice).
 *
 * What this does NOT claim: the request and the response are in the clear on the VTL0 side, which
 * carries them. The tenant's code and memory are protected from the Windows session; their traffic
 * is seen by the agent carrying it, exactly as the platform's relay sees it for every other box.
 */
#include <windows.h>
#include <string>
#include <vector>
#include <cstring>
#include <cstdio>
#include "ee-rt.h"

extern "C" {

/* ---- what the app may ask of the enclave (the imports in wit/app.wit) ---------------------- */
/* The clock the HOST read when it called in. VTL1 has no clock of its own: the enclave cannot
 * measure wall time, and inventing one would be worse than passing the host's number through and
 * saying where it came from. Per-call, so an app cannot cache a stale one. */
static uint64_t g_now_ms;
uint64_t ee_app_now_ms(void) { return g_now_ms; }

int ee_app_random(unsigned char *out, unsigned int len) {
    return ee_random(out, len) == 0 ? 0 : -1;        /* the enclave's own source, as for the keys */
}

/* The app's log line, out through the same call-out the engine's own log uses: the host writes it
 * to this deployment's log, which the operator and the tenant both read. A line an app writes is
 * a line it CHOSE to reveal, so this is not a leak of enclave state. */
void ee_app_log(const char *p, size_t len) {
    if (!p || !len) return;
    std::string s(p, len);
    ee_log("[app] %s\n", s.c_str());
}

/* THE MODEL, without leaving the enclave. ee_engine_generate is the engine in this same image
 * (ee-main.cpp): the prompt never crosses into VTL0, the completion never crosses into VTL0, and
 * the untrusted card still only ever sees masked activations. This is the one host function that
 * is a product rather than plumbing. */
int ee_app_generate(const char *prompt, size_t plen, unsigned int max_tokens,
                    char *out, size_t cap, size_t *out_len) {
    return ee_engine_generate(prompt, plen, (int)max_tokens, out, cap, out_len);
}

__declspec(noreturn) void ee_app_abort(const char *msg, size_t len) {
    std::string s(msg ? msg : "", msg ? len : 0);
    ee_fatal(s.c_str());                              /* logs, then stops: no unwinding in here */
    for (;;) { }
}

/* ---- the runtime, from windows/enclave-rt ------------------------------------------------- */
unsigned int ee_rt_open(const unsigned char *cwasm, size_t len);
int          ee_rt_handle(unsigned int id, const unsigned char *req, size_t req_len,
                          unsigned char *out, size_t out_cap, size_t *out_len);
int          ee_rt_close(unsigned int id);
size_t       ee_rt_last_error(unsigned char *out, size_t cap);
unsigned int ee_rt_abi(void);

static void app_err(char *dst, const char *fallback) {
    unsigned char buf[256];
    const size_t n = ee_rt_last_error(buf, sizeof buf - 1);
    if (n) { buf[n] = 0; snprintf(dst, 256, "%s", (const char *)buf); }
    else snprintf(dst, 256, "%s", fallback);
}

/* Load an app. The bytecode is COPIED into enclave memory first: after this returns the host may
 * do what it likes with its own buffer, and the app that runs in here is the one that was read. */
__declspec(dllexport) void *WINAPI EeAppOpen(void *param) {
    ee_app_open_params *p = (ee_app_open_params *)param;
    if (!p) return (void *)(intptr_t)-1;
    p->id = 0;
    if (!p->cwasm || p->cwasm_len < 64 || p->cwasm_len > (64u << 20)) {
        p->status = -2; snprintf(p->error, sizeof p->error, "bytecode size"); return (void *)(intptr_t)-2;
    }
    const int64_t t0 = ee_now_us();
    std::vector<unsigned char> bytes;
    try { bytes.assign(p->cwasm, p->cwasm + p->cwasm_len); }
    catch (...) { p->status = -3; snprintf(p->error, sizeof p->error, "out of enclave memory for %llu bytes",
                                           (unsigned long long)p->cwasm_len); return (void *)(intptr_t)-3; }
    const unsigned int id = ee_rt_open(bytes.data(), bytes.size());
    p->load_us = ee_now_us() - t0;
    if (!id) { p->status = -4; app_err(p->error, "the runtime refused the bytecode"); return (void *)(intptr_t)-4; }
    p->id = id; p->status = 0;
    ee_log("[app] loaded app %u, %llu bytes of bytecode, in %lld us\n",
           id, (unsigned long long)bytes.size(), (long long)p->load_us);
    return (void *)1;
}

/* One request. Both frames live in host memory; the request is copied in, the response is copied
 * out, and the app's own memory is never handed to VTL0. */
__declspec(dllexport) void *WINAPI EeAppHandle(void *param) {
    ee_app_params *p = (ee_app_params *)param;
    if (!p) return (void *)(intptr_t)-1;
    if (!p->req || p->req_len < 12 || p->req_len > (16u << 20)) {
        p->status = -2; snprintf(p->error, sizeof p->error, "request frame size"); return (void *)(intptr_t)-2;
    }
    g_now_ms = p->now_ms;                              /* the host's clock, for this call only */
    const int64_t t0 = ee_now_us();
    /* PERSISTENT staging buffers, grown and never shrunk. Allocating the host's whole out_cap per
     * call cost 50-70 ms a request: an enclave's heap has to commit VTL1 pages and zero them, and
     * a 4 MB response buffer per hello-world reply is 4 MB of that every time. The buffers hold
     * one request at a time because the gate admits one call per app. */
    static std::vector<unsigned char> req, out;
    try {
        if (req.capacity() < (size_t)p->req_len) req.reserve((size_t)p->req_len + 4096);
        req.assign(p->req, p->req + p->req_len);
        const size_t want = p->out_cap ? (size_t)p->out_cap : 1;
        const size_t stage = want < (256u << 10) ? want : (256u << 10);   /* start modest; grow if the app answers big */
        if (out.size() < stage) out.resize(stage);
    }
    catch (...) { p->status = -3; snprintf(p->error, sizeof p->error, "out of enclave memory"); return (void *)(intptr_t)-3; }
    size_t olen = 0;
    int rc = ee_rt_handle(p->id, req.data(), req.size(), out.data(), out.size(), &olen);
    if (rc == -5 && olen > out.size() && olen <= (p->out_cap ? (size_t)p->out_cap : 0)) {
        /* The app answered with more than the staging buffer held, and the host has room for it:
         * grow once and run it again. The runtime reports the size it needed rather than
         * truncating, which is what makes a second try correct instead of a guess. */
        try { out.resize(olen); } catch (...) { p->status = -3; snprintf(p->error, sizeof p->error, "out of enclave memory"); return (void *)(intptr_t)-3; }
        rc = ee_rt_handle(p->id, req.data(), req.size(), out.data(), out.size(), &olen);
    }
    p->handle_us = ee_now_us() - t0;
    if (rc != 0) {
        p->status = rc;
        p->out_len = olen;                             /* rc -5: how much room the response needed */
        app_err(p->error, rc == -2 ? "no such app in this enclave" : "the app did not answer");
        return (void *)(intptr_t)rc;
    }
    if (p->out && olen <= p->out_cap) memcpy(p->out, out.data(), olen);
    p->out_len = olen; p->status = 0;
    return (void *)1;
}

__declspec(dllexport) void *WINAPI EeAppClose(void *param) {
    ee_app_close_params *p = (ee_app_close_params *)param;
    if (!p) return (void *)(intptr_t)-1;
    p->status = ee_rt_close(p->id);
    if (p->status == 0) ee_log("[app] unloaded app %u\n", p->id);
    return (void *)1;
}

/* Does this enclave image carry an app runtime, and which ABI? The host publishes it, so a row
 * can only advertise in-enclave app hosting from an image that actually has one. */
__declspec(dllexport) void *WINAPI EeAppAbi(void *param) {
    if (param) *(uint32_t *)param = ee_rt_abi();
    return (void *)(intptr_t)ee_rt_abi();
}

} /* extern "C" */
