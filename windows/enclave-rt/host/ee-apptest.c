/* ee-apptest.c -- run an enclave app OUTSIDE the enclave, to test the runtime itself.
 *
 * Same enclave_rt.lib, same bytecode, same wire frames as the real thing; the only difference is
 * that this one runs in VTL0 where a debugger can see it. It exists so that a failure inside the
 * enclave is known to be about the ENCLAVE (the CRT, the gate, the image) and not about the
 * runtime, which is the distinction that makes the enclave bring-up tractable.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>
#include <bcrypt.h>

unsigned int  ee_rt_open(const unsigned char *cwasm, size_t len, unsigned int world,
                         const unsigned char *env, size_t env_len);
unsigned int  ee_rt_worlds(void);
int           ee_rt_handle(unsigned int id, const unsigned char *req, size_t req_len,
                           unsigned char *out, size_t out_cap, size_t *out_len);
int           ee_rt_close(unsigned int id);
size_t        ee_rt_last_error(unsigned char *out, size_t cap);
unsigned int  ee_rt_abi(void);

/* ---- the four things the app may ask of the enclave ------------------------------------- */
unsigned long long ee_app_now_us(void) {
    LARGE_INTEGER f, c; QueryPerformanceFrequency(&f); QueryPerformanceCounter(&c);
    return (unsigned long long)(c.QuadPart * 1000000LL / f.QuadPart);
}
unsigned long long ee_app_now_ms(void) {
    FILETIME ft; GetSystemTimeAsFileTime(&ft);
    unsigned long long t = ((unsigned long long)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    return t / 10000ULL - 11644473600000ULL;
}
int ee_app_random(unsigned char *out, unsigned int len) {
    return BCryptGenRandom(NULL, out, len, BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0 ? 0 : -1;
}
void ee_app_log(const char *p, size_t len) { printf("app log: %.*s\n", (int)len, p); }
/* In the enclave this calls the engine in VTL1. Out here it is a stub that says so, so a test
 * result can never be mistaken for the model having answered. */
int ee_app_generate(const char *prompt, size_t plen, unsigned int max_tokens,
                    char *out, size_t cap, size_t *out_len) {
    int n = snprintf(out, cap, "[no model in the test harness: %u tokens for %.*s]",
                     max_tokens, (int)plen, prompt);
    if (n < 0 || (size_t)n >= cap) return -1;
    *out_len = (size_t)n;
    return 0;
}
__declspec(noreturn) void ee_app_abort(const char *msg, size_t len) {
    fprintf(stderr, "FATAL (enclave-rt): %.*s\n", (int)len, msg);
    ExitProcess(70);
}

/* ---- the request frame, the same encoder the host half will use ------------------------- */
static unsigned char *put_u32(unsigned char *p, unsigned int v) { memcpy(p, &v, 4); return p + 4; }
static unsigned char *put_str(unsigned char *p, const char *s) {
    unsigned int n = (unsigned int)strlen(s); p = put_u32(p, n); memcpy(p, s, n); return p + n;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: ee-apptest <app.cwasm> [path] [world] [K=V ...]\n"); return 2; }
    const char *path = argc > 2 ? argv[2] : "/hello?name=enclave";
    const unsigned int world = argc > 3 ? (unsigned int)atoi(argv[3]) : 1;
    /* "K=V\0K=V\0\0", the same shape the enclave gate takes: this is how an ordinary app reads
     * its ENCLAVE_CONFIG, so the harness has to be able to pass one. */
    static unsigned char env[64 * 1024]; size_t env_len = 0;
    for (int i = 4; i < argc; i++) {
        const size_t n = strlen(argv[i]);
        if (env_len + n + 2 > sizeof env) break;
        memcpy(env + env_len, argv[i], n); env_len += n; env[env_len++] = 0;
    }
    if (env_len) env[env_len++] = 0;
    FILE *f = fopen(argv[1], "rb");
    if (!f) { fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    unsigned char *bytes = malloc(n);
    if (fread(bytes, 1, n, f) != (size_t)n) { fprintf(stderr, "short read\n"); return 2; }
    fclose(f);

    printf("enclave-rt abi %u, worlds 0x%x, %ld bytes of bytecode, world %u\n",
           ee_rt_abi(), ee_rt_worlds(), n, world);
    LARGE_INTEGER freq, t0, t1, t2; QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&t0);
    unsigned int id = ee_rt_open(bytes, (size_t)n, world, env_len ? env : NULL, env_len);
    QueryPerformanceCounter(&t1);
    if (!id) {
        unsigned char err[256]; size_t e = ee_rt_last_error(err, sizeof err);
        fprintf(stderr, "open failed: %.*s\n", (int)e, err);
        return 1;
    }
    printf("loaded as app %u in %.1f ms\n", id, (t1.QuadPart - t0.QuadPart) * 1000.0 / freq.QuadPart);

    unsigned char req[4096], *p = req;
    p = put_str(p, "GET");
    p = put_str(p, path);
    p = put_u32(p, 1);
    p = put_str(p, "x-from"); p = put_str(p, "vtl0-test");
    p = put_u32(p, 0);                                  /* no body */

    unsigned char out[256 * 1024]; size_t olen = 0;
    QueryPerformanceCounter(&t1);
    int rc = ee_rt_handle(id, req, (size_t)(p - req), out, sizeof out, &olen);
    QueryPerformanceCounter(&t2);
    if (rc != 0) {
        unsigned char err[256]; size_t e = ee_rt_last_error(err, sizeof err);
        fprintf(stderr, "handle rc=%d: %.*s\n", rc, (int)e, err);
        return 1;
    }
    /* decode: u16 status | u32 nheaders | (name,value)* | u32 body */
    unsigned char *q = out;
    unsigned short status; memcpy(&status, q, 2); q += 2;
    unsigned int nh; memcpy(&nh, q, 4); q += 4;
    printf("status %u in %.3f ms\n", status, (t2.QuadPart - t1.QuadPart) * 1000.0 / freq.QuadPart);
    for (unsigned int i = 0; i < nh; i++) {
        unsigned int ln, lv;
        memcpy(&ln, q, 4); q += 4; char *name = (char *)q; q += ln;
        memcpy(&lv, q, 4); q += 4; char *val = (char *)q; q += lv;
        printf("  %.*s: %.*s\n", (int)ln, name, (int)lv, val);
    }
    unsigned int lb; memcpy(&lb, q, 4); q += 4;
    printf("body: %.*s\n", (int)lb, (char *)q);
    ee_rt_close(id);
    return 0;
}
