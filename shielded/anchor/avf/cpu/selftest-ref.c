/* selftest-ref.c -- the pVM CPU capability self-test OUTSIDE the VM, for the parity reference (PVM-CPU.md).
 *
 * The same engine (liblocalengine.so and its libraries, taken from the pvm-cpu APK), the same staged model table
 * (anchor_gguf_stage: whole-file SHA-256 and per-tensor digests, the payload's exact code), the same fixed self-test
 * (engine_local.cpp SELFTEST_*), run natively on the phone's CPU as the shell user. It prints the model digest and the
 * self-test's output digest. That digest is
 *   - the reference the relay compares a VM's signed report with (PVM_CPU_MODELS[].selftestSha256), and
 *   - the parity check: a pVM that reports the same digest ran the same model through the same code to the same tokens.
 *
 *   selftest-ref <model.gguf> <lib_dir> [threads=6] [ctx=4096]
 * Build: cpu/build-selftest-ref.sh (NDK clang, the payload's flags). */
#include "anchor_gguf.h"
#include "anchor_pins.h"
#include <dlfcn.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int g_have = 0; static char g_digest[65];
static void hex(const uint8_t *b, size_t n, char *o) { static const char *H = "0123456789abcdef"; for (size_t i = 0; i < n; i++) { o[2 * i] = H[b[i] >> 4]; o[2 * i + 1] = H[b[i] & 15]; } o[2 * n] = 0; }
static void sink(const char *id, int tokens, double pf, double dc, const uint8_t d[32]) {
    hex(d, 32, g_digest); g_have = 1;
    printf("SELFTEST id=%s tokens=%d prefill_tok_s=%.2f decode_tok_s=%.2f output_sha256=%s\n", id, tokens, pf, dc, g_digest); fflush(stdout);
}
static int ctl_write(const char *s, size_t n) { fwrite(s, 1, n, stderr); return 0; }
static void *chat_peer(void *arg) {   /* read until READY, then end the engine: the self-test runs before READY */
    const int fd = *(int *)arg; char buf[4096]; size_t have = 0;
    for (;;) {
        const ssize_t r = read(fd, buf + have, sizeof buf - 1 - have); if (r <= 0) break; have += (size_t)r; buf[have] = 0;
        if (strstr(buf, "READY")) { (void)!write(fd, "BYE\n", 4); break; }
        if (have > sizeof buf - 256) have = 0;
    }
    return NULL;
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: selftest-ref <model.gguf> <lib_dir> [threads] [ctx]\n"); return 2; }
    const int threads = argc > 3 ? atoi(argv[3]) : 6, n_ctx = argc > 4 ? atoi(argv[4]) : 4096;
    const int fd = open(argv[1], O_RDONLY | O_CLOEXEC); if (fd < 0) { perror("model"); return 2; }
    const anchor_hash_ops h = { anchor_sha256_init, anchor_sha256_update, anchor_sha256_final };
    anchor_gguf_table t; memset(&t, 0, sizeof t); uint8_t pin[32]; char err[256] = "";
    if (!anchor_gguf_stage(fd, &t, &h, pin, err, sizeof err)) { fprintf(stderr, "stage: %s\n", err); return 2; }
    char mh[65]; hex(pin, 32, mh); printf("MODEL sha256=%s tensors=%zu\n", mh, t.n); fflush(stdout);
    static const char *libs[] = { "libc++_shared.so", "libggml-base.so", "libggml.so", "libllama.so", "libllama-common.so", "liblocalengine.so" };
    void *eng = NULL;
    for (size_t i = 0; i < sizeof libs / sizeof *libs; i++) {
        char p[1024]; snprintf(p, sizeof p, "%s/%s", argv[2], libs[i]);
        eng = dlopen(p, RTLD_NOW | RTLD_GLOBAL); if (!eng) { fprintf(stderr, "dlopen %s: %s\n", libs[i], dlerror()); return 2; }
    }
    int (*em)(int, int, const char *, int, int) = (int (*)(int, int, const char *, int, int))dlsym(eng, "engine_local_main");
    void (*setw)(int (*)(const char *, size_t)) = (void (*)(int (*)(const char *, size_t)))dlsym(eng, "engine_local_set_ctl_writer");
    void (*sett)(const anchor_gguf_table *, const anchor_hash_ops *) = (void (*)(const anchor_gguf_table *, const anchor_hash_ops *))dlsym(eng, "engine_local_set_model_table");
    void (*setst)(void (*)(const char *, int, double, double, const uint8_t *)) = (void (*)(void (*)(const char *, int, double, double, const uint8_t *)))dlsym(eng, "engine_local_set_selftest");
    if (!em || !setw || !sett || !setst) { fprintf(stderr, "the engine lacks engine_local_main or a setter (set_selftest needs the pvm-cpu engine)\n"); return 2; }
    setw(ctl_write); sett(&t, &h); setst(sink);
    int sv[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) { perror("socketpair"); return 2; }
    pthread_t th; pthread_create(&th, NULL, chat_peer, &sv[1]);
    const int rc = em(sv[0], fd, argv[2], threads, n_ctx);
    close(sv[0]); pthread_join(th, NULL); close(sv[1]);
    printf("ENGINE rc=%d selftest=%s\n", rc, g_have ? g_digest : "NONE");
    return g_have ? 0 : 1;
}
