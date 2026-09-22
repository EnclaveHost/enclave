/* ee-host.c -- the VTL0 half of the enclave engine: untrusted plumbing.
 * Loads ee-engine.dll into a VBS enclave, hands it the model bytes, the calibration and the
 * environment (all host memory the enclave reads directly), serves its call-outs (log, thread
 * entry, the worker's TCP socket), and offers the engine either on the command line or as a
 * line-protocol server on loopback for the node agent (windows/node/agent.mjs):
 *   keys                     -> ok <sign_pk hex> <box_pk hex>
 *   attest <bound hex>       -> ok <challenge hex> <signature hex> <report hex>
 *   gen <n> <prompt hex>     -> ok <text hex> <tokens> <prompt_us> <decode_us> <offloaded> <local> <macs> <verify_fail>
 *   session <blob hex>       -> ok <blob hex> <tokens> ... (a boxed request, see ee-rt.h; the host never sees the text)
 *   ping                     -> ok
 * It never sees an activation, a pad or a private key: those live in VTL1. */
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <enclaveapi.h>
#include <ntenclv.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <psapi.h>
#include "ee-rt.h"
#pragma comment(lib, "ws2_32.lib")

static LPVOID g_base; static FARPROC g_EeInit, g_EeThread, g_EeLoad, g_EeGenerate, g_EeAttest, g_EeSession;
/* the app runtime's entry points. Optional on purpose: an older enclave image has no app runtime,
 * and the host says so rather than failing to start. */
static FARPROC g_EeAppOpen, g_EeAppHandle, g_EeAppClose, g_EeAppAbi, g_EeAppRun, g_EeAppStop;
static FILE *g_logf; static CRITICAL_SECTION g_log_cs;
static SOCKET g_socks[256]; static CRITICAL_SECTION g_sock_cs;
static int g_quiet;

static void say(const char *fmt, ...) { va_list ap; va_start(ap, fmt); vfprintf(stderr, fmt, ap); va_end(ap); fflush(stderr); }
static int64_t now_us(void) { static LARGE_INTEGER f; LARGE_INTEGER c; if (!f.QuadPart) QueryPerformanceFrequency(&f); QueryPerformanceCounter(&c); return (int64_t)(c.QuadPart * 1000000.0 / f.QuadPart); }

/* ---- the call-out: the enclave's only way out ------------------------------------------ */
static DWORD WINAPI thr_enter(LPVOID p) { LPVOID r = NULL; if (!CallEnclave((LPENCLAVE_ROUTINE)g_EeThread, p, TRUE, &r)) say("[host] EeThread entry failed: %lu\n", GetLastError()); return 0; }
/* Winsock errors as the errno numbers the enclave side expects. WSAEWOULDBLOCK -> EAGAIN is
 * load-bearing now that a tenant's app uses NON-BLOCKING sockets: without it "no data yet" arrives
 * in the guest as a hard I/O error, and an app that treats that as a dead peer drops the
 * connection it was about to answer. The engine's own socket never hit this because it is
 * blocking. */
