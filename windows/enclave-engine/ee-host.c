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
#define _CRT_RAND_S   /* enable rand_s (RtlGenRandom) for the per-boot app epoch; must precede <stdlib.h> */
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

static LPVOID g_base; static FARPROC g_EeInit, g_EeThread, g_EeLoad, g_EeGenerate, g_EeAttest, g_EeSession, g_EeThreadTest;
/* the app runtime's entry points. Optional on purpose: an older enclave image has no app runtime,
 * and the host says so rather than failing to start. */
static FARPROC g_EeAppOpen, g_EeAppHandle, g_EeAppClose, g_EeAppAbi, g_EeAppRun, g_EeAppStop;
static FILE *g_logf; static CRITICAL_SECTION g_log_cs;
static SOCKET g_socks[256]; static CRITICAL_SECTION g_sock_cs;
static volatile LONG g_spawn_lie;              /* EE_THREAD_SELFTEST: see EE_OP_SPAWN */
static volatile uint32_t *g_lie_seen;          /* the barrier flag the lie waits for */
/* One binary semaphore per park token (an enclave call-out slot index). Lazily created under the
 * same lock the socket table uses; EE_MAX_PARK is the ceiling on enclave threads. */
#define EE_MAX_PARK 256
static HANDLE volatile g_park[EE_MAX_PARK];
static HANDLE park_sem(uint32_t token) {
    if (token >= EE_MAX_PARK) return NULL;
    /* PUBLISHED WITH AN INTERLOCKED EXCHANGE, not under a lock that only the writer takes. The
     * fast path reads this slot without the lock, so a plain store on the other side would be a
     * torn or reordered publication - the reader could see a non-null handle before the object
     * behind it was there. The loser of the race closes its own semaphore and uses the winner's. */
    HANDLE h = (HANDLE)InterlockedCompareExchangePointer((PVOID volatile *)&g_park[token], NULL, NULL);
    if (h) return h;
    HANDLE mine = CreateSemaphoreW(NULL, 0, 1, NULL);
    if (!mine) return NULL;
    HANDLE won = (HANDLE)InterlockedCompareExchangePointer((PVOID volatile *)&g_park[token], mine, NULL);
    if (won) { CloseHandle(mine); return won; }
    return mine;
}
static int g_quiet;

/* A per-boot app epoch. App ids restart from 1 every time this process (re)starts, so across a
 * process generation the same number names a different tenant's app. The node's own generation
 * guard only decides whether to SEND a command; it cannot un-do a side effect that has already
 * happened here if a queued appstop/appclose from the dead generation connects to this new host
 * (agent.mjs enqueues the job before it connects). So the authoritative check lives HERE: every
 * app is opened under g_app_epoch, and apphandle/appstop/appclose must carry the epoch they were
 * opened under. A command from a dead generation carries the old epoch and is refused BEFORE any
 * do_app_* side effect. Minted once at serve() start; a fresh random value each boot means a
 * stale epoch practically never collides, and even a collision only degrades to the node guard. */
static unsigned int g_app_epoch;
static unsigned int mint_epoch(void) {
    unsigned int e = 0;
    if (rand_s(&e) != 0 || e == 0) {
        LARGE_INTEGER qpc; QueryPerformanceCounter(&qpc);
        e = (unsigned int)((unsigned long long)qpc.QuadPart ^ GetTickCount64() ^ ((unsigned long long)GetCurrentProcessId() << 16));
    }
    return e ? e : 1u;   /* never 0: 0 is the "no epoch" sentinel on the node side */
}

static void say(const char *fmt, ...) { va_list ap; va_start(ap, fmt); vfprintf(stderr, fmt, ap); va_end(ap); fflush(stderr); }
static int64_t now_us(void) { static LARGE_INTEGER f; LARGE_INTEGER c; if (!f.QuadPart) QueryPerformanceFrequency(&f); QueryPerformanceCounter(&c); return (int64_t)(c.QuadPart * 1000000.0 / f.QuadPart); }

