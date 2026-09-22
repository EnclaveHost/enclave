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
/* The WALL clock an app sees. The gate sets g_now_ms per request (the host read it as it called
 * in), but a SERVER runs between calls and still needs the date: a TLS handshake verifies a
 * certificate's validity window, and an enclave whose clock reads zero rejects every certificate
 * on earth as "not valid yet" - which is exactly how this was found, with rustls inside the
 * enclave refusing R2's certificate at verification time 0.
 *
 * So the fallback is the enclave's own reckoning: the host's unix time AT INIT plus the monotonic
 * time since (ee-rt.c keeps both). It cannot be steered by the host after init, and it is the same
 * clock the engine stamps its own work with. */
uint64_t ee_app_now_ms(void) {
    if (g_now_ms) return g_now_ms;
    return (uint64_t)ee_unix_time() * 1000ULL + (uint64_t)((ee_now_us() / 1000) % 1000);
}
/* The enclave's own monotonic microseconds (ee-rt.c, off the host clock at init plus the TSC):
 * a guest measuring an interval needs a clock that moves, and the wall clock above is only read
 * once per call. */
uint64_t ee_app_now_us(void) { return (uint64_t)ee_now_us(); }

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

/* Socket tracing for the app runtime, on when the enclave's environment says ENCLAVE_RT_TRACE=1
 * (the host passes it at init). It exists because an app that accepts a connection and drops it
 * silently - which is what a real one did here - is indistinguishable from a broken broker
 * without seeing each accept, read, write and close from inside. */
int ee_app_trace(void) {
    static int on = -1;
    if (on < 0) { const char *v = ee_getenv("ENCLAVE_RT_TRACE"); on = (v && (*v == '1' || *v == 't')) ? 1 : 0; }
    return on;
}

__declspec(noreturn) void ee_app_abort(const char *msg, size_t len) {
    std::string s(msg ? msg : "", msg ? len : 0);
    ee_fatal(s.c_str());                              /* logs, then stops: no unwinding in here */
    for (;;) { }
}

/* ---- the sockets a tenant's app gets --------------------------------------------------------
 * Thin wrappers over the enclave's call-out slot: every one of these hands the host a request and
 * reads back what it did. The host owns the socket; this side owns the TLS session that runs over
 * it, which is what keeps an app's traffic out of the host's reach even though the host carries
 * every byte of it.
 *
 * ee_slot() is per enclave thread, so a guest server thread and the gate never share a slot. */
int ee_net_listen(uint16_t port, uint16_t *bound) {
    ee_callout *c = ee_slot();
    c->op = EE_OP_LISTEN; c->handle = 0; c->len = 0; c->arg = port;
    const int64_t r = ee_callout_call(c);
    if (r >= 0 && bound) *bound = (uint16_t)c->arg;
    return (int)r;
}
int ee_net_accept(int h) {
    ee_callout *c = ee_slot();
    c->op = EE_OP_ACCEPT; c->handle = (uint32_t)h; c->len = 0; c->arg = 0;
    return (int)ee_callout_call(c);
}
int ee_net_connect(const char *addr, uint16_t port) {
    ee_callout *c = ee_slot();
    const size_t n = strlen(addr);
    if (n + 1 > c->cap) return -22;
    c->op = EE_OP_CONNECT; c->handle = 0; c->arg = port; c->len = n + 1;
    memcpy(c->data, addr, n + 1);
    return (int)ee_callout_call(c);
}
int64_t ee_net_send(int h, const uint8_t *p, size_t n) {
    ee_callout *c = ee_slot();
    size_t done = 0;
    while (done < n) {
        size_t k = n - done; if (k > c->cap) k = (size_t)c->cap;
        c->op = EE_OP_SEND; c->handle = (uint32_t)h; c->len = k;
        memcpy(c->data, p + done, k);
        const int64_t r = ee_callout_call(c);
        if (r < 0) return done ? (int64_t)done : r;
        done += (size_t)r;
        if ((size_t)r < k) break;                      /* the host took less: let the guest retry */
    }
    return (int64_t)done;
}
int64_t ee_net_recv(int h, uint8_t *p, size_t n) {
    ee_callout *c = ee_slot();
    size_t k = n > c->cap ? (size_t)c->cap : n;
    c->op = EE_OP_RECV; c->handle = (uint32_t)h; c->len = k;
    const int64_t r = ee_callout_call(c);
    if (r > 0) memcpy(p, c->data, (size_t)r);
    return r;
}
void ee_net_close(int h) {
    ee_callout *c = ee_slot();
    c->op = EE_OP_CLOSE; c->handle = (uint32_t)h; c->len = 0;
    ee_callout_call(c);
}
int ee_net_poll(uint32_t *handles, uint32_t *events, size_t n, uint32_t timeout_ms) {
    if (!n || n > 64) return -22;
    ee_callout *c = ee_slot();
    if (n * sizeof(ee_poll_item) > c->cap) return -22;
    ee_poll_item *it = (ee_poll_item *)c->data;
    for (size_t i = 0; i < n; i++) { it[i].handle = handles[i]; it[i].events = events[i]; }
    c->op = EE_OP_POLL; c->handle = 0; c->len = n * sizeof(ee_poll_item); c->arg = timeout_ms;
    const int64_t r = ee_callout_call(c);
    for (size_t i = 0; i < n; i++) events[i] = it[i].events;       /* what is actually ready */
    return (int)r;
}
int ee_net_resolve(const char *name, char *out, size_t cap) {
    ee_callout *c = ee_slot();
    const size_t n = strlen(name);
    if (n + 1 > c->cap) return -22;
    c->op = EE_OP_RESOLVE; c->handle = 0; c->len = n; c->arg = 0;
    memcpy(c->data, name, n);
    const int64_t r = ee_callout_call(c);
    if (r > 0) { const size_t k = (size_t)r < cap ? (size_t)r : cap; memcpy(out, c->data, k); return (int)k; }
    return (int)r;
}