static int wsa_errno(void) {
    switch (WSAGetLastError()) {
    case WSAEWOULDBLOCK: return 11;      /* EAGAIN: ask again, nothing is wrong */
    case WSAEINPROGRESS: return 115;     /* EINPROGRESS: a connect still going */
    case WSAECONNREFUSED: return 111;
    case WSAETIMEDOUT: return 110;
    case WSAECONNRESET: return 104;
    case WSAECONNABORTED: return 103;
    case WSAENOTCONN: return 107;
    case WSAEHOSTUNREACH: return 113;
    case WSAENETUNREACH: return 101;
    case WSAEADDRINUSE: return 98;
    case WSAEMFILE: return 24;
    default: return 5;
    }
}
static void *WINAPI host_callout(void *param) {
    ee_callout *c = (ee_callout *)param;
    switch (c->op) {
    case EE_OP_LOG: {
        EnterCriticalSection(&g_log_cs);
        if (!g_quiet) fwrite(c->data, 1, (size_t)c->len, stderr);
        if (g_logf) { fwrite(c->data, 1, (size_t)c->len, g_logf); fflush(g_logf); }
        LeaveCriticalSection(&g_log_cs); c->ret = 0; break; }
    case EE_OP_SPAWN: {
        HANDLE h = CreateThread(NULL, 4u << 20, thr_enter, (LPVOID)(uintptr_t)c->arg, 0, NULL);
        if (!h) { c->ret = -11; break; } CloseHandle(h); c->ret = 0; break; }
    case EE_OP_CONNECT: {
        char host[256]; size_t n = c->len < sizeof host ? (size_t)c->len : sizeof host - 1; memcpy(host, c->data, n); host[n] = 0;
        char port[16]; snprintf(port, sizeof port, "%llu", (unsigned long long)c->arg);
        struct addrinfo hints, *res = NULL; memset(&hints, 0, sizeof hints); hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
        if (getaddrinfo(host, port, &hints, &res)) { c->ret = -113; break; }
        SOCKET s = INVALID_SOCKET;
        for (struct addrinfo *a = res; a; a = a->ai_next) { s = socket(a->ai_family, a->ai_socktype, a->ai_protocol); if (s == INVALID_SOCKET) continue; if (connect(s, a->ai_addr, (int)a->ai_addrlen) == 0) break; closesocket(s); s = INVALID_SOCKET; }
        freeaddrinfo(res);
        if (s == INVALID_SOCKET) { c->ret = -wsa_errno(); break; }
        BOOL one = TRUE; setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof one);
        EnterCriticalSection(&g_sock_cs); int idx = -1; for (int i = 1; i < 256; i++) if (g_socks[i] == 0) { g_socks[i] = s; idx = i; break; } LeaveCriticalSection(&g_sock_cs);
        if (idx < 0) { closesocket(s); c->ret = -24; break; }
        c->ret = idx; break; }
    case EE_OP_SEND: {
        SOCKET s = c->handle < 256 ? g_socks[c->handle] : 0; if (!s) { c->ret = -9; break; }
        size_t done = 0;
        while (done < c->len) {
            const int r = send(s, (const char *)c->data + done, (int)(c->len - done), 0);
            if (r > 0) { done += (size_t)r; continue; }
            /* A FULL SEND BUFFER IS NOT A FAILURE, and reporting it as a short write was: WASI has
             * no partial-write answer, so the guest turned it into a failed stream and closed the
             * connection mid-response. A 400 KB body came back a different length every time.
             * Wait for writability here - the app's socket is non-blocking for READS, which is
             * what a server's event loop needs; a write either completes or fails. */
            if (WSAGetLastError() == WSAEWOULDBLOCK) {
                fd_set wr; FD_ZERO(&wr); FD_SET(s, &wr);
                struct timeval tv; tv.tv_sec = 30; tv.tv_usec = 0;
                if (select(0, NULL, &wr, NULL, &tv) > 0) continue;
            }
            c->ret = done ? (int64_t)done : -wsa_errno();
            goto out;
        }
        c->ret = (int64_t)done; break; }
    case EE_OP_RECV: {
        SOCKET s = c->handle < 256 ? g_socks[c->handle] : 0; if (!s) { c->ret = -9; break; }
        int r = recv(s, (char *)c->data, (int)(c->len < c->cap ? c->len : c->cap), 0);
        c->ret = r < 0 ? -wsa_errno() : r; break; }
    case EE_OP_CLOSE: {
        SOCKET s = c->handle < 256 ? g_socks[c->handle] : 0; if (s) { closesocket(s); g_socks[c->handle] = 0; } c->ret = 0; break; }
    /* ---- the tenant app's sockets. The host owns them; the guest never sees one ----------- */
    case EE_OP_LISTEN: {
        /* LOOPBACK ONLY, deliberately: an app inside the enclave is reached through this node's
         * own proxy (the relay's /x/<id> path), never from the network directly, so there is no
         * reason to expose a port on the machine and every reason not to. */
        SOCKET ls = socket(AF_INET, SOCK_STREAM, 0);
        if (ls == INVALID_SOCKET) { c->ret = -wsa_errno(); break; }
        struct sockaddr_in a; memset(&a, 0, sizeof a);
        a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK); a.sin_port = htons((u_short)c->arg);
        BOOL one = TRUE; setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, (const char *)&one, sizeof one);
        if (bind(ls, (struct sockaddr *)&a, sizeof a) || listen(ls, 64)) { int e = wsa_errno(); closesocket(ls); c->ret = -e; break; }
        int alen = sizeof a;
        if (getsockname(ls, (struct sockaddr *)&a, &alen) == 0) c->arg = ntohs(a.sin_port);   /* the port it actually got */
        u_long nb = 1; ioctlsocket(ls, FIONBIO, &nb);              /* accept must not block the enclave's thread */
        EnterCriticalSection(&g_sock_cs); int li = -1; for (int i = 1; i < 256; i++) if (g_socks[i] == 0) { g_socks[i] = ls; li = i; break; } LeaveCriticalSection(&g_sock_cs);
        if (li < 0) { closesocket(ls); c->ret = -24; break; }
        say("[host] app listening on 127.0.0.1:%llu (handle %d)\n", (unsigned long long)c->arg, li);
        c->ret = li; break; }
    case EE_OP_ACCEPT: {
        SOCKET ls = c->handle < 256 ? g_socks[c->handle] : 0; if (!ls) { c->ret = -9; break; }
        SOCKET cs = accept(ls, NULL, NULL);
        if (cs == INVALID_SOCKET) { c->ret = WSAGetLastError() == WSAEWOULDBLOCK ? -11 : -wsa_errno(); break; }
        BOOL one = TRUE; setsockopt(cs, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof one);
        u_long nb = 1; ioctlsocket(cs, FIONBIO, &nb);              /* the guest polls; it never blocks in here */
        EnterCriticalSection(&g_sock_cs); int ci = -1; for (int i = 1; i < 256; i++) if (g_socks[i] == 0) { g_socks[i] = cs; ci = i; break; } LeaveCriticalSection(&g_sock_cs);
        if (ci < 0) { closesocket(cs); c->ret = -24; break; }
        c->ret = ci; break; }
    case EE_OP_POLL: {
        /* This is how a guest thread WAITS. Without it the guest spins on would-block and burns
         * an enclave thread at 100% while it serves nothing. */
        ee_poll_item *it = (ee_poll_item *)c->data;
        const size_t n = (size_t)(c->len / sizeof *it);
        if (!n || n > 64) { c->ret = -22; break; }
        fd_set rd, wr; FD_ZERO(&rd); FD_ZERO(&wr);
        for (size_t i = 0; i < n; i++) {
            SOCKET s = it[i].handle < 256 ? g_socks[it[i].handle] : 0;
            if (!s) continue;
            if (it[i].events & EE_POLL_READ) FD_SET(s, &rd);
            if (it[i].events & EE_POLL_WRITE) FD_SET(s, &wr);
        }
        struct timeval tv; tv.tv_sec = (long)(c->arg / 1000); tv.tv_usec = (long)((c->arg % 1000) * 1000);
        const int r = select(0, &rd, &wr, NULL, c->arg == 0xFFFFFFFFu ? NULL : &tv);
        if (r < 0) { c->ret = -wsa_errno(); break; }
        int ready = 0;
        for (size_t i = 0; i < n; i++) {
            SOCKET s = it[i].handle < 256 ? g_socks[it[i].handle] : 0;
            uint32_t got = 0;
            if (s) { if (FD_ISSET(s, &rd)) got |= EE_POLL_READ; if (FD_ISSET(s, &wr)) got |= EE_POLL_WRITE; }
            it[i].events = got;                                    /* written back for the guest */
            if (got) ready++;
        }
        c->ret = ready; break; }
    case EE_OP_RESOLVE: {
        /* DNS is the host's: it has the resolver and the network. What it learns is the NAME the
         * app is looking up, which is metadata the host can see anyway from the connection it
         * carries; what it does not get is the session, which the guest terminates itself. */
        char host[256]; size_t n = c->len < sizeof host ? (size_t)c->len : sizeof host - 1;
        memcpy(host, c->data, n); host[n] = 0;
        struct addrinfo hints, *res = NULL; memset(&hints, 0, sizeof hints);
        hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
        if (getaddrinfo(host, NULL, &hints, &res)) { c->ret = -113; break; }
        size_t off = 0;
        for (struct addrinfo *a = res; a && off + 64 < c->cap; a = a->ai_next) {
            char txt[64] = { 0 };
            if (a->ai_family == AF_INET) InetNtopA(AF_INET, &((struct sockaddr_in *)a->ai_addr)->sin_addr, txt, sizeof txt);
            else if (a->ai_family == AF_INET6) InetNtopA(AF_INET6, &((struct sockaddr_in6 *)a->ai_addr)->sin6_addr, txt, sizeof txt);
            else continue;
            const size_t k = strlen(txt);
            memcpy((char *)c->data + off, txt, k); off += k; ((char *)c->data)[off++] = '\n';
        }
        freeaddrinfo(res);
        c->ret = (int64_t)off; break; }
    default: c->ret = -22;
    }