/* ---- the call-out: the enclave's only way out ------------------------------------------ */
/* Asks the enclave, from a DIFFERENT host thread, what identity it believes it has. */
static DWORD WINAPI tok_probe(LPVOID p) {
    LPVOID r = NULL;
    CallEnclave((LPENCLAVE_ROUTINE)g_EeThreadTest, p, TRUE, &r);
    return 0;
}
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
    /* PARK/UNPARK -- one binary semaphore per token, so a permit released before its wait is
     * remembered instead of lost. The enclave's wait queue lives in VTL1 where this side cannot
     * see it, so the host has no condition to re-check: the permit IS the memory of the wakeup.
     * Created on first use; tokens are enclave slot indices, so the array is bounded by n_slots. */
    case EE_OP_PARK: {
        HANDLE s = park_sem(c->handle);
        if (!s) { c->ret = -11; break; }
        const DWORD ms = c->arg ? (DWORD)c->arg : INFINITE;
        const DWORD r = WaitForSingleObject(s, ms);
        c->ret = r == WAIT_OBJECT_0 ? 0 : (r == WAIT_TIMEOUT ? 1 : -5);
        break; }
    case EE_OP_UNPARK: {
        HANDLE s = park_sem(c->handle);
        if (!s) { c->ret = -11; break; }
        /* FALSE here means a permit is ALREADY pending, which is success: park/unpark does not
         * count, it remembers at most one. */
        ReleaseSemaphore(s, 1, NULL);
        c->ret = 0; break; }
    case EE_OP_SPAWN: {
        HANDLE h = CreateThread(NULL, 4u << 20, thr_enter, (LPVOID)(uintptr_t)c->arg, 0, NULL);
        if (!h) { c->ret = -11; break; } CloseHandle(h);
        /* EE_THREAD_SELFTEST only: spawn the thread and then LIE about it. A hostile host can do
         * exactly this, and the enclave used to believe the answer and free a record its own live
         * thread was using. */
        if (g_spawn_lie) {
            g_spawn_lie = 0;
            /* WAIT FOR THE BODY TO BE INSIDE before lying about the spawn. Without this the
             * enclave cancels first and the interleaving under test never happens - which is
             * exactly what the first version of this test measured, and it reported that it had
             * proved nothing rather than passing. */
            if (g_lie_seen) for (int i = 0; i < 5000 && !*g_lie_seen; i++) Sleep(1);
            c->ret = -11; break;
        }
        c->ret = 0; break; }
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
        /* A tenant's port is EXCLUSIVE, not shared. SO_REUSEADDR on Windows lets a socket bind a
         * port ANOTHER socket is already actively bound to, so two apps that ask for the same port
         * (e.g. two risc-boxes both defaulting to tcp:2222) both "succeeded" and split the
         * connections between them. SO_EXCLUSIVEADDRUSE makes the second bind fail with
         * EADDRINUSE instead, which is the honest answer -- one port, one app. A listener that is
         * closed (see the store-teardown cleanup in enclave-rt) frees its port at once, so a
         * relaunch on the same port still binds; only a LIVE double-bind is refused. */
        BOOL one = TRUE; setsockopt(ls, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&one, sizeof one);
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
    g_EeThreadTest = GetProcAddress((HMODULE)g_base, "EeThreadTest");
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
    g_app_epoch = mint_epoch();
    say("[host] serving on 127.0.0.1:%d (app epoch %u)\n", port, g_app_epoch);
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
                        /* 512 MB, matching ee-app.cpp's own ceiling. 64 was enough until risc-box:
                         * a 23.7 MB wasm64 + SET component compiles to 85 MB of Pulley bytecode,
                         * because an interpreter's encoding is larger than machine code. The two
                         * checks have to agree or the app is refused HERE with a different
                         * message than the enclave would have given. */
                        uint8_t *bytes = (n > 0 && n <= (512L << 20)) ? (uint8_t *)malloc((size_t)n) : NULL;
                        if (!bytes) { snprintf(reply, sizeof reply, "err bytecode size %ld\n", n); fclose(f); }
                        else if (fread(bytes, 1, (size_t)n, f) != (size_t)n) { strcpy(reply, "err short read\n"); fclose(f); free(bytes); }
                        else {
                            fclose(f);
                            int st = do_app_open(bytes, (size_t)n, world, env_len ? envbuf : NULL, env_len, &id, &load_us, err);
                            free(bytes);                       /* the enclave has its own copy */
                            if (st) snprintf(reply, sizeof reply, "err %s\n", err);
                            /* "ok <id> <load_us> <epoch>": the node stores the epoch and must echo it on
                             * every app-scoped command for this id, so a command from a dead ee-host
                             * generation (carrying that boot's epoch) is refused by the next boot. */
                            else snprintf(reply, sizeof reply, "ok %u %lld %u\n", id, load_us, g_app_epoch);
                        }
                    }
                    app_open_done: ;
                } else if (!strncmp(line, "apphandle ", 10)) {
                    /* apphandle <epoch> <id> <request hex> */
                    unsigned int epoch = 0, id = 0; size_t rl = 0, ol = 0; long long us = 0;
                    const char *a = line + 10;
                    const char *sp1 = strchr(a, ' ');
                    const char *sp2 = sp1 ? strchr(sp1 + 1, ' ') : NULL;
                    static uint8_t aout[4u << 20];
                    if (!sp2 || sscanf(a, "%u %u", &epoch, &id) != 2) strcpy(reply, "err bad request\n");
                    else if (epoch != g_app_epoch) strcpy(reply, "err stale epoch\n");
                    else if (unhex(bin, sizeof bin, sp2 + 1, &rl)) strcpy(reply, "err bad hex\n");
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
                    /* apprun <epoch> <id> */
                    unsigned int epoch = 0, id = 0;
                    if (sscanf(line + 7, "%u %u", &epoch, &id) != 2) strcpy(reply, "err bad id\n");
                    else if (epoch != g_app_epoch) strcpy(reply, "err stale epoch\n");
                    else if (do_app_run(id, err)) snprintf(reply, sizeof reply, "err %s\n", err);
                    else strcpy(reply, "ok\n");
                } else if (!strncmp(line, "appstop ", 8)) {
                    /* appstop <epoch> <id>: refused before any side effect if the epoch is stale */
                    unsigned int epoch = 0, id = 0;
                    if (sscanf(line + 8, "%u %u", &epoch, &id) != 2) strcpy(reply, "err bad id\n");
                    else if (epoch != g_app_epoch) strcpy(reply, "err stale epoch\n");
                    else if (do_app_stop(id, err)) snprintf(reply, sizeof reply, "err %s\n", err);
                    else strcpy(reply, "ok\n");
                } else if (!strncmp(line, "appclose ", 9)) {
                    /* appclose <epoch> <id>: refused before any side effect if the epoch is stale */
                    unsigned int epoch = 0, id = 0;
                    if (sscanf(line + 9, "%u %u", &epoch, &id) != 2) strcpy(reply, "err bad id\n");
                    else if (epoch != g_app_epoch) strcpy(reply, "err stale epoch\n");
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
    const char *load_cwasm = NULL; uint32_t load_world = 4; int load_run = 0;
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
        else if (!strcmp(argv[i], "--load-cwasm") && i + 1 < argc) load_cwasm = argv[++i];
        else if (!strcmp(argv[i], "--world") && i + 1 < argc) load_world = (uint32_t)atoi(argv[++i]);
        else if (!strcmp(argv[i], "--app-run")) load_run = 1;
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
    /* A park token IS a slot index (ee_park_token), so the semaphore table has to cover them all.
     * Checked rather than assumed: the two numbers live in different places and a later bump to
     * n_slots would otherwise turn into threads that silently cannot block. */
    if (n_slots > EE_MAX_PARK) { say("[host] n_slots %u exceeds EE_MAX_PARK %u\n", n_slots, (unsigned)EE_MAX_PARK); return -4; }
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

    /* --load-cwasm: open one precompiled app in the enclave and say what happened, without the
     * node. It is how a new artifact gets its first answer - "does this thing load at all" - on a
     * box that is serving, since the test image runs beside the production pair. With --app-run
     * the app is entered on a thread of its own and this process stays up so it can be reached. */
    if (load_cwasm) {
        FILE *cf = fopen(load_cwasm, "rb");
        if (!cf) { say("[host] cannot open %s\n", load_cwasm); return 7; }
        fseek(cf, 0, SEEK_END); long clen = ftell(cf); fseek(cf, 0, SEEK_SET);
        uint8_t *cb = (uint8_t *)malloc((size_t)clen);
        if (!cb || fread(cb, 1, (size_t)clen, cf) != (size_t)clen) { say("[host] short read\n"); return 7; }
        fclose(cf);
        char aerr[256] = {0}; uint32_t aid = 0; long long alus = 0;
        const int st = do_app_open(cb, (size_t)clen, load_world, (const uint8_t *)env, envlen, &aid, &alus, aerr);
        printf("{\"opened\":%s,\"status\":%d,\"id\":%u,\"loadMs\":%.1f,\"bytes\":%ld,\"world\":%u,\"error\":\"%s\"}\n",
               st == 0 ? "true" : "false", st, aid, (double)alus / 1000.0, clen, load_world, aerr);
        fflush(stdout);
        if (st != 0) return 8;
        if (load_run) {
            char rerr[256] = {0};
            if (do_app_run(aid, rerr)) { say("[host] run failed: %s\n", rerr); return 9; }
            say("[host] app %u entered; serving. Ctrl-C to stop.\n", aid);
            for (;;) Sleep(1000);
        }
        return 0;
    }

    /* EE_THREAD_SELFTEST -- the HOST misbehaving on purpose, which is the only way to test what a
     * hostile host can do to the enclave's thread identity and entry. One JSON line, then exit,
     * before the model is loaded or anything is served. */
    if (getenv("EE_THREAD_SELFTEST")) {
        ee_thr_test t; memset(&t, 0, sizeof t);
        int ok_replay = 0, ok_stale = 0, ok_tokens = 0, ok_many = 0;
        uint32_t runs_after_replay = 0; int32_t many_status = 0;

        /* (1) DUPLICATE ENTRY. Spawn a body that parks on a gate, then try to enter the very same
         * record again while it is still live. The second entry must refuse and must not run the
         * body: a body that owns its argument would otherwise free it twice. */
        t.op = 1; call(g_EeThreadTest, &t);
        if (t.status == 0) {
            LPVOID r = NULL;
            CallEnclave((LPENCLAVE_ROUTINE)g_EeThread, (LPVOID)(uintptr_t)t.entry_param, TRUE, &r);
            const intptr_t replay = (intptr_t)r;
            /* (2) STALE ID: same index, a generation that was never issued. */
            LPVOID r2 = NULL;
            const uint64_t stale = (t.entry_param & 0xffffffffu) | ((uint64_t)0xdead0000u << 32);
            CallEnclave((LPENCLAVE_ROUTINE)g_EeThread, (LPVOID)(uintptr_t)stale, TRUE, &r2);
            const intptr_t staler = (intptr_t)r2;
            ok_replay = replay != 0;
            ok_stale = staler != 0;
            t.op = 2; call(g_EeThreadTest, &t);        /* release the gate */
            Sleep(200);
            runs_after_replay = t.runs;
        }

        /* (3) IDENTITY. Two threads take their identity, the host scribbles the same lie into
         * every slot header, and they read it back. They must still differ: if the host can make
         * two live threads report one name, the runtime above hands out two unsynchronised `&mut`
         * to the same per-thread object. */
        {
            /* BOTH threads take their identity BEFORE the scribble, and read it back after. A
             * thread that claims its slot afterwards rewrites the header itself and would not
             * notice the lie - which is the mistake the first version of this test made. */
            ee_thr_test a, b; memset(&a, 0, sizeof a); memset(&b, 0, sizeof b);
            b.op = 5;
            HANDLE h = CreateThread(NULL, 1u << 20, (LPTHREAD_START_ROUTINE)tok_probe, &b, 0, NULL);
            a.op = 5;
            HANDLE h2 = CreateThread(NULL, 1u << 20, (LPTHREAD_START_ROUTINE)tok_probe, &a, 0, NULL);
            for (int i = 0; i < 5000 && !(a.runs && b.runs); i++) Sleep(1);
            for (uint32_t i = 0; i < n_slots; i++) {
                ee_callout *c = (ee_callout *)(slots + (uint64_t)i * slot_bytes);
                c->slot = 7;                            /* the same lie in every slot */
            }
            a.gate = 1; b.gate = 1;
            if (h) { WaitForSingleObject(h, 20000); CloseHandle(h); }
            if (h2) { WaitForSingleObject(h2, 20000); CloseHandle(h2); }
            ok_tokens = a.status == 0 && b.status == 0 && a.token != b.token;
        }

        /* (4) STABILITY. Sequential spawn+join well past n_slots: a slot that is never given back
         * used to make the 97th thread of the enclave's LIFE fatal. */
        /* (5) THE HOST LIES about a spawn it really performed. */
        int ok_lie = 0; uint32_t lie_runs = 0, lie_reported = 0;
        { ee_thr_test l; memset(&l, 0, sizeof l); l.op = 6;
          InterlockedExchange(&g_spawn_lie, 1);
          call(g_EeThreadTest, &l);
          InterlockedExchange(&g_spawn_lie, 0);
          lie_runs = l.runs; lie_reported = l.token;
          /* The body runs at most once, whichever way the cancellation went, and the process is
           * still here to say so. */
          ok_lie = l.status == 0 && l.runs <= 1; }

        /* (6) CONCURRENT admission: eight threads each spawning and joining forty. */
        int ok_churn = 0; uint32_t churn_held = 0, churn_fail = 0;
        { ee_thr_test ch; memset(&ch, 0, sizeof ch); ch.op = 7; ch.n = 8;
          call(g_EeThreadTest, &ch);
          churn_held = ch.token; churn_fail = ch.runs;
          ok_churn = ch.status == 0 && ch.token < 16; }

        /* (7-10) THE DETERMINISTIC INTERLEAVINGS. Each arms a barrier inside the real transition
         * and drives the racing side once the barrier reports it has been reached, so the order is
         * certain rather than hoped for. `*_seen` is the proof the barrier was actually hit; a
         * test whose barrier never fired proves nothing and says so. */
        int ok_hold = 0, ok_resurrect = 0, ok_join = 0, ok_admit = 0;
        uint32_t hold_seen = 0, hold_freed = 0, res_seen = 0, res_count = 0;
        uint32_t join_seen = 0, join_early = 0, admit_spawned = 0;
        { ee_thr_test x; memset(&x, 0, sizeof x); x.op = 8;
          g_lie_seen = &x.seen;
          InterlockedExchange(&g_spawn_lie, 1);
          call(g_EeThreadTest, &x);
          InterlockedExchange(&g_spawn_lie, 0);
          g_lie_seen = NULL;
          hold_seen = x.seen; hold_freed = x.freed_live;
          ok_hold = x.status == 0 && x.seen != 0 && x.freed_live == 0; }
        uint32_t res_timeout = 0;
        { ee_thr_test x; memset(&x, 0, sizeof x); x.op = 9;
          call(g_EeThreadTest, &x);
          res_seen = x.seen; res_count = x.resurrect; res_timeout = x.freed_live;
          /* A hold that ENDED ON A TIMEOUT was not driven by this test, so the interleaving it
           * claims to have created did not happen. Reaching the barrier is necessary and not
           * sufficient. */
          ok_resurrect = x.status == 0 && x.seen != 0 && res_timeout == 0 && x.resurrect == 0; }
        { ee_thr_test x; memset(&x, 0, sizeof x); x.op = 10;
          call(g_EeThreadTest, &x);
          join_seen = x.seen; join_early = x.joined;
          ok_join = x.status == 0 && x.seen != 0 && x.joined == 0; }
        uint32_t admit_held0 = 0, admit_again = 0, admit_full = 0; const uint32_t ADMIT_N = 8;
        { ee_thr_test x; memset(&x, 0, sizeof x); x.op = 11; x.n = ADMIT_N;
          call(g_EeThreadTest, &x);
          admit_spawned = x.spawned; admit_held0 = x.token; admit_again = x.joined;
          admit_full = x.resurrect;
          /* THREE things, none of which depends on a baseline holding still:
           *   the pool is EXACTLY full when admission stops - the ceiling was really met;
           *   a refusal happened - fewer got in than were offered, so EAGAIN was returned rather
           *     than the enclave dying;
           *   the second round admits the same number - a refused spawn gave its reservation
           *     back instead of leaking it. */
          ok_admit = x.status == 0
                     /* the pool reached exactly the CAPACITY that was set (held0 + N), which is
                      * the ceiling being met. Comparing it against held0 + admitted instead was
                      * my arithmetic, not the code: a straggler can take one between the
                      * measurement and the loop, and it did. */
                     && admit_full == admit_held0 + ADMIT_N
                     && x.spawned > 0 && x.spawned < ADMIT_N + 4
                     && x.joined == x.spawned; }

        uint32_t held_after = 0;
        { ee_thr_test m; memset(&m, 0, sizeof m); m.op = 4; m.n = 200; call(g_EeThreadTest, &m);
          many_status = m.status; held_after = m.token;
          /* 200 threads, each of which took an identity. A handful may still be held by threads
           * this process keeps alive; 200 would mean none were ever given back, and the enclave
           * would die on the next one. */
          ok_many = m.status == 0 && held_after < 16; }

        printf("{\"duplicateEntryRefused\":%s,\"staleEntryRefused\":%s,\"bodyRuns\":%u,"
               "\"tokensSurviveHostScribble\":%s,\"sequentialSpawnJoin200\":%s,\"tokensHeldAfter200\":%u,"
               "\"hostLiedAboutSpawn\":%s,\"lieBodyRuns\":%u,\"lieReportedSuccess\":%u,"
               "\"concurrentSpawnJoin\":%s,\"concurrentHeld\":%u,\"concurrentFailures\":%u,"
               "\"heldBodyNotFreed\":%s,\"holdBarrierHit\":%u,\"freedLive\":%u,"
               "\"releaseNotResurrected\":%s,\"releaseBarrierHit\":%u,\"resurrected\":%u,"
               "\"joinWaitsForCleanup\":%s,\"dtorBarrierHit\":%u,\"joinedEarly\":%u,"
               "\"releaseHoldTimedOut\":%u,"
               "\"admissionRecoverable\":%s,\"tokensHeldBefore\":%u,\"admittedAtCap\":%u,"
               "\"poolFullAtRefusal\":%u,\"admittedAgainAfterRelease\":%u,"
               "\"manyStatus\":%d}\n",
               ok_replay ? "true" : "false", ok_stale ? "true" : "false", runs_after_replay,
               ok_tokens ? "true" : "false", ok_many ? "true" : "false", held_after,
               ok_lie ? "true" : "false", lie_runs, lie_reported,
               ok_churn ? "true" : "false", churn_held, churn_fail,
               ok_hold ? "true" : "false", hold_seen, hold_freed,
               ok_resurrect ? "true" : "false", res_seen, res_count,
               ok_join ? "true" : "false", join_seen, join_early,
               res_timeout,
               ok_admit ? "true" : "false", admit_held0, admit_spawned, admit_full, admit_again,
               many_status);
        fflush(stdout);
        return (ok_replay && ok_stale && runs_after_replay == 1 && ok_tokens && ok_many
                && ok_lie && ok_churn && ok_hold && ok_resurrect && ok_join && ok_admit) ? 0 : 9;
    }
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
