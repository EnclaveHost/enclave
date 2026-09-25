/* rt_probe -- the portable runtime INSIDE the pVM (PVM-CPU.md, "The app runtime"; runtime/pvm-rt).
 * Loads libpvm_rt.so from the measured APK, reads the conformance component and its pinned digest from the APK's assets,
 * and runs the conformance vectors (runtime/conformance/vectors.json) through it: verify -> compile to Pulley in this VM
 * -> interpret. Also: a wrong digest must be refused before compilation, the memory limit and the deadline must stop a
 * runaway, and the process must hold no writable+executable mapping before or after. Prints RT_PROBE lines; a host-side
 * checker compares the stdout lines with vectors.json. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <android/log.h>
#include "vm_payload.h"
#define OUT(...) do { printf(__VA_ARGS__); printf("\n"); fflush(stdout); __android_log_print(ANDROID_LOG_INFO, "rt-probe", __VA_ARGS__); } while (0)

typedef int (*id_fn)(char *, size_t);
typedef void (*emit_fn)(int, const uint8_t *, size_t);
typedef int (*run_fn)(const uint8_t *, size_t, const uint8_t *, const char *const *, int, uint64_t, uint64_t, emit_fn, int *, uint64_t *, uint64_t *, char *, size_t);

static void emit(int stream, const uint8_t *p, size_t n) {   /* one RT_PROBE line per output line, with its stream */
    size_t s = 0;
    for (size_t i = 0; i <= n; i++) if (i == n || p[i] == '\n') { if (i > s || i < n) OUT("RT_PROBE %s %.*s", stream == 1 ? "stdout" : "stderr", (int)(i - s), (const char *)p + s); s = i + 1; }
}
static uint8_t *slurp(const char *path, size_t *n) {
    FILE *f = fopen(path, "rb"); if (!f) return NULL;
    fseek(f, 0, SEEK_END); long len = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *b = malloc((size_t)len); if (b && fread(b, 1, (size_t)len, f) != (size_t)len) { free(b); b = NULL; }
    fclose(f); *n = (size_t)len; return b;
}
static int unhex32(const char *h, uint8_t out[32]) { for (int i = 0; i < 32; i++) { unsigned v; if (sscanf(h + 2 * i, "%2x", &v) != 1) return 0; out[i] = (uint8_t)v; } return 1; }
static int wx_count(void) { FILE *m = fopen("/proc/self/maps", "r"); int n = 0; char l[1024]; if (!m) return -1;
    while (fgets(l, sizeof l, m)) { char perm[8] = ""; if (sscanf(l, "%*s %7s", perm) == 1 && strchr(perm, 'w') && strchr(perm, 'x')) n++; } fclose(m); return n; }

int AVmPayload_main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    AVmPayload_notifyPayloadReady();
    const char *apk = AVmPayload_getApkContentsPath();
    char p[1024];
    snprintf(p, sizeof p, "%s/lib/arm64-v8a/libpvm_rt.so", apk);
    void *h = dlopen(p, RTLD_NOW); if (!h) { OUT("RT_PROBE dlopen FAIL %s", dlerror()); return 2; }
    id_fn idf = (id_fn)dlsym(h, "pvmrt_identity"); run_fn run = (run_fn)dlsym(h, "pvmrt_run_cli");
    if (!idf || !run) { OUT("RT_PROBE symbols FAIL"); return 2; }
    char id[512]; idf(id, sizeof id); OUT("RT_PROBE identity %s", id);
    OUT("RT_PROBE wx_before=%d", wx_count());
    size_t n = 0, hn = 0;
    snprintf(p, sizeof p, "%s/assets/conformance-hello-v1.wasm", apk); uint8_t *bundle = slurp(p, &n);
    snprintf(p, sizeof p, "%s/assets/conformance-hello-v1.sha256", apk); uint8_t *hex = slurp(p, &hn);
    uint8_t want[32];
    if (!bundle || !hex || hn < 64 || !unhex32((const char *)hex, want)) { OUT("RT_PROBE assets FAIL (bundle or pin missing)"); return 2; }
    OUT("RT_PROBE bundle bytes=%zu pinned=%.64s", n, (const char *)hex);
    int fails = 0;
    static const char *const case0[] = { NULL }, *const case1[] = { "a", "b" }, *const case2[] = { "exit", "7" };
    struct { const char *name; const char *const *argv; int argc; } cases[] = { { "case0", case0, 0 }, { "case1", case1, 2 }, { "case2", case2, 2 } };
    for (int c = 0; c < 3; c++) {
        int ec = -99; uint64_t cms = 0, rms = 0; char err[512] = "";
        OUT("RT_PROBE begin %s", cases[c].name);
        const int rc = run(bundle, n, want, cases[c].argv, cases[c].argc, 256ull << 20, 60000, emit, &ec, &cms, &rms, err, sizeof err);
        OUT("RT_PROBE end %s rc=%d exit=%d compile_ms=%llu run_ms=%llu%s%s", cases[c].name, rc, ec, (unsigned long long)cms, (unsigned long long)rms, rc ? " err=" : "", err);
        if (rc) fails++;
    }
    {   /* refusal: one flipped bit of the pin -> never compiled */
        uint8_t bad[32]; memcpy(bad, want, 32); bad[0] ^= 1; int ec = -99; char err[512] = "";
        const int rc = run(bundle, n, bad, case0, 0, 256ull << 20, 60000, emit, &ec, NULL, NULL, err, sizeof err);
        const int ok = rc == -1 && strstr(err, "refusing to compile");
        OUT("RT_PROBE refusal digest %s (%s)", ok ? "PASS" : "FAIL", err); if (!ok) fails++;
    }
    {   /* the memory limit and the deadline */
        static const char *const al[] = { "alloc", "512" }, *const sp[] = { "spin" };
        int ec = -99; char err[512] = "";
        int rc = run(bundle, n, want, al, 2, 64ull << 20, 60000, emit, &ec, NULL, NULL, err, sizeof err);
        const int mem_ok = rc == -1 || ec != 0; OUT("RT_PROBE refusal memory %s (rc=%d exit=%d %s)", mem_ok ? "PASS" : "FAIL", rc, ec, err); if (!mem_ok) fails++;
        ec = -99; err[0] = 0;
        rc = run(bundle, n, want, sp, 1, 64ull << 20, 500, emit, &ec, NULL, NULL, err, sizeof err);
        const int dl_ok = rc == -1 && (strstr(err, "interrupt") || strstr(err, "epoch")); OUT("RT_PROBE refusal deadline %s (%s)", dl_ok ? "PASS" : "FAIL", err); if (!dl_ok) fails++;
    }
    const int wx = wx_count(); OUT("RT_PROBE wx_after=%d", wx); if (wx != 0) fails++;
    OUT("RT_PROBE done fails=%d", fails);
    return fails ? 1 : 0;
}