out:
    return NULL;
}

/* ---- files into host memory --------------------------------------------------------------- */
static uint8_t *read_file(const char *path, uint64_t *len) {
    HANDLE h = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (h == INVALID_HANDLE_VALUE) return NULL;
    LARGE_INTEGER sz; GetFileSizeEx(h, &sz); uint8_t *p = (uint8_t *)VirtualAlloc(NULL, (SIZE_T)sz.QuadPart + 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!p) { CloseHandle(h); return NULL; }
    uint64_t off = 0; while (off < (uint64_t)sz.QuadPart) { DWORD got = 0; DWORD want = (DWORD)((sz.QuadPart - off) > (64u << 20) ? (64u << 20) : (sz.QuadPart - off)); if (!ReadFile(h, p + off, want, &got, NULL) || !got) break; off += got; }
    CloseHandle(h); *len = off; return p;
}
static const char *basename_of(const char *p) { const char *b = p; for (const char *q = p; *q; q++) if (*q == '/' || *q == '\\') b = q + 1; return b; }
static void hex(char *dst, const uint8_t *p, size_t n) { static const char *H = "0123456789abcdef"; for (size_t i = 0; i < n; i++) { dst[2 * i] = H[p[i] >> 4]; dst[2 * i + 1] = H[p[i] & 15]; } dst[2 * n] = 0; }
static int unhex(uint8_t *dst, size_t cap, const char *s, size_t *out) { size_t n = strlen(s); if (n & 1 || n / 2 > cap) return -1; for (size_t i = 0; i < n; i += 2) { int a, b; if (sscanf(s + i, "%1x%1x", &a, &b) != 2) return -1; dst[i / 2] = (uint8_t)((a << 4) | b); } *out = n / 2; return 0; }