/* ---- the runtime, from windows/enclave-rt ------------------------------------------------- */
unsigned int ee_rt_open(const unsigned char *cwasm, size_t len, unsigned int world,
                        const unsigned char *env, size_t env_len);
unsigned int ee_rt_worlds(void);
unsigned int ee_rt_features(void);   /* 1 mem64 | 2 set | 4 p3 | 8 coop threads */
int          ee_rt_run(unsigned int id);
int          ee_rt_stop(unsigned int id);
void         ee_tls_release(void);       /* the app thread's wasmtime TLS row (ee-platform.c) */
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
    /* 64 MB was enough until risc-box: a 23.7 MB wasm64 + SET component compiles to 85 MB of
     * Pulley bytecode, because an interpreter's encoding is bigger than machine code and this
     * artifact carries a whole RISC-V machine. The bytecode is copied INTO the enclave, so the
     * ceiling is really about the app budget - which is 63 GB here - not about 64 MB. */
    if (!p->cwasm || p->cwasm_len < 64 || p->cwasm_len > (512u << 20)) {
        p->status = -2; snprintf(p->error, sizeof p->error, "bytecode size"); return (void *)(intptr_t)-2;
    }
    const unsigned int world = p->world ? p->world : EE_WORLD_ENCLAVE;
    if (!(ee_rt_worlds() & world)) {
        p->status = -5; snprintf(p->error, sizeof p->error, "this enclave's runtime does not serve world %u", world);
        return (void *)(intptr_t)-5;
    }
    const int64_t t0 = ee_now_us();
    std::vector<unsigned char> bytes, envv;
    try {
        bytes.assign(p->cwasm, p->cwasm + p->cwasm_len);
        if (p->env && p->env_len && p->env_len < (1u << 20)) envv.assign(p->env, p->env + p->env_len);
    }
    catch (...) { p->status = -3; snprintf(p->error, sizeof p->error, "out of enclave memory for %llu bytes",
                                           (unsigned long long)p->cwasm_len); return (void *)(intptr_t)-3; }
    const unsigned int id = ee_rt_open(bytes.data(), bytes.size(), world,
                                       envv.empty() ? NULL : envv.data(), envv.size());
    p->load_us = ee_now_us() - t0;
    if (!id) { p->status = -4; app_err(p->error, "the runtime refused the bytecode"); return (void *)(intptr_t)-4; }
    p->id = id; p->status = 0;
    ee_log("[app] loaded app %u (world %u), %llu bytes of bytecode, in %lld us\n",
           id, world, (unsigned long long)bytes.size(), (long long)p->load_us);
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

/* Run a server-shaped app, here, until it is stopped. The host enters this on its own thread (it
 * spawns one and calls in); the call does not come back until the guest traps or returns, so this
 * is the one enclave entry point that is expected to sit for hours. */
__declspec(dllexport) void *WINAPI EeAppRun(void *param) {
    ee_app_run_params *p = (ee_app_run_params *)param;
    if (!p) return (void *)(intptr_t)-1;
    const int64_t t0 = ee_now_us();
    ee_log("[app] running app %u (it serves its own socket)\n", p->id);
    const int rc = ee_rt_run(p->id);
    /* This thread is about to leave the enclave for good, so its TLS row goes back: a row that is
     * never released is gone for the life of the enclave, and the table running dry takes the
     * whole enclave down (ee-platform.c ee_tls_release says how that was found). */
    ee_tls_release();
    p->ran_us = ee_now_us() - t0;
    p->status = rc;
    if (rc) app_err(p->error, "the app stopped");
    ee_log("[app] app %u stopped after %lld us: %s\n", p->id, (long long)p->ran_us,
           rc ? p->error : "run() returned");
    return (void *)(intptr_t)(rc ? rc : 1);
}

/* Ask a running app to stop. Returns at once: the guest traps at its next check and its own thread
 * does the unwinding and the freeing. */
__declspec(dllexport) void *WINAPI EeAppStop(void *param) {
    ee_app_close_params *p = (ee_app_close_params *)param;
    if (!p) return (void *)(intptr_t)-1;
    p->status = ee_rt_stop(p->id);
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
/* param (optional): [0] = abi, [1] = the worlds bitmask this runtime serves, [2] = the WASM
 * FEATURES it enables (mem64 / set / p3 / cooperative threads). The node publishes its platform
 * capability flags off [2] and nothing else, so what the box advertises is what the image does. */
__declspec(dllexport) void *WINAPI EeAppAbi(void *param) {
    if (param) {
        uint32_t *o = (uint32_t *)param;
        /* How many words does the CALLER own? A host that knows this handshake says so; one that
         * predates it passed a zeroed buffer of exactly two, and gets exactly two. Writing a third
         * word into a two-word buffer would be an out-of-bounds store into the host's stack - see
         * EE_ABI_QUERY_MAGIC in ee-rt.h. */
        const uint32_t cap = (o[0] == EE_ABI_QUERY_MAGIC && o[1] >= 2) ? o[1] : 2;
        const uint32_t vals[3] = { ee_rt_abi(), ee_rt_worlds(), ee_rt_features() };
        const uint32_t n = cap < 3 ? cap : 3;
        for (uint32_t i = 0; i < n; i++) o[i] = vals[i];
    }
    return (void *)(intptr_t)ee_rt_abi();
}

} /* extern "C" */
