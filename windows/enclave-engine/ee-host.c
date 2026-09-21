/* ee-host.c -- the VTL0 half of the enclave engine: untrusted plumbing.
 * Loads ee-engine.dll into a VBS enclave, hands it the model bytes, the calibration and the
 * environment (all host memory the enclave reads directly), serves its call-outs (log, thread
 * entry, the worker's TCP socket), and offers the engine either on the command line or as a
 * line-protocol server on loopback for the node agent (windows/node/agent.mjs):
 *   keys                     -> ok <sign_pk hex> <box_pk hex>
 *   attest <bound hex>       -> ok <challenge hex> <signature hex> <report hex>
 *   gen <n> <prompt hex>     -> ok <text hex> <tokens> <prompt_us> <decode_us> <offloaded> <local> <macs> <verify_fail>
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
#include "ee-rt.h"
#pragma comment(lib, "ws2_32.lib")

static LPVOID g_base; static FARPROC g_EeInit, g_EeThread, g_EeLoad, g_EeGenerate, g_EeAttest;
static FILE *g_logf; static CRITICAL_SECTION g_log_cs;
static SOCKET g_socks[256]; static CRITICAL_SECTION g_sock_cs;
static int g_quiet;

static void say(const char *fmt, ...) { va_list ap; va_start(ap, fmt); vfprintf(stderr, fmt, ap); va_end(ap); fflush(stderr); }
static int64_t now_us(void) { static LARGE_INTEGER f; LARGE_INTEGER c; if (!f.QuadPart) QueryPerformanceFrequency(&f); QueryPerformanceCounter(&c); return (int64_t)(c.QuadPart * 1000000.0 / f.QuadPart); }

/* ---- the call-out: the enclave's only way out ------------------------------------------ */
static DWORD WINAPI thr_enter(LPVOID p) { LPVOID r = NULL; if (!CallEnclave((LPENCLAVE_ROUTINE)g_EeThread, p, TRUE, &r)) say("[host] EeThread entry failed: %lu\n", GetLastError()); return 0; }
static int wsa_errno(void) { switch (WSAGetLastError()) { case WSAECONNREFUSED: return 111; case WSAETIMEDOUT: return 110; case WSAECONNRESET: return 104; case WSAEHOSTUNREACH: return 113; default: return 5; } }
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
        size_t done = 0; while (done < c->len) { int r = send(s, (const char *)c->data + done, (int)(c->len - done), 0); if (r <= 0) { c->ret = done ? (int64_t)done : -wsa_errno(); goto out; } done += (size_t)r; }
        c->ret = (int64_t)done; break; }
    case EE_OP_RECV: {
        SOCKET s = c->handle < 256 ? g_socks[c->handle] : 0; if (!s) { c->ret = -9; break; }
        int r = recv(s, (char *)c->data, (int)(c->len < c->cap ? c->len : c->cap), 0);
        c->ret = r < 0 ? -wsa_errno() : r; break; }
    case EE_OP_CLOSE: {
        SOCKET s = c->handle < 256 ? g_socks[c->handle] : 0; if (s) { closesocket(s); g_socks[c->handle] = 0; } c->ret = 0; break; }
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
    g_EeLoad = GetProcAddress((HMODULE)g_base, "EeLoad"); g_EeGenerate = GetProcAddress((HMODULE)g_base, "EeGenerate"); g_EeAttest = GetProcAddress((HMODULE)g_base, "EeAttest");
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
    int n_predict = 8, threads = 8, n_ctx = 1024, serve_port = 0; SIZE_T size = (SIZE_T)0x80000000; DWORD nthreads = 64;
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