/* ---- enclave lifecycle -------------------------------------------------------------------- */
static int start_enclave(const wchar_t *dll, SIZE_T size, DWORD threads) {
    if (!IsEnclaveTypeSupported(ENCLAVE_TYPE_VBS)) { say("[host] VBS enclaves are not supported on this machine\n"); return -1; }
    ENCLAVE_CREATE_INFO_VBS ci; memset(&ci, 0, sizeof ci); memset(ci.OwnerID, 0xEC, sizeof ci.OwnerID);
    DWORD err = 0;
    g_base = CreateEnclave(GetCurrentProcess(), NULL, size, 0, ENCLAVE_TYPE_VBS, &ci, sizeof ci, &err);
    if (!g_base) { say("[host] CreateEnclave failed: enclaveError=0x%08lx lastError=%lu\n", err, GetLastError()); return -2; }
    if (!LoadEnclaveImageW(g_base, dll)) { say("[host] LoadEnclaveImageW failed: %lu (signing? test signing on? the DLL beside the host?)\n", GetLastError()); return -3; }
    ENCLAVE_INIT_INFO_VBS ii; ii.Length = sizeof ii; ii.ThreadCount = threads;
    if (!InitializeEnclave(GetCurrentProcess(), g_base, &ii, sizeof ii, &err)) { say("[host] InitializeEnclave failed: enclaveError=0x%08lx lastError=%lu\n", err, GetLastError()); return -4; }
    g_EeInit = GetProcAddress((HMODULE)g_base, "EeInit"); g_EeThread = GetProcAddress((HMODULE)g_base, "EeThread");
    g_EeLoad = GetProcAddress((HMODULE)g_base, "EeLoad"); g_EeGenerate = GetProcAddress((HMODULE)g_base, "EeGenerate"); g_EeAttest = GetProcAddress((HMODULE)g_base, "EeAttest"); g_EeSession = GetProcAddress((HMODULE)g_base, "EeSession");
    g_EeAppOpen = GetProcAddress((HMODULE)g_base, "EeAppOpen"); g_EeAppHandle = GetProcAddress((HMODULE)g_base, "EeAppHandle");
    g_EeAppClose = GetProcAddress((HMODULE)g_base, "EeAppClose"); g_EeAppAbi = GetProcAddress((HMODULE)g_base, "EeAppAbi");
    g_EeAppRun = GetProcAddress((HMODULE)g_base, "EeAppRun"); g_EeAppStop = GetProcAddress((HMODULE)g_base, "EeAppStop");
    if (!g_EeInit || !g_EeThread || !g_EeLoad || !g_EeGenerate || !g_EeAttest) { say("[host] exports missing\n"); return -5; }
    return 0;
}
static int call(FARPROC fn, void *param) { LPVOID r = NULL; if (!CallEnclave((LPENCLAVE_ROUTINE)fn, param, TRUE, &r)) { say("[host] CallEnclave failed: %lu\n", GetLastError()); return -1; } return 0; }

static ee_init_params g_init; static uint8_t g_sign_pk[32], g_box_pk[32];
static int do_attest(const uint8_t *bound, size_t bound_len, uint8_t *report, size_t rcap, size_t *rlen, uint8_t sig[64], uint8_t chal[32], char *err) {
    ee_attest_params *a = (ee_attest_params *)calloc(1, sizeof *a); a->size = sizeof *a; a->bound = bound; a->bound_len = bound_len; a->report = report; a->report_cap = rcap;
    if (call(g_EeAttest, a)) { free(a); strcpy(err, "CallEnclave"); return -1; }
    int st = a->status; if (st) { strncpy(err, a->error, 255); free(a); return st; }
    *rlen = (size_t)a->report_len; memcpy(sig, a->signature, 64); memcpy(chal, a->challenge, 32); free(a); return 0;
}
static int do_generate(const char *prompt, size_t plen, int n, char *out, size_t cap, ee_gen_params *stats, char *err) {
    ee_gen_params *g = (ee_gen_params *)calloc(1, sizeof *g); g->size = sizeof *g; g->prompt = prompt; g->prompt_len = plen; g->n_predict = n; g->out = out; g->out_cap = cap;
    if (call(g_EeGenerate, g)) { free(g); strcpy(err, "CallEnclave"); return -1; }
    int st = g->status; if (stats) *stats = *g; if (st) strncpy(err, g->error, 255); free(g); return st;
}

static int do_session(const uint8_t *in, size_t in_len, uint8_t *out, size_t cap, ee_session_params *stats, char *err) {
    ee_session_params *g = (ee_session_params *)calloc(1, sizeof *g); g->size = sizeof *g; g->in = in; g->in_len = in_len; g->out = out; g->out_cap = cap;
    if (call(g_EeSession, g)) { free(g); strcpy(err, "CallEnclave"); return -1; }
    int st = g->status; if (stats) *stats = *g; if (st) strncpy(err, g->error, 255); free(g); return st;
}
/* ---- a tenant's app, running inside the enclave (ee-app.cpp) ------------------------------- */
/* The host's whole part in this: read the bytecode off disk, carry request frames in and response
 * frames out. It cannot read the app's memory, and the app cannot reach past the four host
 * functions the enclave gives it. */
static int do_app_open(const uint8_t *cwasm, size_t len, uint32_t world,
                       const uint8_t *env, size_t env_len, uint32_t *id, long long *load_us, char *err) {
    if (!g_EeAppOpen) { strcpy(err, "this enclave image has no app runtime"); return -1; }
    ee_app_open_params *p = (ee_app_open_params *)calloc(1, sizeof *p);
    p->size = sizeof *p; p->cwasm = cwasm; p->cwasm_len = len; p->world = world; p->env = env; p->env_len = env_len;
    if (call(g_EeAppOpen, p)) { free(p); strcpy(err, "CallEnclave"); return -1; }
    int st = p->status; *id = p->id; if (load_us) *load_us = (long long)p->load_us;
    if (st) strncpy(err, p->error, 255);
    free(p); return st;
}
static int do_app_handle(uint32_t id, const uint8_t *req, size_t req_len,
                         uint8_t *out, size_t cap, size_t *out_len, long long *us, char *err) {
    if (!g_EeAppHandle) { strcpy(err, "this enclave image has no app runtime"); return -1; }
    ee_app_params *p = (ee_app_params *)calloc(1, sizeof *p);
    p->size = sizeof *p; p->id = id; p->req = req; p->req_len = req_len; p->out = out; p->out_cap = cap;
    /* VTL1 has no clock. The host reads one HERE, per call, and the app is told where it came
     * from (wit/app.wit now-ms): a host-supplied number an app can reason about beats a made-up
     * one it cannot. */
    { FILETIME ft; GetSystemTimeAsFileTime(&ft);
      unsigned long long t = ((unsigned long long)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
      p->now_ms = t / 10000ULL - 11644473600000ULL; }
    if (call(g_EeAppHandle, p)) { free(p); strcpy(err, "CallEnclave"); return -1; }
    int st = p->status; *out_len = (size_t)p->out_len; if (us) *us = (long long)p->handle_us;
    if (st) strncpy(err, p->error, 255);
    free(p); return st;
}
static int do_app_close(uint32_t id, char *err) {
    if (!g_EeAppClose) { strcpy(err, "this enclave image has no app runtime"); return -1; }
    ee_app_close_params *p = (ee_app_close_params *)calloc(1, sizeof *p);
    p->size = sizeof *p; p->id = id;
    if (call(g_EeAppClose, p)) { free(p); strcpy(err, "CallEnclave"); return -1; }
    int st = p->status; free(p); return st;
}
/* out[0] = abi, out[1] = the worlds bitmask (1 enclave:app | 2 wasi:http). */
/* The thread a server-shaped app lives on. It enters the enclave and stays there; the params block
 * is host memory the enclave writes its outcome into, and this thread owns it. */
static DWORD WINAPI app_run_thread(LPVOID param) {
    ee_app_run_params *p = (ee_app_run_params *)param;
    LPVOID r = NULL;
    if (!CallEnclave((LPENCLAVE_ROUTINE)g_EeAppRun, p, TRUE, &r))
        say("[host] EeAppRun failed to enter: %lu\n", GetLastError());
    say("[host] app %u finished (status %d) %s\n", p->id, p->status, p->status ? p->error : "");
    free(p);
    return 0;
}
static int do_app_run(uint32_t id, char *err) {
    if (!g_EeAppRun) { strcpy(err, "this enclave image has no app runtime"); return -1; }
    ee_app_run_params *p = (ee_app_run_params *)calloc(1, sizeof *p);
    p->size = sizeof *p; p->id = id;
    HANDLE h = CreateThread(NULL, 8u << 20, app_run_thread, p, 0, NULL);
    if (!h) { free(p); strcpy(err, "could not start a thread for the app"); return -1; }
    CloseHandle(h);
    return 0;
}
static int do_app_stop(uint32_t id, char *err) {
    if (!g_EeAppStop) { strcpy(err, "this enclave image has no app runtime"); return -1; }
    ee_app_close_params *p = (ee_app_close_params *)calloc(1, sizeof *p);
    p->size = sizeof *p; p->id = id;
    if (call(g_EeAppStop, p)) { free(p); strcpy(err, "CallEnclave"); return -1; }
    const int st = p->status; free(p);
    return st;
}
static uint32_t app_abi(uint32_t *worlds, uint32_t *features) {
    if (worlds) *worlds = 0;
    if (features) *features = 0;
    if (!g_EeAppAbi) return 0;
    /* Zeroed first, then the capacity handshake: an OLD enclave image fills only the first two
     * words and leaves features 0, so every feature reads as absent rather than as garbage. */
    uint32_t v[3] = { EE_ABI_QUERY_MAGIC, 3, 0 };
    if (call(g_EeAppAbi, v)) return 0;
    if (worlds) *worlds = v[1];
    if (features) *features = v[2];
    return v[0];
}

/* ---- the loopback server for the agent ---------------------------------------------------- */
static void serve(int port) {
    SOCKET ls = socket(AF_INET, SOCK_STREAM, 0); struct sockaddr_in a; memset(&a, 0, sizeof a); a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK); a.sin_port = htons((u_short)port);
    BOOL one = TRUE; setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, (const char *)&one, sizeof one);
    if (bind(ls, (struct sockaddr *)&a, sizeof a) || listen(ls, 4)) { say("[host] cannot listen on 127.0.0.1:%d\n", port); return; }
    say("[host] serving on 127.0.0.1:%d\n", port);
    static char line[4u << 20]; static uint8_t bin[2u << 20]; static char outtext[1u << 20]; static char reply[8u << 20]; static uint8_t report[16384];
    for (;;) {
        SOCKET c = accept(ls, NULL, NULL); if (c == INVALID_SOCKET) continue;
        size_t have = 0;
        for (;;) {
            int r = recv(c, line + have, (int)(sizeof line - 1 - have), 0); if (r <= 0) break; have += (size_t)r; line[have] = 0;
            char *nl; while ((nl = strchr(line, '\n'))) {
                *nl = 0; if (nl > line && nl[-1] == '\r') nl[-1] = 0;
                char err[256] = { 0 }; reply[0] = 0;
                if (!strcmp(line, "ping")) strcpy(reply, "ok\n");
                else if (!strcmp(line, "keys")) { char h1[65], h2[65]; hex(h1, g_sign_pk, 32); hex(h2, g_box_pk, 32); snprintf(reply, sizeof reply, "ok %s %s\n", h1, h2); }
                else if (!strncmp(line, "attest ", 7)) {
                    size_t bl = 0; uint8_t sig[64], chal[32]; size_t rl = 0;
                    if (unhex(bin, sizeof bin, line + 7, &bl)) strcpy(reply, "err bad hex\n");
                    else if (do_attest(bin, bl, report, sizeof report, &rl, sig, chal, err)) snprintf(reply, sizeof reply, "err %s\n", err);
                    else { char hc[65], hs[129]; hex(hc, chal, 32); hex(hs, sig, 64); size_t n = snprintf(reply, sizeof reply, "ok %s %s ", hc, hs); hex(reply + n, report, rl); strcat(reply, "\n"); }
                } else if (!strncmp(line, "gen ", 4)) {
                    int n = atoi(line + 4); const char *sp = strchr(line + 4, ' '); size_t pl = 0; ee_gen_params st;
                    if (!sp || unhex(bin, sizeof bin, sp + 1, &pl)) strcpy(reply, "err bad request\n");
                    else if (do_generate((const char *)bin, pl, n, outtext, sizeof outtext, &st, err)) snprintf(reply, sizeof reply, "err %s\n", err);
                    else { size_t k = snprintf(reply, sizeof reply, "ok "); hex(reply + k, (const uint8_t *)outtext, (size_t)st.out_len); k += 2 * (size_t)st.out_len;
                           snprintf(reply + k, sizeof reply - k, " %d %lld %lld %llu %llu %llu %llu\n", st.n_tokens, (long long)st.prompt_us, (long long)st.decode_us, (unsigned long long)st.offloaded, (unsigned long long)st.local, (unsigned long long)st.macs, (unsigned long long)st.verify_fail); }
                } else if (!strncmp(line, "session ", 8)) {   /* opaque: the host cannot read what it carries */
                    size_t bl = 0; ee_session_params st; static uint8_t sout[1u << 20];
                    if (unhex(bin, sizeof bin, line + 8, &bl)) strcpy(reply, "err bad hex\n");
                    else if (do_session(bin, bl, sout, sizeof sout, &st, err)) snprintf(reply, sizeof reply, "err %s\n", err);
                    else { size_t k = snprintf(reply, sizeof reply, "ok "); hex(reply + k, sout, (size_t)st.out_len); k += 2 * (size_t)st.out_len;
                           snprintf(reply + k, sizeof reply - k, " %d %lld %lld %llu %llu %llu %llu\n", st.n_tokens, (long long)st.prompt_us, (long long)st.decode_us, (unsigned long long)st.offloaded, (unsigned long long)st.local, (unsigned long long)st.macs, (unsigned long long)st.verify_fail); }
                } else if (!strcmp(line, "mem")) {
                    /* WHAT THE ENCLAVE ACTUALLY HOLDS. VTL1 pages are committed as they are
                     * touched and they are charged to THIS process, so this process's private
                     * commit is the enclave's own footprint - the model, its KV cache, the pads
                     * and whatever apps have touched. The node asks once before any app runs, and
                     * that reading is the engine's share of the enclave's fixed size; everything
                     * left is what it may promise a tenant. A number nobody measured would either
                     * oversell the enclave or hide most of it. */
                    PROCESS_MEMORY_COUNTERS_EX pmc; memset(&pmc, 0, sizeof pmc); pmc.cb = sizeof pmc;
                    if (!GetProcessMemoryInfo(GetCurrentProcess(), (PROCESS_MEMORY_COUNTERS *)&pmc, sizeof pmc))
                        snprintf(reply, sizeof reply, "err cannot read this process's memory: %lu\n", GetLastError());
                    else snprintf(reply, sizeof reply, "ok %llu %llu\n",
                                  (unsigned long long)pmc.PrivateUsage, (unsigned long long)pmc.WorkingSetSize);
                } else if (!strcmp(line, "appabi")) {
                    /* "<abi> <worlds> <features>". The third word is what the node turns into its
                     * platform capability flags (mem64/set/p3/threads), so the box advertises what
                     * this image can really do and nothing else. */
                    uint32_t worlds = 0, features = 0;
                    const uint32_t abi = app_abi(&worlds, &features);
                    snprintf(reply, sizeof reply, "ok %u %u %u\n", abi, worlds, features);
                } else if (!strncmp(line, "appopen ", 8)) {
                    /* appopen <world> <path to bytecode> [hex environment]
                     * By PATH, not by hex, for the bytecode: it is a hundred kilobytes and up and
                     * the host is the one that fetched it. The environment IS hex, because it
                     * carries a deployment's config and must survive this line protocol intact. */
                    uint32_t id = 0, world = 0; long long load_us = 0;
                    static uint8_t envbuf[256 * 1024]; size_t env_len = 0;
                    char pathbuf[1024]; const char *path = pathbuf;
                    {
                        const char *a = line + 8;
                        char *sp1 = strchr(a, ' ');
                        if (!sp1) { strcpy(reply, "err usage: appopen <world> <path> [hexenv]\n"); goto app_open_done; }
                        world = (uint32_t)atoi(a);
                        const char *rest = sp1 + 1;
                        char *sp2 = strchr(rest, ' ');
                        const size_t plen = sp2 ? (size_t)(sp2 - rest) : strlen(rest);
                        if (!world || plen == 0 || plen >= sizeof pathbuf) { strcpy(reply, "err bad world or path\n"); goto app_open_done; }
                        memcpy(pathbuf, rest, plen); pathbuf[plen] = 0;
                        if (sp2 && unhex(envbuf, sizeof envbuf, sp2 + 1, &env_len)) { strcpy(reply, "err bad env hex\n"); goto app_open_done; }
                    }
                    FILE *f = fopen(path, "rb");
                    if (!f) snprintf(reply, sizeof reply, "err cannot open %s\n", path);
                    else {
                        fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
                        uint8_t *bytes = (n > 0 && n <= (64L << 20)) ? (uint8_t *)malloc((size_t)n) : NULL;
                        if (!bytes) { snprintf(reply, sizeof reply, "err bytecode size %ld\n", n); fclose(f); }
                        else if (fread(bytes, 1, (size_t)n, f) != (size_t)n) { strcpy(reply, "err short read\n"); fclose(f); free(bytes); }
                        else {
                            fclose(f);
                            int st = do_app_open(bytes, (size_t)n, world, env_len ? envbuf : NULL, env_len, &id, &load_us, err);
                            free(bytes);                       /* the enclave has its own copy */
                            if (st) snprintf(reply, sizeof reply, "err %s\n", err);
                            else snprintf(reply, sizeof reply, "ok %u %lld\n", id, load_us);
                        }
                    }
                    app_open_done: ;
                } else if (!strncmp(line, "apphandle ", 10)) {
                    unsigned int id = 0; size_t rl = 0, ol = 0; long long us = 0;
                    const char *sp = strchr(line + 10, ' ');
                    static uint8_t aout[4u << 20];
                    if (!sp || sscanf(line + 10, "%u", &id) != 1) strcpy(reply, "err bad request\n");
                    else if (unhex(bin, sizeof bin, sp + 1, &rl)) strcpy(reply, "err bad hex\n");
                    else {
                        int st = do_app_handle(id, bin, rl, aout, sizeof aout, &ol, &us, err);
                        if (st == -5) snprintf(reply, sizeof reply, "err the response is %llu bytes, larger than this host carries\n", (unsigned long long)ol);
                        else if (st) snprintf(reply, sizeof reply, "err %s\n", err);
                        else { size_t k = snprintf(reply, sizeof reply, "ok "); hex(reply + k, aout, ol); k += 2 * ol;
                               snprintf(reply + k, sizeof reply - k, " %lld\n", us); }
                    }
                } else if (!strncmp(line, "apprun ", 7)) {
                    /* Returns as soon as the thread is started: the app itself runs for as long as
                     * it holds its lease, and its port is the one it binds through the broker. */
                    unsigned int id = 0;
                    if (sscanf(line + 7, "%u", &id) != 1) strcpy(reply, "err bad id\n");
                    else if (do_app_run(id, err)) snprintf(reply, sizeof reply, "err %s\n", err);
                    else strcpy(reply, "ok\n");
                } else if (!strncmp(line, "appstop ", 8)) {
                    unsigned int id = 0;
                    if (sscanf(line + 8, "%u", &id) != 1) strcpy(reply, "err bad id\n");
                    else if (do_app_stop(id, err)) snprintf(reply, sizeof reply, "err %s\n", err);
                    else strcpy(reply, "ok\n");
                } else if (!strncmp(line, "appclose ", 9)) {
                    unsigned int id = 0;
                    if (sscanf(line + 9, "%u", &id) != 1) strcpy(reply, "err bad id\n");
                    else if (do_app_close(id, err)) snprintf(reply, sizeof reply, "err %s\n", err);
                    else strcpy(reply, "ok\n");
                } else if (!strcmp(line, "quit")) { closesocket(c); closesocket(ls); return; }
                else strcpy(reply, "err unknown command\n");
                send(c, reply, (int)strlen(reply), 0);
                size_t rest = have - (size_t)(nl + 1 - line); memmove(line, nl + 1, rest); have = rest; line[have] = 0;
            }
            if (have >= sizeof line - 1) break;
        }
        closesocket(c);
    }
}

int main(int argc, char **argv) {
    const char *dll = "ee-engine.dll", *model = NULL, *calib = NULL, *prompt = "The capital of France is", *logpath = NULL;
    int n_predict = 8, threads = 8, n_ctx = 1024, serve_port = 0; SIZE_T size = (SIZE_T)0x1000000000ULL;  /* 64 GB, must match the image's EnclaveSize (ee-main.cpp) */ DWORD nthreads = 64;
    char env[16384]; size_t envlen = 0;
    #define ENV(kv) do { size_t l = strlen(kv); if (envlen + l + 2 < sizeof env) { memcpy(env + envlen, kv, l + 1); envlen += l + 1; } } while (0)
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--enclave") && i + 1 < argc) dll = argv[++i];
        else if (!strcmp(argv[i], "--model") && i + 1 < argc) model = argv[++i];
        else if (!strcmp(argv[i], "--calib") && i + 1 < argc) calib = argv[++i];
        else if (!strcmp(argv[i], "--env") && i + 1 < argc) { const char *kv = argv[++i]; ENV(kv); }
        else if (!strcmp(argv[i], "--threads") && i + 1 < argc) threads = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--ctx") && i + 1 < argc) n_ctx = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--n") && i + 1 < argc) n_predict = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--prompt") && i + 1 < argc) prompt = argv[++i];
        else if (!strcmp(argv[i], "--serve") && i + 1 < argc) serve_port = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--log") && i + 1 < argc) logpath = argv[++i];
        else if (!strcmp(argv[i], "--size-mb") && i + 1 < argc) size = (SIZE_T)atoi(argv[++i]) << 20;
        else if (!strcmp(argv[i], "--quiet")) g_quiet = 1;
        else { say("unknown argument %s\n", argv[i]); say("usage: ee-host --model M.gguf --calib M.calib [--enclave ee-engine.dll] [--env K=V]... [--threads N] [--ctx N] [--n N] [--prompt T] [--serve PORT] [--log F] [--quiet]\n"); return 2; }
    }
    if (!model) { say("--model is required\n"); return 2; }
    InitializeCriticalSection(&g_log_cs); InitializeCriticalSection(&g_sock_cs);
    WSADATA w; WSAStartup(MAKEWORD(2, 2), &w);
    if (logpath) g_logf = fopen(logpath, "ab");
    uint64_t mlen = 0, clen = 0; const int64_t t0 = now_us();
    uint8_t *mbytes = read_file(model, &mlen); if (!mbytes) { say("[host] cannot read %s\n", model); return 3; }
    uint8_t *cbytes = calib ? read_file(calib, &clen) : NULL; if (calib && !cbytes) { say("[host] cannot read %s\n", calib); return 3; }
    say("[host] model %s: %.1f MB in host memory (%.1f s)%s\n", basename_of(model), mlen / 1048576.0, (now_us() - t0) / 1e6, calib ? ", calibration loaded" : "");
    wchar_t wdll[520]; MultiByteToWideChar(CP_UTF8, 0, dll, -1, wdll, 520);
    if (start_enclave(wdll, size, nthreads)) return 4;
    /* call-out slots: one per enclave thread, 1 MiB of data each */
    const uint32_t n_slots = 96; const uint64_t slot_bytes = (1u << 20) + 4096;
    uint8_t *slots = (uint8_t *)VirtualAlloc(NULL, (SIZE_T)(n_slots * slot_bytes), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    memset(&g_init, 0, sizeof g_init); g_init.size = sizeof g_init; g_init.version = EE_ABI_VERSION; g_init.callout = (void *)host_callout;
    g_init.slots = slots; g_init.slot_bytes = slot_bytes; g_init.n_slots = n_slots;
    SYSTEM_INFO si; GetSystemInfo(&si); g_init.cpu_count = si.dwNumberOfProcessors;
    FILETIME ft; GetSystemTimeAsFileTime(&ft); g_init.filetime = ((int64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime; g_init.unix_time = (g_init.filetime - 116444736000000000LL) / 10000000LL;
    char calibname[64] = "model.calib"; if (calib) { ENV("SHIELDED_CALIB=model.calib"); }
    g_init.env = env; g_init.env_len = envlen;
    g_init.files[0].name = "model.gguf"; g_init.files[0].data = mbytes; g_init.files[0].len = mlen; g_init.n_files = 1;
    if (cbytes) { g_init.files[1].name = calibname; g_init.files[1].data = cbytes; g_init.files[1].len = clen; g_init.n_files = 2; }
    if (call(g_EeInit, &g_init) || g_init.status) { say("[host] EeInit failed: %d %s\n", g_init.status, g_init.error); return 5; }
    memcpy(g_sign_pk, g_init.sign_pk, 32); memcpy(g_box_pk, g_init.box_pk, 32);
    { char h1[65], h2[65]; hex(h1, g_sign_pk, 32); hex(h2, g_box_pk, 32); say("[host] enclave keys: transport %s pad %s\n", h1, h2); }
    ee_load_params *lp = (ee_load_params *)calloc(1, sizeof *lp); lp->size = sizeof *lp; lp->model = "model.gguf"; lp->n_threads = threads; lp->n_ctx = n_ctx; lp->n_batch = 512;
    const int64_t t1 = now_us();
    if (call(g_EeLoad, lp) || lp->status) { say("[host] EeLoad failed: %d %s\n", lp->status, lp->error); return 6; }
    say("[host] loaded in %.1f s: %d layers, vocab %d; devices:", (now_us() - t1) / 1e6, lp->n_layer, lp->n_vocab); for (uint32_t i = 0; i < lp->n_devices; i++) say(" %s", lp->devices[i]); say("\n");
    if (serve_port) { serve(serve_port); return 0; }
    static char out[1u << 20]; ee_gen_params st; char err[256] = { 0 };
    const int rc = do_generate(prompt, strlen(prompt), n_predict, out, sizeof out, &st, err);
    if (rc) { say("[host] generate failed: %d %s\n", rc, err); return 7; }
    printf("%.*s\n", (int)st.out_len, out); fflush(stdout);
    say("[host] %d tokens: prompt %.1f ms, decode %.1f ms (%.1f ms/token); offloaded %llu nodes, local %llu, %llu MMACs, verify failures %llu\n",
        st.n_tokens, st.prompt_us / 1e3, st.decode_us / 1e3, st.n_tokens ? st.decode_us / 1e3 / st.n_tokens : 0.0, (unsigned long long)st.offloaded, (unsigned long long)st.local, (unsigned long long)(st.macs / 1000000), (unsigned long long)st.verify_fail);
    /* process exit tears the enclave down with its threads; a TerminateEnclave here races the pool threads still entering */
    fflush(stdout); fflush(stderr); if (g_logf) fclose(g_logf);
    _exit(0);
}
