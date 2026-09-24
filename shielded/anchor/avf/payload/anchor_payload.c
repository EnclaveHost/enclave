/*
 * anchor_payload -- the Shielded anchor's trusted half, running INSIDE a
 * protected VM on the phone, driving a REAL GPU worker.
 *
 * This is the property the whole search was for: the pad key, the pads,
 * u = r.W, the Freivalds secrets, the plaintext activation and every unmasked
 * product live in memory that pKVM has unmapped from the host -- the phone's
 * owner, with root, cannot read it.
 *
 * The VM is non-debuggable in production, so it has no console: everything
 * it says goes to its owner over vsock, and everything it needs arrives the
 * same way. Two listeners, both accepted from the host app's connectVsock():
 *
 *   7777  control   host -> guest:  CHAL <64 hex>            attestation challenge
 *                                   WORKER bridge|local      where the GEMMs go
 *                                   SHAPE K N nodes iters xmax   (repeatable; xmax 0 = auto)
 *                                   RUN
 *                   guest -> host:  ATTEST/CERT/SIG lines, one JSON line per shape, END
 *   7778  worker    one connection per shape; the host bridges it to a TCP
 *                   shielded worker. Only ciphertext frames cross it, which is
 *                   the phone topology's socket rule made concrete.
 *
 * The per-shape flow is harness/split-harness.c verbatim, fixture and all, so
 * a pVM run against the same worker must reproduce the x86 and S21+ digests
 * in REPORT.md section 3 bit for bit (invariant 6).
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include "shielded-avf-binding.h"
#include "shielded-pad-grant.h"
#include "anchor_maskbench.h"
#include "output_mask_speed.h"
#include "chacha4_check.h"
#include "anchor_pins.h"
#include "anchor_public_file.h"
#include "exbench.h"
#include "anchor_model_cache.h"   /* the model stage's retained-model decision (cache=only): pure, host-fixtured */
#include "anchor_names.h"
#include "anchor_gguf.h"
#include "linkbench.h"   /* bench_ms: pure, and tested against hostile peers in tpu/test/linkbench-test.c */
#include "../host/anchor-frame-loop.h"
#include "anchor_copy.h"
#include <fcntl.h>
#include <inttypes.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/stat.h>
#include <linux/userfaultfd.h>
#include <linux/fsverity.h>
#include <sys/syscall.h>
#include <sys/ioctl.h>
#include <sys/sysinfo.h>
#include <sys/vfs.h>
#include <sys/statvfs.h>
#include <dirent.h>
#include <linux/vm_sockets.h>
#include <time.h>
#include <unistd.h>
#include <android/log.h>

#include "vm_payload.h"
#include "third_party/tweetnacl.h"
#include "anchor-core.h"
#include "shielded-field.h"
#include "shielded-simd.h"
#include "shielded-wire.h"
#include "worker-client.h"
#include "fixture.h"

#define TAG "anchor-pvm"
#define CTRL_PORT   7777

/* The transport key: an Ed25519 pair minted INSIDE the VM at every boot, the
 * identity the relay pins this tunnel to (keyFp = sha256 of its SPKI) and the
 * thing the attested key vouches for by signing (SPKI || nonce). The secret
 * half never leaves the VM. TweetNaCl (public domain) does the arithmetic;
 * randombytes() below is the guest's getrandom. */
static unsigned char g_tpk[32], g_tsk[64];
#ifdef ANCHOR_TIER_PVM_CPU
/* The VM INSTANCE's key (INSTANCE-BINDING.md, evidence v3): Ed25519 seeded from AVmPayload_getVmInstanceSecret, so the same
 * instance derives the same key after a restart or a reboot, a new instance another, and the host never sees the seed.
 * InstanceID = SHA-256(its SPKI). g_inst: derived this boot. The seeded key pair is third_party/tweetnacl.c's Enclave
 * addition, declared here because wasm/ggml-shielded/tweetnacl.h (same include guard) is the header in effect. */
static unsigned char g_ipk[32], g_isk[64]; static int g_inst = 0;
extern int crypto_sign_ed25519_tweet_seed_keypair(unsigned char *pk, unsigned char *sk, const unsigned char *seed);
#endif
#ifdef ANCHOR_TIER_PVM_CPU
/* pVM CPU capability report (PVM-CPU.md, relay/pvm-cpu-tier.mjs): the nonce it answers and the VM clock at the attestation.
 * kind 2 = the relay's nonce from this pVM's own v2 binding (admissible); 1 = the owner's bare challenge (evidence only). */
static uint8_t g_caps_nonce[32]; static int g_caps_nonce_kind = 0; static uint64_t g_caps_attach_ms = 0;
static int g_caps_threads = 0, g_caps_ctx = 0; static uint64_t g_caps_model_bytes = 0;
static uint64_t boot_ms(void) { struct timespec ts; clock_gettime(CLOCK_BOOTTIME, &ts); return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u; }
#endif
static uint8_t g_ppk[32];   /* the pad key, defined with its secret half below; attest() checks the app's BOUND against it */
void randombytes(unsigned char *p, unsigned long long n) {
    while (n) { ssize_t r = getrandom(p, (size_t)n, 0); if (r <= 0) abort(); p += r; n -= (unsigned long long)r; }
}
static const uint8_t ED25519_SPKI_PREFIX[12] = { 0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00 };
#define WORKER_PORT 7778
#ifdef ANCHOR_TIER_PVM_CPU
#define ANCHOR_TIER_NAME "pvm-cpu"   /* PVM-CPU.md: CPU-only, mode local only; the build's codeHash is what the relay admits */
#else
#define ANCHOR_TIER_NAME "research"  /* the combined build: local, split engine, TPU lane (closed, TPU.md); never admitted as pvm-cpu */
#endif
#define MODEL_PORT  7779
#define PADS_PORT   7780     /* owner -> guest: dealt-pad shipments into the bank dir (PADS <name> <bytes>\n, bytes) */
#define ECHO_PORT   7780
#define BUNDLE_PORT 7782     /* owner -> guest: the PUBLIC Shielded-TPU lane bundle (u64 size; 'K' = already stored at that size, 'S' = send) */
#define APP_PORT    7785     /* owner -> guest: a portable WebAssembly component (the APP line; anchor_public_file.h framing) */
#define APP_HTTP_PORT 7786   /* owner -> guest: HTTP/1.1 to a served wasi:http app (APP ... serve=http), one connection at a time */
#define DRAFT_PORT  7783     /* owner -> guest: an optional drafter GGUF for speculative rows (same framing as the bundle port) */
#define BENCH_PORT  7784     /* owner -> guest: link-scaling benchmark connections ONLY (tpu_link_bench). A SEPARATE
                              * port on purpose: the benchmark links were first opened on WORKER_PORT alongside the
                              * real worker, and since the app starts both sets of threads at once while the real
                              * worker loads 35 graphs before it dials, accept ORDER could not tell them apart -- a
                              * benchmark link could have been handed to the lane as the worker. Role is now decided
                              * by port, which cannot race. */
#define LOCAL_PORT  7781     /* owner -> guest: the local engine's conversation (engine_local.cpp: GEN/RESET/BYE in, TXT/STATS/ERR out) */
#define MAX_SHAPES  16

/* ---- the mouth: every line to stdout (debug VMs), logcat, and the control vsock ---- */
static int g_ctl = -1; static volatile int g_ctl_dead = 0;   /* the control thread owns g_ctl (opens, closes); other threads only write, and stop after one failure */
static void outf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static pthread_mutex_t g_out_mu = PTHREAD_MUTEX_INITIALIZER;   /* the control channel is a stream: two threads' lines must not interleave */
/* One whole line to the control channel under the writers' lock; the engine (a separate .so) is
 * handed this through engine_set_ctl_writer so its lines and the receiver thread's never mix.
 * Exported on purpose. 0 = written, -1 = the channel is gone (no further attempts). */
__attribute__((visibility("default"))) int anchor_ctl_write(const char *p, size_t n) {
    int rc = -1;
    pthread_mutex_lock(&g_out_mu);
    if (g_ctl >= 0 && !g_ctl_dead) {
        rc = 0;
        while (n) { ssize_t w = write(g_ctl, p, n); if (w <= 0) { if (w < 0 && errno == EINTR) continue; g_ctl_dead = 1; rc = -1; break; } p += w; n -= (size_t)w; }
    }
    pthread_mutex_unlock(&g_out_mu);
    return rc;
}
/* A BOUNDED sibling of anchor_ctl_write, for the opt-in quiet handshake only.
 * Same descriptor, SAME writers' lock - it does not bypass serialisation - but it
 * gives up instead of blocking: the ordinary writer holds g_out_mu across a
 * blocking write, so once the control buffer fills it pins the lock and every
 * later line, including a resume, blocks behind it.
 *
 * 0 = the whole line went out. -1 = NOTHING was written (the lock or the socket
 * was not ready in time), which the caller can recover from. -2 = a PARTIAL
 * write: a fragment is on the wire, the peer will parse it as a line, and the
 * channel is marked dead because nothing after it can be trusted. Nothing else
 * in the payload calls this, so the ordinary path is untouched. */
__attribute__((visibility("default"))) int anchor_ctl_write_timed(const char *p, size_t n, uint64_t deadline_ns) {
    if (!p || !n) return -1;
    for (;;) {
        if (pthread_mutex_trylock(&g_out_mu) == 0) break;
        struct timespec ts;
        if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return -1;
        const uint64_t now = (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
        if (now >= deadline_ns) return -1;
        struct timespec nap = { 0, 200000 }; nanosleep(&nap, NULL);
    }
    size_t done = 0;
    if (g_ctl >= 0 && !g_ctl_dead) {
        while (done < n) {
            struct timespec ts;
            if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) break;
            const uint64_t now = (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
            if (now >= deadline_ns) break;
            uint64_t left_ms = (deadline_ns - now) / 1000000ull;
            if (left_ms > 100) left_ms = 100;
            struct pollfd pf; pf.fd = g_ctl; pf.events = POLLOUT; pf.revents = 0;
            const int pr = poll(&pf, 1, (int)left_ms);
            if (pr < 0) { if (errno == EINTR) continue; g_ctl_dead = 1; break; }
            if (pr == 0) continue;
            /* Writable, but the deadline may have passed while poll returned: check
             * BEFORE the send, not after it, so a transaction that has run out of
             * time never puts more bytes on the wire. */
            if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) break;
            if ((uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec >= deadline_ns) break;
            const ssize_t w = send(g_ctl, p + done, n - done, MSG_DONTWAIT | MSG_NOSIGNAL);
            if (w > 0) { done += (size_t)w; continue; }
            if (w < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
            g_ctl_dead = 1; break;
        }
    }
    const int rc = done == n ? 0 : (done ? -2 : -1);
    if (rc == -2) g_ctl_dead = 1;   /* a fragment is on the wire: refuse every later write */
    pthread_mutex_unlock(&g_out_mu);
    return rc;
}

static void outf(const char *fmt, ...) {
    char line[4096]; va_list ap; va_start(ap, fmt); int n = vsnprintf(line, sizeof line - 1, fmt, ap); va_end(ap);
    if (n < 0) return; if ((size_t)n > sizeof line - 2) n = sizeof line - 2;
    line[n] = '\n'; line[n + 1] = 0;
    fputs(line, stdout); fflush(stdout);
    __android_log_print(ANDROID_LOG_INFO, TAG, "%.*s", n, line);
    anchor_ctl_write(line, (size_t)n + 1);
}
/* Only the control thread closes the control channel, under the writers' lock, so no writer ever
 * touches a closed (and possibly reused) descriptor. */
static void ctl_close(void) {
    pthread_mutex_lock(&g_out_mu);
    if (g_ctl >= 0) { shutdown(g_ctl, SHUT_WR); close(g_ctl); g_ctl = -1; }
    g_ctl_dead = 1;
    pthread_mutex_unlock(&g_out_mu);
}
#define OUT(...) outf(__VA_ARGS__)

static void hexline(const char *label, const uint8_t *p, size_t n) {
    const size_t CH = 512;
    OUT("%s bytes=%zu chunks=%zu", label, n, (n + CH - 1) / CH);
    for (size_t off = 0; off < n; off += CH) {
        size_t m = n - off < CH ? n - off : CH; char s[CH * 2 + 1];
        for (size_t i = 0; i < m; i++) sprintf(s + 2 * i, "%02x", p[off + i]);
        s[2 * m] = 0; OUT("%s[%zu] %s", label, off / CH, s);
    }
}

/* ---- vsock listeners: bound before notifyPayloadReady, accepted when the owner arrives ---- */
static int vs_bind(unsigned port) {
    int ls = socket(AF_VSOCK, SOCK_STREAM, 0);
    if (ls < 0) return -1;
    struct sockaddr_vm sa = { .svm_family = AF_VSOCK, .svm_port = port, .svm_cid = VMADDR_CID_ANY };
    if (bind(ls, (struct sockaddr *)&sa, sizeof sa) != 0 || listen(ls, 4) != 0) { close(ls); return -1; }
    return ls;
}
static int vs_accept(int ls, int grace_ms) {
    if (ls < 0) return -1;
    struct pollfd pf = { .fd = ls, .events = POLLIN };
    if (poll(&pf, 1, grace_ms) <= 0) return -1;
    return accept(ls, NULL, NULL);
}
static int read_line(int fd, char *buf, size_t cap) {
    size_t n = 0;
    while (n + 1 < cap) { char c; ssize_t r = read(fd, &c, 1); if (r <= 0) return -1; if (c == '\n') break; buf[n++] = c; }
    buf[n] = 0; return (int)n;
}

/* ---- attestation: the certificate a verifier will check, bound to the owner's challenge ---- */
static size_t unhex(const char *hex, uint8_t *out, size_t cap) {
    size_t n = 0;
    for (; n < cap && hex[2 * n] && hex[2 * n + 1]; n++) { unsigned v; if (sscanf(hex + 2 * n, "%2x", &v) != 1) break; out[n] = (uint8_t)v; }
    return n;
}
/* Request the certificate over `hex` (32 bytes) and sign `bound_hex` with the
 * attested key: the relay's binding is challenge = sha256(SPKI || nonce) and
 * signature over (SPKI || nonce). Ends with "ATTEST end" whatever happened. */

static void sha256(const uint8_t *m, size_t n, uint8_t out[32]) { anchor_sha256(m, n, out); }

/* The attested key signs exactly one thing: this pVM's own pad-binding transcript (PAD-BOOTSTRAP.md,
 * android-avf-pvm/v2): domain || OUR transport SPKI || OUR pad key || the relay's nonce, and the
 * certificate challenge is sha256 of it. Whatever the app forwards as BOUND is checked against the
 * keys generated in here; anything else gets a certificate over the app's challenge (routing only)
 * but NO signature - a measured payload must not be a signing oracle for keys it does not hold. */
static void attest(const char *hex, const char *bound_hex) {
    uint8_t ch[32] = {0}; unhex(hex, ch, 32);
    uint8_t bound[1024]; size_t blen = unhex(bound_hex, bound, sizeof bound);
    int own = 0;
    if (blen) {
        uint8_t want[32]; sha256(bound, blen, want);
        own = sh_avf_pad_binding_valid(bound, blen, g_tpk, g_ppk) && memcmp(want, ch, 32) == 0;
        if (!own) OUT("ATTEST refused to sign: BOUND is not this pVM's pad binding (v2 transcript over its own keys) or the challenge is not its sha256");
        else OUT("ATTEST binding: android-avf-pvm/v2 transcript over this pVM's own transport and pad keys, challenge = its sha256");
    } else OUT("ATTEST no BOUND: certificate only, nothing signed");
#ifdef ANCHOR_TIER_PVM_CPU
    if (own && blen >= 32) { memcpy(g_caps_nonce, bound + blen - 32, 32); g_caps_nonce_kind = 2; }   /* v2: the relay's nonce closes the transcript */
    else { memcpy(g_caps_nonce, ch, 32); g_caps_nonce_kind = 1; }
    g_caps_attach_ms = boot_ms();
#endif
    AVmAttestationResult *res = NULL;
    AVmAttestationStatus st = AVmPayload_requestAttestation(ch, sizeof ch, &res);
    OUT("ATTEST status=%s code=%d", AVmAttestationStatus_toString(st), (int)st);
    if (st == ATTESTATION_OK && res) {
        size_t n = AVmAttestationResult_getCertificateCount(res);
        OUT("ATTEST certs=%zu", n);
        for (size_t i = 0; i < n; i++) {
            size_t sz = AVmAttestationResult_getCertificateAt(res, i, NULL, 0);
            uint8_t *c = malloc(sz); if (!c) continue;
            AVmAttestationResult_getCertificateAt(res, i, c, sz);
            char label[24]; snprintf(label, sizeof label, "CERT%zu", i); hexline(label, c, sz); free(c);
        }
        if (own) {
            size_t ssz = AVmAttestationResult_sign(res, bound, blen, NULL, 0);
            uint8_t *sig = malloc(ssz);
            /* print what THIS signing produced: the size query signs too, and an ECDSA P-256 DER signature is 70-72 bytes,
             * so the second may be shorter than the first; printing the query's size appended a zero byte and the relay
             * refused the signature (the first live attach, results/pvm-cpu-live-attach) */
            if (sig) { const size_t n = AVmAttestationResult_sign(res, bound, blen, sig, ssz); hexline("SIG", sig, n < ssz ? n : ssz); free(sig); }
        }
        AVmAttestationResult_free(res);
    }
    OUT("ATTEST end");
}

/* ---- the untrusted half: a real worker over the bridge, or the in-guest stand-in ---- */
typedef struct {
    int bridge;
    wc_client wc;
    /* local stand-in */
    const int8_t *const *W; int64_t K; const int64_t *N; int n;
    int64_t *xm; uint8_t *reply; size_t rlen;
} wk;

static int wk_exchange(wk *w, const int8_t *planes, const uint8_t **reply, size_t *len, int *ywidth) {
    if (w->bridge) { int rc = wc_exchange(&w->wc, planes, 1, reply, len); *ywidth = w->wc.ywidth; return rc == SH_OK; }
    const int8_t *p0 = planes, *p1 = planes + w->K, *p2 = planes + 2 * w->K;
    for (int64_t k = 0; k < w->K; k++) w->xm[k] = sh_crt(p0[k], p1[k], p2[k]);
    size_t off = 0;
    for (int nd = 0; nd < w->n; nd++)
        for (int64_t j = 0; j < w->N[nd]; j++) {
            const int8_t *row = w->W[nd] + j * w->K; int64_t acc = 0;
            for (int64_t k = 0; k < w->K; k++) acc += w->xm[k] * row[k];
            int32_t b = (int32_t)sh_balanced(acc); memcpy(w->reply + off, &b, 4); off += 4;
        }
    *reply = w->reply; *len = w->rlen; *ywidth = 4; return 1;
}

static int rng_os(void *buf, size_t n) {
    uint8_t *p = buf;
    while (n) { ssize_t r = getrandom(p, n, 0); if (r < 0) return -1; p += r; n -= (size_t)r; }
    return 0;
}
static double now_us(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e6 + t.tv_nsec / 1e3; }
static int cmp_d(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : x > y; }
static double median(double *v, int n) { qsort(v, (size_t)n, sizeof *v, cmp_d); return v[n / 2]; }

/* The refill kernel, generic vs SDOT, on THE SAME thread back to back, so the
 * comparison is the kernel and not which core the scheduler handed the VM's
 * vCPU this second (the /foreground cpuset mixes A510s and A715s). Interleaved
 * rounds, best of each; the outputs must agree byte for byte. */
static void bench_refill(int64_t K, int64_t N) {
    int8_t *W = malloc((size_t)K * N); uint8_t *planes = malloc((size_t)3 * K);
    int32_t *ug = malloc((size_t)N * 4), *un = malloc((size_t)N * 4), *acc = malloc((size_t)12 * N * 4);
    if (!W || !planes || !ug || !un || !acc) return;
    uint32_t s = 0x9e3779b9u;
    for (int64_t i = 0; i < K * N; i++) { s = s * 1103515245u + 12345u; W[i] = (int8_t)((int)((s >> 8) % 239) - 119); }
    for (int64_t i = 0; i < 3 * K; i++) { s = s * 1103515245u + 12345u; planes[i] = (uint8_t)((s >> 8) % 251); }
    double bg = 1e18, bn = 1e18;
    for (int round = 0; round < 5; round++) {
        double t0 = now_us(); sh_simd_generic_refill(planes, 1, W, K, N, ug, N, acc); double t1 = now_us();
        sh_simd_neon_refill(planes, 1, W, K, N, un, N, acc); double t2 = now_us();
        if (t1 - t0 < bg) bg = t1 - t0; if (t2 - t1 < bn) bn = t2 - t1;
    }
    OUT("{\"bench\":\"refill\",\"K\":%" PRId64 ",\"N\":%" PRId64 ",\"generic_us\":%.1f,\"neon_sdot_us\":%.1f,\"speedup\":%.2f,\"agree\":%s,\"gmac_s\":{\"generic\":%.2f,\"neon\":%.2f}}",
        K, N, bg, bn, bg / bn, memcmp(ug, un, (size_t)N * 4) == 0 ? "true" : "false",
        12.0 * K * N / bg / 1e3, 12.0 * K * N / bn / 1e3);   /* the kernel dots 3 planes x 4 rows per weight row */
    free(W); free(planes); free(ug); free(un); free(acc);
}

/* ---- ENGINE mode: the whole inference engine in this VM (PLAN.md phase 3, steps 5-6) ----
 * The owner streams the public model over vsock 7779 into a file of ours (a memfd, or /data
 * when the VM has encrypted storage), bridges the worker on 7778, and this dlopens the
 * libraries from the APK (RTLD_GLOBAL, dependency order) and hands everything to
 * libengine.so's engine_main. Nothing here touches a secret: the model is public, the
 * worker sees ciphertext, and the calibration is public data under the attested codeHash. */
static int read_exact(int fd, void *buf, size_t n) {
    uint8_t *p = buf; while (n) { ssize_t r = read(fd, p, n); if (r <= 0) return -1; p += r; n -= (size_t)r; } return 0;
}
/* Where the model lives: the VM's encrypted storage when the owner attached some
 * (persistent per VM instance, so the stream happens once), else a memfd
 * (which this payload domain is denied on the phone, measured EACCES), else
 * /data. `*existing` says a same-sized file was already there. */
/* The cache key: the owner's claimed sha256 of the model, kept in a sidecar next
 * to the file once a stream completed. The model is public data, so a wrong
 * claim costs output quality, never a secret; the sidecar is what makes a
 * same-sized different model stream again instead of being mistaken for cached. */
static char g_model_sha[80] = "";
static void sidecar_path(char *out, size_t cap, const char *es) { snprintf(out, cap, "%s/model.gguf.sha256", es); }
/* MODEL … cache=only (g_model_cache_only): a retained model is reused exactly as today; a miss receives NOTHING and leaves the
 * store untouched (no tag unlink, no O_TRUNC, no memfd, no /data): the owner learns 'N' and the reason. Default = today. */
static int g_model_cache_only = 0, g_model_cache_verdict = -1;
/* ARTIFACT_PROFILE 0|1 (anchor_artifact_profile_parse): the owner's explicit switch for the artifact receive profiler; PREPARE
 * carries no ENGINE environment, so this line is how a preparation run turns it on. -1 = never sent (off unless the ENGINE
 * environment asks); a malformed or repeated line refuses the run at RUN (never silently off). */
static int g_artifact_profile = -1, g_artifact_profile_bad = 0;
/* PADWINDOW 0|8192 (control line, strict, once, acknowledged before the owner starts any pads-port
 * sender): the vsock receive credit window of the PAD LISTENER. An accepted child inherits
 * buffer_size from its parent, and its first credit advertisement carries it, so 8192 bounds what the
 * host may allocate per packet. 0 = default: nothing is set, nothing is read back, nothing is logged.
 * The line must be EXACTLY "PADWINDOW 0" or "PADWINDOW 8192": anything else on a line beginning with
 * PADWINDOW (a bare command, a sign, a leading zero, trailing text) is refused, and a refusal here -
 * like a failed setsockopt or readback - refuses the run at RUN. An accepted child that reads back
 * wrong stops the receiver and is said publicly, so the owner ends the run. There is no silent
 * fallback to the default: the whole point of the experiment is knowing which window was measured.
 * The accepted children's count lives in the receiver thread (a local), never in a global another
 * thread reads. */
static int g_pad_window = 0, g_pad_window_seen = 0, g_pad_window_bad = 0;
static int model_file(uint64_t bytes, int *existing) {
    *existing = 0;
    const char *es = AVmPayload_getEncryptedStoragePath();
    if (es) {
        const int fd = anchor_model_open(es, bytes, g_model_sha[0] ? g_model_sha : "", g_model_cache_only, existing, &g_model_cache_verdict);   /* anchor_model_cache.h, host-fixtured */
        if (fd >= 0 || fd == -2) return fd;
        OUT("ENGINE encrypted storage %s/model.gguf: %s", es, strerror(errno));
    }
    else if (g_model_cache_only) { g_model_cache_verdict = ANCHOR_MODEL_MISS_ABSENT; return -2; }   /* no store at all: cache-only can only miss, and touches nothing */
    int fd = memfd_create("model", 0);
    if (fd >= 0 && ftruncate(fd, (off_t)bytes) == 0) return fd;
    OUT("ENGINE memfd: fd=%d ftruncate errno=%d (%s)", fd, errno, strerror(errno));
    if (fd >= 0) close(fd);
    fd = open("/data/anchor-model.gguf", O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (fd >= 0 && ftruncate(fd, (off_t)bytes) == 0) return fd;
    if (fd >= 0) close(fd);
    return -1;
}
/* The stream: 8-byte length from the owner, one byte back ('K' = keep, I have
 * it; 'S' = send), then the bytes. */
static int write_all(int fd, const char *p, size_t n);   /* defined with the receiver below; the durable cache tag uses them too */
static int dir_sync(const char *dir);
static int receive_model(int ls_model, uint64_t bytes, int *out_fd) {
    int c = vs_accept(ls_model, 60000);
    if (c < 0) { OUT("ENGINE no model stream from the owner"); return -1; }
    uint64_t hdr = 0; if (read_exact(c, &hdr, 8) != 0 || hdr != bytes) { OUT("ENGINE model stream header %" PRIu64 " != %" PRIu64, hdr, bytes); close(c); return -1; }
    int existing = 0, fd = model_file(bytes, &existing);
    if (fd == -2) {                                                        /* cache-only miss: 'N' = not retained, nothing streamed, nothing changed */
        const char *why = "no encrypted store"; if (AVmPayload_getEncryptedStoragePath()) anchor_model_retained(AVmPayload_getEncryptedStoragePath(), bytes, g_model_sha[0] ? g_model_sha : "", &why);
        (void)!write(c, "N", 1); close(c); OUT("ENGINE model not retained (cache-only): %s; store unchanged, nothing received", why); return -1;
    }
    if (fd < 0) { OUT("ENGINE nowhere to put %" PRIu64 " bytes of model (encrypted storage, memfd and /data all refused)", bytes); close(c); return -1; }
    if (existing) { (void)!write(c, "K", 1); close(c); OUT("ENGINE model %" PRIu64 " MiB already in the VM's encrypted storage", bytes >> 20); *out_fd = fd; return 0; }
    (void)!write(c, "S", 1);
    /* the stream lands in 200 MiB steps so the owner sees progress; every step is an exact copy (EINTR/short
     * writes handled), and a failure closes BOTH descriptors and remembers nothing */
    uint64_t got = 0; double t0 = now_us(); char why[160];
    while (got < bytes) {
        const uint64_t step = bytes - got < (200u << 20) ? bytes - got : (200u << 20); uint64_t part = 0;
        if (anchor_copy_exact(c, fd, step, &part, why, sizeof why) != 0) { got += part; OUT("ENGINE model stream failed at %" PRIu64 ": %s", got, why); close(c); close(fd); return -1; }
        /* the VM's page cache must not swell with the model: written bytes are synced and dropped step by step
         * (an 8 GiB guest filling its cache with 27 GB got the app killed by the phone's low-memory killer) */
        if (anchor_fsync_retry(fd) == 0) posix_fadvise(fd, (off_t)got, (off_t)part, POSIX_FADV_DONTNEED);
        got += part;
        if (got < bytes) OUT("ENGINE model %" PRIu64 " MiB received", got >> 20);
    }
    close(c);
    if (anchor_fsync_retry(fd) != 0) { OUT("ENGINE model fsync failed: %s (reception not remembered)", strerror(errno)); close(fd); return -1; }
    if (g_model_sha[0] && AVmPayload_getEncryptedStoragePath()) {    /* remember what this file is, ONLY now that it is durable */
        /* the tag itself must be durable too: a short run (PREPARE) can end seconds after this write, and an unsynced tag
         * is lost while the fsynced model survives, so the next boot re-streams a model it already holds (seen 2026-09-09:
         * 43 s copy on a warm store). Temp + fsync + rename + directory fsync, like every other published file here. */
        const char *es = AVmPayload_getEncryptedStoragePath(); char side[512], stmp[520]; sidecar_path(side, sizeof side, es); snprintf(stmp, sizeof stmp, "%s.tmp", side);
        int sfd; do { sfd = open(stmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600); } while (sfd < 0 && errno == EINTR);
        int ok = sfd >= 0;
        if (ok) { char line[66]; const int n = snprintf(line, sizeof line, "%s\n", g_model_sha); ok = n > 0 && write_all(sfd, line, (size_t)n) == 0 && anchor_fsync_retry(sfd) == 0; close(sfd); }
        if (ok) ok = rename(stmp, side) == 0 && dir_sync(es) == 0;
        if (!ok) { unlink(stmp); OUT("ENGINE model cache tag not published (%s): the model will be received again next boot", strerror(errno)); }
    }
    OUT("ENGINE model %" PRIu64 " MiB received in %.1f s", got >> 20, (now_us() - t0) / 1e6);
    *out_fd = fd; return 0;
}
/* ---- dealt pads (shielded/dealer/PLAN.md, anchor_pads.h) -------------------
 * The VM mints an X25519 pad key at boot and announces it (PADKEY) right after
 * the transport key; the owner presents it to the relay with the attestation.
 * The platform's seed comes back boxed to that key (PADSEED); requests the
 * owner relays are signed here with the transport key (PADSIGN); windows the
 * engine asks for go out as PADWIN and come back verified against the ledger
 * key (PADLEDGER). Shipments stream in on PADS_PORT into the bank directory. */
#include "anchor_pads.h"
#include "shielded-pads.h"
#include "anchor_catalog.h"
#include "anchor_encoded_catalog.h"
#include "anchor_artifacts.h"
#include "anchor_model_auth.h"
#include "anchor_auth.h"
#include "anchor_prepare.h"
#include "anchor_local.h"
#include "anchor_app.h"
#include "pvmrt_nn.h"
#include "anchor_rxctl.h"
static uint8_t g_ppk[32], g_psk[32], g_ledger_pk[32], g_seed[32], g_seed_id[16];
/* Authenticated bootstrap (PAD-BOOTSTRAP.md). The ledger key comes from the measured APK
 * (assets/ledger.pk) when present: then PADLEDGER from the app must match, only signed grants
 * install a seed, and the old unsigned PADSEED is refused. Without the asset (a dev build) the
 * app's PADLEDGER is taken and the legacy path stays open, loudly. */
static int g_ledger_pinned = 0, g_req_pending = 0;
static anchor_pins g_pins;                 /* the measured pins (anchor_pins.h); g_pins.mode == ANCHOR_MODE_INVALID = fail closed */
/* The model stage (MODEL <bytes>): the model is received (or found cached), then the descriptor that
 * will be parsed is hashed and judged - pin and, once a seed is granted, the grant's digest - BEFORE
 * anything reads it. A later ENGINE line with other bytes re-receives and re-judges; a swap after the
 * grant is refused. g_model_state: 0 nothing usable, 1 hashed and judged usable. */
static int g_model_fd = -1, g_model_state = 0, g_ls_model = -1; static uint64_t g_model_fd_bytes = 0;
static uint8_t g_model_digest[32], g_grant_model[32];
/* The staged model's per-tensor digest table (27B-FEASIBILITY.md s.11): produced by the SAME read that
 * produced the pin, so a consumer that hashes the tensor bytes it takes can tell a page the store served
 * differently. RAM only; dropped whenever the stage is invalidated. */
static anchor_gguf_table g_model_table;
static const anchor_hash_ops g_hash_ops = { anchor_sha256_init, anchor_sha256_update, anchor_sha256_final };
/* Catalog mode (CATALOG.md; encoded-artifact-delivery-design.md). MODEL/ENGINE lines carrying " auth=catalog" ask
 * for it; the measured pins decide whether it is admissible; the default is the whole-file scan, byte for byte as
 * before. Admission is at most ONCE per VM session and the admitted catalogs are never freed: the pads-port
 * receiver thread and the engine's artifact hook borrow entries from them without a lock because nothing ever
 * mutates or frees them. g_auth_mode is the mode of the STAGED model (1 whole-file-sha256, 2 catalog-v1); a line
 * asking for the other mode after a stage is refused, never silently honoured. */
static anchor_catalog_table g_cat; static anchor_encoded_catalog g_ecat;
static int g_cat_admitted = 0, g_auth_mode = 0, g_auth_catalog_requested = 0, g_art_dirfd = -1;
static const anchor_gguf_table *g_staged_table = NULL;   /* &g_model_table (mode 1) or &g_cat.table (mode 2) */
static char g_req_name[65]; static uint8_t g_req_nonce[32], g_req_model[32], g_req_calib[32];
/* The calibration's identity as shielded-dealer records it: SHA-512/256 of the WHOLE file. 1 when the
 * file was read completely (size checked against fstat, read errors refused); 0 otherwise, out zeroed - a
 * digest of a truncated calibration must never be requested, granted or pinned. */
static int calib_digest_file(const char *path, uint8_t out[32]) {
    memset(out, 0, 32);
    FILE *cf = fopen(path, "rb"); if (!cf) return 0;
    struct stat st; if (fstat(fileno(cf), &st) != 0 || st.st_size <= 0 || st.st_size > (64 << 20)) { fclose(cf); return 0; }
    const size_t want = (size_t)st.st_size; uint8_t *cb = (uint8_t *)malloc(want);
    if (!cb) { fclose(cf); return 0; }
    const size_t n = fread(cb, 1, want, cf); const int bad = ferror(cf); fclose(cf);
    int ok = 0;
    if (!bad && n == want) { uint8_t dg[64]; crypto_hash(dg, cb, n); memcpy(out, dg, 32); ok = 1; }
    free(cb);
    return ok;
}
static int calib_digest32(uint8_t out[32]) { return calib_digest_file("/mnt/apk/assets/model.calib", out); }
static char g_seed_id_hex[33] = "", g_pad_name[65] = "", g_pads_dir[512] = "";   /* a 64-char name plus its NUL */
static int g_have_ledger = 0, g_have_seed = 0;
/* What a delivery acknowledgment (PAD-ACK.md) is signed for: the seed, the tunnel name and the
 * CALIBRATION digest of the grant in force (the shipment header carries first32(SHA-512(calib)),
 * never the GGUF's SHA-256), taken as one snapshot under a lock so a new grant on the control
 * thread cannot split a receiver thread's validation from its signature. */
typedef struct { int valid; uint8_t seed_id[16]; char seed_id_hex[33]; char name[65]; uint8_t calib[32]; } ack_identity;
static pthread_mutex_t g_ack_mu = PTHREAD_MUTEX_INITIALIZER;
static ack_identity g_ack;
static void ack_identity_set(const uint8_t seed_id[16], const char *sid_hex, const char *name, const uint8_t calib[32]) {
    ack_identity id; memset(&id, 0, sizeof id);
    memcpy(id.seed_id, seed_id, 16); strncpy(id.seed_id_hex, sid_hex, 32); strncpy(id.name, name, 64); memcpy(id.calib, calib, 32); id.valid = 1;
    pthread_mutex_lock(&g_ack_mu); g_ack = id; pthread_mutex_unlock(&g_ack_mu);
}
static char g_prefix_pk_hex[65] = "";        /* PREFIXPK: the platform's shared-prefix key the engine pins (prefix-kv.h) */
static void pads_dir(char *out, size_t cap) {
    const char *es = AVmPayload_getEncryptedStoragePath();
    if (es) snprintf(out, cap, "%s/pads", es); else snprintf(out, cap, "/data/anchor-pads");
    mkdir(out, 0700);
}
/* Shipments are named <seed_id>-<index0>-<count>.pads. Files of another
 * seed (an older key or epoch) can never open here and are dropped at
 * PADSEED. Spent shipments are the engine's call (SHIELDED_PAD_PRUNE: it
 * knows the lowest live cursor; a window edge alone is NOT safe, a lagging
 * group may still read below it). `below` stays for that engine-side use. */
static int pads_prune(const char *keep_seed, unsigned long long below) {
    if (!g_pads_dir[0]) return 0;
    DIR *d = opendir(g_pads_dir); if (!d) return 0;
    int n = 0; struct dirent *e;
    while ((e = readdir(d))) {
        size_t len = strlen(e->d_name);
        /* a reception the VM did not finish (the app was stopped mid-stream) leaves ".<name>.tmp":
         * 117 MiB each, never referenced again, and enough of them fill the 2 GiB store (ENOSPC on
         * every later shipment: seen 2026-09-08). They go regardless of seed. */
        if (len > 5 && e->d_name[0] == '.' && !strcmp(e->d_name + len - 4, ".tmp")) {
            char path[700]; snprintf(path, sizeof path, "%s/%s", g_pads_dir, e->d_name);
            if (unlink(path) == 0) n++;
            continue;
        }
        if (len < 6 || strcmp(e->d_name + len - 5, ".pads")) continue;
        char sid[33] = ""; unsigned long long i0 = 0, cnt = 0;
        int drop = 0;
        if (sscanf(e->d_name, "%32[0-9a-f]-%llu-%llu.pads", sid, &i0, &cnt) != 3) drop = 1;
        else if (keep_seed && strcmp(sid, keep_seed)) drop = 1;
        else if (below && i0 + cnt <= below) drop = 1;
        if (!drop) continue;
        char path[700]; snprintf(path, sizeof path, "%s/%s", g_pads_dir, e->d_name);
        if (unlink(path) == 0) n++;
    }
    closedir(d);
    return n;
}
/* One shipment per connection: "PADS <name> <bytes>\n"; the VM answers one
 * byte, 'H' (have it already, same size: nothing more is sent) or 'G' (go),
 * then the bytes follow, written tmp-then-rename so the engine's reader
 * never sees a partial file. */
/* What the encrypted store can do for a model larger than the VM (27B-FEASIBILITY.md): its filesystem,
 * its size, whether fs-verity can be enabled on a file there (kernel-verified paging against a root the
 * payload measures), whether userfaultfd exists (payload-verified paging), and the RAM this VM was granted. */
#ifndef FS_IOC_ENABLE_VERITY
struct fsverity_enable_arg_compat { uint32_t version, hash_algorithm, block_size, salt_size; uint64_t salt_ptr, sig_size; uint32_t __reserved1; uint64_t sig_ptr, __reserved2[11]; };
#define FS_IOC_ENABLE_VERITY _IOW('f', 133, struct fsverity_enable_arg_compat)
#define fsverity_enable_arg fsverity_enable_arg_compat
#define FS_VERITY_HASH_ALG_SHA256 1
#endif
/* userfaultfd with UFFD_USER_MODE_ONLY (allowed to unprivileged callers even with the sysctl off): API
 * handshake, register an anonymous mapping, take ONE real fault from another thread and serve it with
 * UFFDIO_COPY, check the byte. In this mode a kernel-side access to the region (read(2) into it) would
 * SIGBUS, so a pager built on it must only ever be touched from user mode. */
#ifndef UFFD_USER_MODE_ONLY
#define UFFD_USER_MODE_ONLY 1
#endif
static volatile unsigned char *g_uffd_page; static volatile int g_uffd_seen = -1;
static void *uffd_toucher(void *a) { (void)a; g_uffd_seen = g_uffd_page[0]; return NULL; }
static const char *uffd_probe(void) {
    static char why[160];
    int fd = (int)syscall(__NR_userfaultfd, O_CLOEXEC | O_NONBLOCK | UFFD_USER_MODE_ONLY);
    if (fd < 0) { snprintf(why, sizeof why, "open: %s", strerror(errno)); return why; }
    struct uffdio_api api; memset(&api, 0, sizeof api); api.api = UFFD_API;
    if (ioctl(fd, UFFDIO_API, &api) != 0) { snprintf(why, sizeof why, "UFFDIO_API: %s", strerror(errno)); close(fd); return why; }
    const long ps = sysconf(_SC_PAGESIZE);
    void *m = mmap(NULL, (size_t)ps * 2, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (m == MAP_FAILED) { snprintf(why, sizeof why, "mmap: %s", strerror(errno)); close(fd); return why; }
    struct uffdio_register reg; memset(&reg, 0, sizeof reg); reg.range.start = (unsigned long)m; reg.range.len = (unsigned long)ps * 2; reg.mode = UFFDIO_REGISTER_MODE_MISSING;
    if (ioctl(fd, UFFDIO_REGISTER, &reg) != 0) { snprintf(why, sizeof why, "UFFDIO_REGISTER: %s", strerror(errno)); munmap(m, (size_t)ps * 2); close(fd); return why; }
    g_uffd_page = (volatile unsigned char *)m; g_uffd_seen = -1;
    pthread_t t; if (pthread_create(&t, NULL, uffd_toucher, NULL) != 0) { snprintf(why, sizeof why, "pthread_create failed"); munmap(m, (size_t)ps * 2); close(fd); return why; }
    struct pollfd pf = { fd, POLLIN, 0 }; struct uffd_msg msg; int got = 0;
    for (int i = 0; i < 200 && !got; i++) { if (poll(&pf, 1, 25) > 0 && read(fd, &msg, sizeof msg) == (ssize_t)sizeof msg && msg.event == UFFD_EVENT_PAGEFAULT) got = 1; }
    if (!got) { snprintf(why, sizeof why, "no fault message within 5 s"); pthread_detach(t); close(fd); return why; }
    static unsigned char src[65536] __attribute__((aligned(65536))); memset(src, 0x5a, (size_t)ps);
    struct uffdio_copy cp; memset(&cp, 0, sizeof cp); cp.dst = msg.arg.pagefault.address & ~((unsigned long)ps - 1); cp.src = (unsigned long)src; cp.len = (unsigned long)ps;
    if (ioctl(fd, UFFDIO_COPY, &cp) != 0) { snprintf(why, sizeof why, "UFFDIO_COPY: %s", strerror(errno)); pthread_detach(t); close(fd); return why; }
    pthread_join(t, NULL);
    if (g_uffd_seen == 0x5a) snprintf(why, sizeof why, "WORKS (fault at %#lx served by UFFDIO_COPY, byte 0x5a seen)", (unsigned long)msg.arg.pagefault.address);
    else snprintf(why, sizeof why, "copy done but the thread saw %#x", (unsigned)g_uffd_seen);
    munmap(m, (size_t)ps * 2); close(fd);
    return why;
}
static void storage_probe(void) {
    const char *es = AVmPayload_getEncryptedStoragePath();
    struct sysinfo si; long ram_mib = sysinfo(&si) == 0 ? (long)((unsigned long long)si.totalram * si.mem_unit >> 20) : -1;
    if (!es) { OUT("STORAGE none (no encrypted store attached) ram=%ld MiB", ram_mib); return; }
    struct statfs sf; long long total = -1, avail = -1; unsigned long fstype = 0;
    if (statfs(es, &sf) == 0) { total = (long long)sf.f_blocks * sf.f_frsize >> 20; avail = (long long)sf.f_bavail * sf.f_frsize >> 20; fstype = (unsigned long)sf.f_type; }
    char path[512]; snprintf(path, sizeof path, "%s/.verity-probe", es);
    const char *verity = "not tried"; char vbuf[96];
    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd >= 0) {
        static const char z[8192] = {0}; (void)!write(fd, z, sizeof z); fsync(fd); close(fd);
        fd = open(path, O_RDONLY | O_CLOEXEC);
        if (fd >= 0) {
            struct fsverity_enable_arg arg; memset(&arg, 0, sizeof arg); arg.version = 1; arg.hash_algorithm = FS_VERITY_HASH_ALG_SHA256; arg.block_size = 4096;
            if (ioctl(fd, FS_IOC_ENABLE_VERITY, &arg) == 0) verity = "ENABLED (kernel-verified paging available)";
            else { snprintf(vbuf, sizeof vbuf, "refused: %s", strerror(errno)); verity = vbuf; }
            close(fd);
        }
        unlink(path);
    }
    int uffd = (int)syscall(__NR_userfaultfd, O_CLOEXEC | O_NONBLOCK); const char *uf = uffd >= 0 ? "available" : strerror(errno); if (uffd >= 0) close(uffd);
    { struct statfs df; unsigned long dft = statfs("/data", &df) == 0 ? (unsigned long)df.f_type : 0; long long dfa = df.f_bavail * (long long)df.f_frsize >> 20;
      OUT("STORAGE %s fstype=0x%lx total=%lld MiB avail=%lld MiB fs-verity=%s userfaultfd=%s ram=%ld MiB vm-/data=0x%lx (%lld MiB free)", es, fstype, total, avail, verity, uf, ram_mib, dft, dfa); }
    /* is the refusal policy or filesystem support? MEASURE on a plain file answers ENODATA when the ioctl is
     * permitted (no verity on it) and EACCES when SELinux denies the ioctl itself; a second ENABLE attempt after
     * chmod 0644 on a fresh read-only descriptor rules out the DAC write check; the mount line and our SELinux
     * context are printed for the record; AuthFS/FUSE presence says whether a host-backed verified mount exists */
    char mnt[256] = "?"; { FILE *m = fopen("/proc/mounts", "r"); char l[512]; if (m) { while (fgets(l, sizeof l, m)) if (strstr(l, es)) { l[strcspn(l, "\n")] = 0; snprintf(mnt, sizeof mnt, "%.255s", l); break; } fclose(m); } }
    char ctx[128] = "?"; { FILE *c = fopen("/proc/self/attr/current", "r"); if (c) { if (fgets(ctx, sizeof ctx, c)) ctx[strcspn(ctx, "\n")] = 0; fclose(c); } }
    const char *measure = "not tried", *enable2 = "not tried"; char mb[64], eb[64];
    fd = open(path, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (fd >= 0) {
        static const char z2[4096] = {0}; (void)!write(fd, z2, sizeof z2); fsync(fd); close(fd);
        fd = open(path, O_RDONLY | O_CLOEXEC);
        if (fd >= 0) {
            struct { uint8_t digest_algorithm_lo, digest_algorithm_hi, digest_size_lo, digest_size_hi; uint8_t digest[64]; } md; memset(&md, 0, sizeof md); md.digest_size_lo = 64;
            if (ioctl(fd, _IOWR('f', 134, char[4]), &md) == 0) measure = "ok (verity file?)"; else { snprintf(mb, sizeof mb, "%s", strerror(errno)); measure = mb; }
            struct fsverity_enable_arg arg; memset(&arg, 0, sizeof arg); arg.version = 1; arg.hash_algorithm = FS_VERITY_HASH_ALG_SHA256; arg.block_size = 4096;
            if (ioctl(fd, FS_IOC_ENABLE_VERITY, &arg) == 0) enable2 = "ENABLED"; else { snprintf(eb, sizeof eb, "%s", strerror(errno)); enable2 = eb; }
            close(fd);
        }
        unlink(path);
    }
    const int authfs = access("/system/bin/authfs", X_OK) == 0, authfs_svc = access("/system/bin/authfs_service", X_OK) == 0, fuse = access("/dev/fuse", F_OK) == 0;
    int ffd = open("/dev/fuse", O_RDWR | O_CLOEXEC); const char *fuse_open = ffd >= 0 ? "opens" : strerror(errno); if (ffd >= 0) close(ffd);
    OUT("STORAGE2 selinux=%s measure=%s enable-after-chmod=%s authfs=%d authfs_service=%d /dev/fuse=%d(%s)", ctx, measure, enable2, authfs, authfs_svc, fuse, fuse_open);
    OUT("STORAGE2 mount=[%.200s]", mnt);
    OUT("STORAGE3 userfaultfd(USER_MODE_ONLY)=%s", uffd_probe());
}

static int write_all(int fd, const char *p, size_t n) {
    while (n) { ssize_t w = write(fd, p, n); if (w < 0) { if (errno == EINTR) continue; return -1; } if (w == 0) { errno = EIO; return -1; } p += w; n -= (size_t)w; }
    return 0;
}
/* The directory entry is durable only when this returns 0: an acknowledgment is never sent on a rename
 * that could still be lost. */
static int dir_sync(const char *dir) {
    int d; do { d = open(dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC); } while (d < 0 && errno == EINTR);
    if (d < 0) return -1;
    int rc; do { rc = fsync(d); } while (rc < 0 && errno == EINTR);
    const int e = errno; close(d); errno = e;
    return rc;
}
/* A shipment judged by the descriptor the receiver HOLDS (the file may still be hidden, or already
 * published and prunable by name: an inode we hold cannot vanish under the check or the hash), with the
 * grant's identity (seed, consumer key, calibration digest, its name against its own header). Ours and
 * intact -> the signed delivery acknowledgment line is PREPARED into `ack` (the caller emits it only once
 * the name is durable); anything else -> -1, the owner hears why and the caller removes the file.
 * 0 = kept unjudged (no seed yet: ack empty). A hash failure is a failure, never a silent 'K'. */
/* stream_sha: for a NEW canonical shipment reception, the SHA-256 the receiver accumulated over exactly the bytes it wrote
 * through this descriptor. The receiver finalises that context on EVERY shipment path (finalisation clears it) but passes
 * the digest here only when every byte arrived, no write failed and fsync succeeded (expect_bytes = the announced size,
 * which the descriptor must still hold). NULL on the existing-file/retry path, which hashes the held descriptor as
 * before. ASSUMPTION (recorded, and it does change one thing): the acknowledgment now attests the bytes this receiver
 * successfully wrote and made durable, trusting that write+fsync; the old readback hash could also notice a same-length
 * corruption of the stored file between fsync and the acknowledgment, which is now left to the per-cell AEAD at
 * consumption (unchanged) - the ack itself never authenticated cells either way. */
static int pads_judge_fd(const char *name, int fd, char *ack, size_t ackcap, const uint8_t *stream_sha, unsigned long long expect_bytes) {
    ack[0] = 0;
    ack_identity id; pthread_mutex_lock(&g_ack_mu); id = g_ack; pthread_mutex_unlock(&g_ack_mu);
    if (!id.valid) { OUT("PADS %s kept unjudged: no seed granted yet", name); return 0; }
    uint64_t i0 = 0, cnt = 0;
    const int rc = sh_pads_shipment_check_fd(fd, id.seed_id, g_psk, id.calib, &i0, &cnt);
    char sid[33] = ""; unsigned long long ni0 = 0, ncnt = 0;
    if (rc != SH_OK) { OUT("PADS %s REJECTED (%s): removed", name, rc == SH_ERR_IO ? "unreadable" : "not this seed, calibration or consumer, or damaged"); return -1; }
    if (sscanf(name, "%32[0-9a-f]-%llu-%llu.pads", sid, &ni0, &ncnt) != 3 || strcmp(sid, id.seed_id_hex) || ni0 != i0 || ncnt != cnt) {
        OUT("PADS %s REJECTED (name does not match its header %llu+%llu): removed", name, (unsigned long long)i0, (unsigned long long)cnt); return -1;
    }
    uint8_t sha[32]; uint64_t bytes = 0;
    if (stream_sha) {                                             /* new reception: the digest of what was written; the descriptor must still hold exactly the announced bytes */
        struct stat js; if (fstat(fd, &js) != 0) { OUT("PADS %s REJECTED (cannot size it for the acknowledgment: %s): removed", name, strerror(errno)); return -1; }
        if (js.st_size <= 0 || (unsigned long long)js.st_size != expect_bytes) { OUT("PADS %s REJECTED (size %llu differs from the %llu bytes written): removed", name, (unsigned long long)js.st_size, expect_bytes); return -1; }
        memcpy(sha, stream_sha, 32); bytes = (uint64_t)js.st_size;
    }
    else if (anchor_sha256_fd(fd, sha, &bytes) != 0 || !bytes) { OUT("PADS %s REJECTED (cannot hash it for the acknowledgment: %s): removed", name, strerror(errno)); return -1; }
    char shah[65], i0s[24], cnts[24], nh[33], sh[129]; uint8_t nonce[16], sig[64];
    sh_pads_bin2hex(sha, 32, shah); snprintf(i0s, sizeof i0s, "%llu", (unsigned long long)i0); snprintf(cnts, sizeof cnts, "%llu", (unsigned long long)cnt);
    randombytes(nonce, 16); sh_pads_bin2hex(nonce, 16, nh);
    const char *fields[5] = { id.name, id.seed_id_hex, i0s, cnts, shah };     /* enclave-pads-ack\n<name>\n<seed_id>\n<index0>\n<count>\n<sha256>\n<nonce> */
    if (sh_pads_request_sign(g_tsk, "ack", fields, 5, nh, sig) != SH_OK) { OUT("PADS %s kept, acknowledgment not signed (a re-offer will retry)", name); return 0; }
    sh_pads_bin2hex(sig, 64, sh);
    snprintf(ack, ackcap, "PADACK %s %s %s %s %s %s", id.seed_id_hex, i0s, cnts, shah, nh, sh);
    return 1;
}
/* A PUBLIC encoded-weight artifact offered on the pads port: "PADS <64hex>.i8 <bytes>". Admitted only when an
 * encoded catalog was admitted this session AND the name spells one of its digests AND the size matches; stored
 * beneath the held artifacts directory, block-verified against the catalog while received (anchor_artifacts.h);
 * never acknowledged (no PADACK: a public file has no consumer identity). 'H' is an availability hint only (name
 * and size): the owner keeps its copy until a fresh 'K'. A reception is bounded (30 s per read, 600 s whole). */
static ssize_t artifact_sock_read(void *ctx, void *buf, size_t n) { return read((int)(intptr_t)ctx, buf, n); }
static void artifact_receive_conn(int c, const char *name, unsigned long long bytes) {
    const char *why = "no encoded catalog admitted yet";
    const anchor_encoded_entry *e = g_cat_admitted && g_ecat.authenticated && g_art_dirfd >= 0 ? anchor_artifact_admit(&g_ecat, name, bytes, &why) : NULL;
    if (!e) { OUT("ARTIFACT %s refused: %s", name, why); (void)!write(c, "E", 1); return; }
    if (anchor_artifact_have(g_art_dirfd, name, bytes) == 1) { (void)!write(c, "H", 1); return; }
    struct statvfs sv; const unsigned long long freeb = fstatvfs(g_art_dirfd, &sv) == 0 ? (unsigned long long)sv.f_bavail * sv.f_frsize : 0, need = bytes + (64ull << 20);
    if (freeb < need) { OUT("ARTIFACT %s refused: store has %llu MiB free, this artifact needs %llu MiB", name, freeb >> 20, need >> 20); (void)!write(c, "E", 1); return; }
    (void)!write(c, "G", 1);
    struct timeval tv = { 30, 0 }; (void)setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);   /* a stalled sender surfaces as EAGAIN: refused, not waited for */
    anchor_artifact_receipt r; const double t0 = now_us();
    /* ANCHOR_ARTIFACT_PROFILE=1 (performance knob, --es shenv): the core times its wall-clock phases into `prof` (integer ns);
     * one line per COMPLETED reception follows the verified line. Unset = the plain receive (profile NULL), byte for byte as before. */
    const int profiling = anchor_artifact_profile_effective(g_artifact_profile, getenv("ANCHOR_ARTIFACT_PROFILE"));   /* the explicit control line first; else the ENGINE environment (anchor_prepare.h, fixtured) */
    anchor_artifact_profile prof; memset(&prof, 0, sizeof prof);
    const int rc = anchor_artifact_receive_profiled(g_art_dirfd, name, e, &g_hash_ops, artifact_sock_read, (void *)(intptr_t)c, 600000, &r, profiling ? &prof : NULL);
    static const char *const names[] = { "ok", "arguments", "cannot create the temp file", "read error", "stream ended early", "write error", "block differs from the catalog", "publish failed" };
    if (rc == ANCHOR_ARTIFACT_OK) {
        (void)!write(c, "K", 1); OUT("ARTIFACT %s %llu bytes verified against the catalog in %.1f s", name, bytes, (now_us() - t0) / 1e6);
        if (profiling) OUT("ARTIFACT PROFILE %s bytes=%llu read_calls=%llu write_batches=%llu read_bytes=%llu read_ns=%llu write_ns=%llu hash_ns=%llu file_sync_ns=%llu publish_ns=%llu body_total_ns=%llu clock_errors=%llu",
                           name, bytes, (unsigned long long)prof.read_calls, (unsigned long long)prof.write_batches, (unsigned long long)prof.read_bytes, (unsigned long long)prof.read_ns, (unsigned long long)prof.write_ns,
                           (unsigned long long)prof.hash_ns, (unsigned long long)prof.file_sync_ns, (unsigned long long)prof.publish_ns, (unsigned long long)prof.body_total_ns, (unsigned long long)prof.clock_errors);
    }
    else { (void)!write(c, "E", 1);
           if (rc == ANCHOR_ARTIFACT_E_BLOCK) OUT("ARTIFACT %s REJECTED (block %llu differs from the catalog): removed", name, (unsigned long long)r.bad_block);
           else OUT("ARTIFACT %s REJECTED at %llu of %llu (%s%s%s): removed", name, (unsigned long long)r.got, bytes, rc >= 0 && rc <= 7 ? names[rc] : "?", r.err_no ? ": " : "", r.err_no ? strerror(r.err_no) : ""); }
}
/* MASKBENCH adapters: the probe helper and the comparator take a monotonic-microsecond clock and a line sink */
static int64_t maskbench_clock_us(void) { return (int64_t)now_us(); }
static void maskbench_line(const char *s) { OUT("%s", s); }
static void maskbench_line4(const char *s) { OUT("PRG4_SPEED%s", s + 9); }
static void maskbench_line_again(const char *s) { OUT("PRG_AGAIN_SPEED%s", s + 9); }
#include "anchor_rx_profile.h"
static void rx_profile_line(void *ctx, const char *line) { (void)ctx; OUT("%s", line); }
static void *pads_receiver(void *arg) {
    int ls = (int)(intptr_t)arg;
    unsigned window_conns = 0;   /* PADWINDOW children proved so far; this thread's own, so no other thread reads it */
    for (;;) {
        if (anchor_rx_should_stop()) break;                              /* a PREPARE run quiesces the receiver before it counts (anchor_rxctl.h) */
        int c = vs_accept(ls, 1000);                                      /* short poll: a stop is seen within a second (the engine path never stops it) */
        if (c < 0) continue;
        if (!anchor_rx_set_active(c)) { anchor_rx_close(c); continue; }   /* the stop landed during the accept: nothing is read from this connection */
        if (g_pad_window) {   /* every accepted child must carry the inherited window BEFORE a header or body byte is read */
            /* SO_VM_SOCKETS_BUFFER_SIZE is a u64 in the option ABI and SO_RCVLOWAT an int: a readback that
             * returns another length is not the value we asked about, so the length is checked too. The
             * low-water must be exactly 1; at or above the window every read would fail with -ENOMEM. */
            uint64_t cb = 0; socklen_t cl = sizeof cb; int lw = -1; socklen_t ll = sizeof lw;
            const int rb = getsockopt(c, AF_VSOCK, SO_VM_SOCKETS_BUFFER_SIZE, &cb, &cl);
            const int rl = getsockopt(c, SOL_SOCKET, SO_RCVLOWAT, &lw, &ll);
            const int okb = rb == 0 && cl == sizeof cb && cb == (uint64_t)g_pad_window;
            const int okl = rl == 0 && ll == sizeof lw && lw == 1;
            if (!okb || !okl) {
                /* A child at another window would be measured as if it had this one. The connection is closed
                 * unread, the refusal is public (the owner's control loop ends the run on it), and the receiver
                 * STOPS: nothing more is taken at an unknown window. */
                OUT("PADWINDOW child REFUSED want=%d buffer_size rc=%d len=%u value=%llu lowat rc=%d len=%u value=%d: the pads receiver stops, nothing more is received",
                    g_pad_window, rb, (unsigned)cl, (unsigned long long)cb, rl, (unsigned)ll, lw);
                anchor_rx_close(c);
                break;
            }
            if (!window_conns) OUT("PADWINDOW child buf=%llu lowat=%d", (unsigned long long)cb, lw);   /* one public line; every later child is proved the same way, silently */
            window_conns++;
        }
        char hdr[256]; size_t n = 0;
        while (n + 1 < sizeof hdr) { char ch; if (read(c, &ch, 1) != 1) { n = 0; break; } if (ch == '\n') break; hdr[n++] = ch; }
        hdr[n] = 0;
        char name[128] = ""; unsigned long long bytes = 0;
        if (n == 0 || sscanf(hdr, "PADS %127s %llu", name, &bytes) != 2) { anchor_rx_close(c); continue; }
        /* only two kinds of file may land here: a canonical shipment (judged against its header, acknowledged)
         * or one of the exact shared-prefix assets (stored as offered, verified at use, never acknowledged) */
        const anchor_name_class kind = anchor_name_classify(name, NULL, NULL, NULL);
        if (kind == ANCHOR_NAME_REFUSED) { OUT("PADS %s refused: neither a shipment, a prefix asset nor a catalog artifact", name); (void)!write(c, "E", 1); anchor_rx_close(c); continue; }
        if (kind == ANCHOR_NAME_ARTIFACT) { artifact_receive_conn(c, name, bytes); anchor_rx_close(c); continue; }   /* its own store namespace, never the bank */
        char tmp[700], fin[700]; snprintf(tmp, sizeof tmp, "%s/.%s.tmp", g_pads_dir, name); snprintf(fin, sizeof fin, "%s/%s", g_pads_dir, name);
        struct stat st;
        {   /* have it already? judged and hashed on a retained descriptor (the owner may be retrying a lost
             * acknowledgment; the engine may prune the NAME at any moment, the inode we hold stays) */
            int hfd; do { hfd = open(fin, O_RDONLY | O_CLOEXEC); } while (hfd < 0 && errno == EINTR);
            if (hfd >= 0) {
                if (fstat(hfd, &st) == 0 && (unsigned long long)st.st_size == bytes) {
                    char ack[512] = ""; const int j = kind == ANCHOR_NAME_SHIPMENT ? pads_judge_fd(name, hfd, ack, sizeof ack, NULL, bytes) : 0; close(hfd);
                    if (j < 0) { unlink(fin); (void)!write(c, "E", 1); }
                    else { (void)!write(c, "H", 1); if (ack[0]) OUT("%s", ack); }
                    anchor_rx_close(c); continue;
                }
                close(hfd);                                       /* another size under that name: it is replaced below */
            }
        }
        const char *diag_env=getenv("SHIELDED_SOURCE_PROFILE");
        const char *rx_diag_env=getenv("ANCHOR_PAD_RX_PROFILE");
        const int diag=(diag_env && !strcmp(diag_env,"1")) || (rx_diag_env && !strcmp(rx_diag_env,"1"));
        uint64_t dp[6]={0}, d0=diag?now_us():0;
        struct timespec dc0={0},dc1={0}; if(diag) clock_gettime(CLOCK_THREAD_CPUTIME_ID,&dc0);
        if(diag) OUT("PAD_RX begin mono_us=%llu bytes=%llu",(unsigned long long)d0,bytes);
        anchor_rx_profile progress={0};
        if (diag && anchor_rx_profile_start(&progress, bytes, rx_profile_line, NULL)) OUT("PAD_RX progress unavailable: observer creation failed");
        (void)!write(c, "G", 1);
        anchor_rx_profile_mark(&progress, ARX_OPEN, 0);
        /* the encrypted store is shared with the model load and the engine's own writes; a transient
         * open failure (busy device, momentary ENOSPC while a spent shipment is being unlinked) must not
         * cost the shipment: retry briefly, and say why when it still fails */
        int fd = -1, open_errno = 0;
        for (int attempt = 0; attempt < 20 && fd < 0; attempt++) {
            fd = open(tmp, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);   /* read access: judged and hashed through this descriptor */
            if (fd < 0) { open_errno = errno; usleep(100000); }
        }
        if (fd < 0) { struct statvfs sv; unsigned long long freeb = statvfs(g_pads_dir, &sv) == 0 ? (unsigned long long)sv.f_bavail * sv.f_frsize : 0;
                      OUT("PADS %s: cannot open %s: %s (free %llu MiB in the store)", name, tmp, strerror(open_errno), freeb >> 20); }
        unsigned long long got = 0; static char buf[1 << 16]; int read_errno = 0, write_errno = 0; ssize_t last_r = 1;
        const char *ack_stream = getenv("SHIELDED_PAD_ACK_STREAM");
        const int hashing = kind == ANCHOR_NAME_SHIPMENT && ack_stream && !strcmp(ack_stream, "1");         /* only a canonical shipment's acknowledgment needs a digest; prefix assets are not hashed */
        anchor_sha256_ctx ah; if (hashing) anchor_sha256_init(&ah);
        while (fd >= 0 && got < bytes) {
            size_t want = bytes - got < sizeof buf ? (size_t)(bytes - got) : sizeof buf;
            uint64_t ds=diag?now_us():0;
            anchor_rx_profile_mark(&progress, ARX_READ, got);
            ssize_t r = read(c, buf, want); if (r < 0 && (errno == EINTR || errno == EAGAIN)) continue;
            if (r <= 0) { last_r = r; read_errno = errno; break; }
            if(diag) {uint64_t de=now_us();dp[0]+=de-ds;ds=de;}
            anchor_rx_profile_mark(&progress, ARX_WRITE, got);
            if (write_all(fd, buf, (size_t)r) != 0) { write_errno = errno; break; }
            if(diag) {uint64_t de=now_us();dp[1]+=de-ds;ds=de;}
            anchor_rx_profile_mark(&progress, ARX_HASH, got);
            if (hashing) anchor_sha256_update(&ah, (const uint8_t *)buf, (size_t)r);   /* exactly the bytes written successfully */
            if(diag) dp[2]+=now_us()-ds;
            got += (unsigned long long)r;
        }
        uint64_t ds=diag?now_us():0;
        int synced = 0;
        anchor_rx_profile_mark(&progress, ARX_FSYNC, got);
        if (fd >= 0) { int rc; do { rc = fsync(fd); } while (rc < 0 && errno == EINTR); synced = rc == 0; if (!synced && !write_errno) write_errno = errno; }
        if(diag) {dp[3]=now_us()-ds;ds=now_us();}
        /* eligibility for the streamed acknowledgment digest, explicit: every announced byte arrived AND was written
         * without error AND fsync succeeded. A new reception that fails any of these is refused below (never judged,
         * never acknowledged, never re-hashed from the file); a retry of an already stored shipment takes the held-
         * descriptor path above. */
        const int stream_ok = hashing && fd >= 0 && got == bytes && write_errno == 0 && synced;
        uint8_t stream_sha[32]; if (hashing) anchor_sha256_final(&ah, stream_sha);   /* finalised on every shipment path so the context is cleared */
        char ack[512] = "";
        anchor_rx_profile_mark(&progress, ARX_PUBLISH, got);
        if (fd >= 0 && got == bytes && synced) {
            /* judged and hashed while still HIDDEN, through the descriptor we hold; then published; then the
             * directory made durable; only then is anyone told and the prepared acknowledgment emitted */
            const int j = kind == ANCHOR_NAME_SHIPMENT ? (hashing ? (stream_ok ? pads_judge_fd(name, fd, ack, sizeof ack, stream_sha, bytes) : -1) : pads_judge_fd(name, fd, ack, sizeof ack, NULL, bytes)) : 0;   /* a prefix asset is stored as offered */
            close(fd); fd = -1;
            if (j < 0) { unlink(tmp); (void)!write(c, "E", 1); }
            else if (rename(tmp, fin) != 0) { const int e = errno; unlink(tmp); (void)!write(c, "E", 1); OUT("PADS %s: publish failed: %s", name, strerror(e)); }
            else if (dir_sync(g_pads_dir) != 0) { const int e = errno; unlink(fin); (void)!write(c, "E", 1); OUT("PADS %s: directory fsync failed (%s): withdrawn, not acknowledged", name, strerror(e)); }
            else { (void)!write(c, "K", 1); OUT("PADS %s %llu bytes", name, got); if (ack[0]) OUT("%s", ack); }
        }
        else { if (fd >= 0) close(fd); unlink(tmp); (void)!write(c, "E", 1);
               OUT("PADS %s FAILED at %llu of %llu (sock fd %d, file fd %d, read %zd/%s, write %s)", name, got, bytes, c, fd,
                   last_r, last_r < 0 ? strerror(read_errno) : "eof", write_errno ? strerror(write_errno) : "ok"); }
        anchor_rx_profile_mark(&progress, ARX_DONE, got);
        anchor_rx_profile_stop(&progress);
        if(diag) {
            clock_gettime(CLOCK_THREAD_CPUTIME_ID,&dc1);
            OUT("PAD_RX end mono_us=%llu bytes=%llu total_us=%llu cpu_us=%llu read_us=%llu write_us=%llu sha_us=%llu fsync_us=%llu judge_publish_us=%llu",
                (unsigned long long)now_us(),got,(unsigned long long)(now_us()-d0),
                (unsigned long long)((dc1.tv_sec-dc0.tv_sec)*1000000LL+(dc1.tv_nsec-dc0.tv_nsec)/1000LL),
                (unsigned long long)dp[0],(unsigned long long)dp[1],(unsigned long long)dp[2],(unsigned long long)dp[3],(unsigned long long)(now_us()-ds));
        }
        anchor_rx_close(c);
    }
    anchor_rx_exited();
    return NULL;
}

typedef int (*engine_main_fn)(int, int, int, const char *, const char *, const char *, int, int, const anchor_pads *);
/* A rejected model must not survive as "cached": the sidecar carries the owner's tag, so a lying
 * first stream (right tag, wrong bytes) would otherwise be answered 'K' on every later honest run. */
static void model_cache_purge(void) {
    if (g_model_cache_only) { OUT("MODEL cache purge SUPPRESSED (cache=only): the retained file was not received in this run; authentication failed, store unchanged"); return; }   /* anchor_model_purge would refuse too; said explicitly here */
    const char *es = AVmPayload_getEncryptedStoragePath();
    if (es) anchor_model_purge(es, 0);                                   /* anchor_model_cache.h: the same decision the host fixture exercises */
    unlink("/data/anchor-model.gguf");
    OUT("MODEL cache purged: a rejected model is not kept");
}
/* Catalog-v1 admission of the received (or retained) model file (CATALOG.md): the measured catalog and the private
 * header decide, no whole-file scan. A failure here never purges the model file: a packaging or catalog problem is
 * not a bad model. On success the admission is published for the rest of the session (never freed). */
static int model_stage_catalog(int fd, uint64_t bytes) {
    const char *apk = AVmPayload_getApkContentsPath(); const char *es = AVmPayload_getEncryptedStoragePath();
    char why[256] = "", agcat[600], ewcat[600]; snprintf(agcat, sizeof agcat, "%s/assets/model.agcat", apk); snprintf(ewcat, sizeof ewcat, "%s/assets/model.ewcat", apk);
    if (!g_pins.has_model || !g_pins.has_source_catalog) { close(fd); OUT("MODEL fail catalog requested but the build carries no catalog pins (model %s, source catalog %s)", g_pins.has_model ? "pinned" : "unpinned", g_pins.has_source_catalog ? "pinned" : "unpinned"); return -1; }
    if (!es) { close(fd); OUT("MODEL fail catalog mode needs the encrypted store (artifacts live there)"); return -1; }
    int cf; do { cf = open(agcat, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); } while (cf < 0 && errno == EINTR);
    if (cf < 0) { close(fd); OUT("MODEL fail source catalog pinned but assets/model.agcat unreadable: %s", strerror(errno)); return -1; }
    anchor_catalog_table cat; memset(&cat, 0, sizeof cat);
    const int ok = anchor_catalog_open(fd, cf, g_pins.source_catalog_sha256, g_pins.model_sha256, &g_hash_ops, &cat, why, sizeof why); close(cf);
    if (!ok) { close(fd); OUT("MODEL fail catalog: %s (the retained model file is untouched)", why); return -1; }
    if (g_have_seed && memcmp(cat.model_identity, g_grant_model, 32) != 0) { anchor_catalog_free(&cat); close(fd); OUT("MODEL fail model differs from the one the seed was granted for"); return -1; }
    anchor_encoded_catalog ecat; memset(&ecat, 0, sizeof ecat); int dfd = -1;
    if (g_pins.has_encoded_catalog) {
        uint8_t cd[32];
        if (!calib_digest32(cd)) { anchor_catalog_free(&cat); close(fd); OUT("MODEL fail encoded catalog: model.calib could not be hashed whole"); return -1; }
        int ef; do { ef = open(ewcat, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); } while (ef < 0 && errno == EINTR);
        if (ef < 0) { anchor_catalog_free(&cat); close(fd); OUT("MODEL fail encoded catalog pinned but assets/model.ewcat unreadable: %s", strerror(errno)); return -1; }
        const int eok = anchor_encoded_catalog_open(ef, g_pins.encoded_catalog_sha256, &cat, cd, g_pins.converter_sha256, &g_hash_ops, &ecat, why, sizeof why); close(ef);
        if (!eok) { anchor_catalog_free(&cat); close(fd); OUT("MODEL fail encoded catalog: %s (a present catalog that fails is never 'no artifacts')", why); return -1; }
        char d[600]; snprintf(d, sizeof d, "%s/artifacts", es);       /* the held directory: inside the store, chosen HERE, opened once */
        if (mkdir(d, 0700) != 0 && errno != EEXIST) { anchor_encoded_catalog_free(&ecat); anchor_catalog_free(&cat); close(fd); OUT("MODEL fail artifacts directory %s: %s", d, strerror(errno)); return -1; }
        do { dfd = open(d, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); } while (dfd < 0 && errno == EINTR);
        if (dfd < 0) { anchor_encoded_catalog_free(&ecat); anchor_catalog_free(&cat); close(fd); OUT("MODEL fail artifacts directory %s: %s", d, strerror(errno)); return -1; }
    }
    g_cat = cat; g_ecat = ecat; g_art_dirfd = dfd; g_cat_admitted = 1; g_auth_mode = 2; g_staged_table = &g_cat.table;   /* immutable from here on */
    memcpy(g_model_digest, g_cat.model_identity, 32);
    g_model_fd = fd; g_model_fd_bytes = bytes; g_model_state = 1;
    OUT("MODEL table: %zu tensors from the measured catalog, %zu header bytes verified in private memory, whole-file scan NOT performed (%s)", g_cat.table.n, g_cat.table.header_len, anchor_sha256_backend());
    char dh[65], sh[65], eh[65] = "none"; sh_pads_bin2hex(g_model_digest, 32, dh); sh_pads_bin2hex(g_cat.catalog_identity, 32, sh);
    if (g_ecat.authenticated) {
        sh_pads_bin2hex(g_ecat.identity, 32, eh);
        const int swept = anchor_artifact_sweep(g_art_dirfd, &g_ecat);          /* only now: after a VERIFIED admission, held-directory scoped */
        size_t present = 0; unsigned long long total = 0, present_bytes = 0;
        for (size_t i = 0; i < g_ecat.count; i++) {
            char nm[ANCHOR_ARTIFACT_NAME_LEN + 1]; anchor_artifact_name(g_ecat.entries[i].encoded_sha256, nm); total += g_ecat.entries[i].bytes;
            if (anchor_artifact_have(g_art_dirfd, nm, g_ecat.entries[i].bytes) == 1) { present++; present_bytes += g_ecat.entries[i].bytes; }
        }
        struct statvfs sv; const unsigned long long freeb = fstatvfs(g_art_dirfd, &sv) == 0 ? (unsigned long long)sv.f_bavail * sv.f_frsize : 0;
        OUT("ARTIFACTS catalog %zu entries %llu bytes, present %zu (%llu bytes, availability only), swept %d, store free %llu MiB", g_ecat.count, total, present, present_bytes, swept, freeb >> 20);
    }
    OUT("MODEL ok %s (catalog-v1: source catalog %s, encoded catalog %s)", dh, sh, eh);
    return 0;
}
static int model_stage(uint64_t bytes) {
    if (g_pins.mode == ANCHOR_MODE_INVALID) { OUT("MODEL fail pins-invalid"); return -1; }
    const int want_catalog = g_auth_catalog_requested;
    if (g_model_state == 1 && g_auth_mode && want_catalog != (g_auth_mode == 2)) { OUT("MODEL fail authentication mode differs from the staged model's (%s): restart the VM", g_auth_mode == 2 ? "catalog-v1" : "whole-file-sha256"); return -1; }
    if (want_catalog && g_cat_admitted && !(g_model_fd >= 0 && g_model_state == 1 && g_model_fd_bytes == bytes)) { OUT("MODEL fail catalog admission is once per VM session: restart the VM for other bytes"); return -1; }
    if (g_model_fd >= 0 && g_model_state == 1 && g_model_fd_bytes == bytes) {              /* staged already, unchanged: say so, the owner waits for a verdict */
        char dh[65]; sh_pads_bin2hex(g_model_digest, 32, dh); OUT("MODEL ok %s (staged already, unchanged)", dh); return 0;
    }
    if (g_model_fd >= 0) { close(g_model_fd); g_model_fd = -1; }
    g_model_state = 0; g_auth_mode = 0; g_staged_table = NULL; anchor_gguf_free(&g_model_table);   /* any (re)reception invalidates (a catalog admission cannot reach here: guarded above) */
    if (g_req_pending) { g_req_pending = 0; OUT("PADREQ2 request dropped: the model is being re-staged, request again for the new bytes"); }   /* a grant for the old digest must not land on new bytes */
    int fd = -1;
    if (receive_model(g_ls_model, bytes, &fd) != 0) { if (g_model_cache_only && g_model_cache_verdict > 0) OUT("MODEL fail cache-only: model not retained (verdict %d); store unchanged", g_model_cache_verdict); else OUT("MODEL fail receive"); return -1; }
    if (want_catalog) return model_stage_catalog(fd, bytes);                                  /* measured catalog + private header; no whole-file scan, no purge on refusal */
    /* the bytes that will be parsed, judged by ONE read: GGUF header walked, whole-file digest (the pin's
     * form) and each tensor's digest from the same pass; then the pin and the grant's frozen digest */
    char why[256] = "";
    struct timespec st0; clock_gettime(CLOCK_MONOTONIC, &st0);
    const int staged_ok = anchor_gguf_stage(fd, &g_model_table, &g_hash_ops, g_model_digest, why, sizeof why);
    { struct timespec st1; clock_gettime(CLOCK_MONOTONIC, &st1);
      OUT("MODEL stage timing: whole-file and per-tensor SHA-256 in one read, %.1f s", (st1.tv_sec - st0.tv_sec) + (st1.tv_nsec - st0.tv_nsec) / 1e9); }
    if (!staged_ok) { close(fd); OUT("MODEL fail not a usable GGUF: %s", why); model_cache_purge(); return -1; }
    if (g_pins.has_model && memcmp(g_model_digest, g_pins.model_sha256, 32) != 0) { anchor_gguf_free(&g_model_table); close(fd); OUT("MODEL fail model differs from the measured pin"); model_cache_purge(); return -1; }
    if (g_have_seed && memcmp(g_model_digest, g_grant_model, 32) != 0) { anchor_gguf_free(&g_model_table); close(fd); OUT("MODEL fail model differs from the one the seed was granted for"); model_cache_purge(); return -1; }
    g_model_fd = fd; g_model_fd_bytes = bytes; g_model_state = 1; g_auth_mode = 1; g_staged_table = &g_model_table;
    OUT("MODEL table: %zu tensors, header %zu bytes retained, data at %llu, digests from the pin's own read (%s)", g_model_table.n, g_model_table.header_len, (unsigned long long)g_model_table.data_start, anchor_sha256_backend());
    char dh[65]; sh_pads_bin2hex(g_model_digest, 32, dh);
    OUT("MODEL ok %s (%s)", dh, g_pins.has_model ? "matches the pin" : g_have_seed ? "matches the grant" : "unpinned: hashed only");
    return 0;
}

/* This process's resident set and high-water mark (the engine runs in-process): the memory regression's numbers. */
static void mem_line(const char *when) {
    FILE *f = fopen("/proc/self/status", "r"); char l[256], rss[64] = "?", hwm[64] = "?";
    if (f) { while (fgets(l, sizeof l, f)) { if (!strncmp(l, "VmRSS:", 6)) { l[strcspn(l, "\n")] = 0; snprintf(rss, sizeof rss, "%s", l + 6); } else if (!strncmp(l, "VmHWM:", 6)) { l[strcspn(l, "\n")] = 0; snprintf(hwm, sizeof hwm, "%s", l + 6); } } fclose(f); }
    OUT("MEM %s: VmRSS=%s VmHWM=%s", when, rss, hwm);
}
/* The engine's artifact reads (anchor_model_auth.h): by digest, beneath the held directory, bounded wait; and the
 * one file it names when the load was refused (a public, re-deliverable artifact; never the model). */
static int artifact_open_cb(void *ctx, const uint8_t sha256[32], uint64_t bytes, unsigned wait_ms, int *state) { (void)ctx; int en = 0; return anchor_artifact_open_wait(g_art_dirfd, sha256, bytes, wait_ms, 250, state, &en); }
static void artifact_suspect_cb(void *ctx, const uint8_t sha256[32]) {
    (void)ctx; char nm[ANCHOR_ARTIFACT_NAME_LEN + 1]; anchor_artifact_name(sha256, nm);
    if (g_art_dirfd >= 0 && unlinkat(g_art_dirfd, nm, 0) == 0) OUT("ARTIFACT %s removed: the engine refused its bytes; the next cycle re-delivers it", nm);
}
/* PREPARE [seconds] (after a MODEL … auth=catalog admission, instead of ENGINE): artifacts preparation with NO engine, seed,
 * dealer or worker. The admitted encoded catalog's receiver takes public artifacts on the pads port for a bounded time; the
 * owner sends STOP when its feed is done (or the deadline ends it: anchor_prepare_wait_stop never blocks in a read); the run
 * reports what is PRESENT by name and size (availability only: use-time reads verify) and ends. Never a decode result. */
static void run_prepare(int ls_pads, int seconds) {
    if (g_model_state != 1 || g_auth_mode != ANCHOR_MODEL_AUTH_CATALOG_V1 || !g_ecat.authenticated || g_art_dirfd < 0) { OUT("PREPARE refused: no encoded catalog admitted (send MODEL <bytes> <sha256> auth=catalog first)"); return; }
    anchor_rx_reset();
    pthread_t th; const int prc = pthread_create(&th, NULL, pads_receiver, (void *)(intptr_t)ls_pads);   /* joinable: quiesced and joined before the snapshot */
    if (prc != 0) { OUT("PREPARE refused: pads-port receiver thread: %s", strerror(prc)); return; }
    OUT("PREPARE ready: catalog artifacts accepted on the pads port for up to %d s (no engine, no seed, no worker); artifact profile %s", seconds, g_artifact_profile == 1 ? "on" : "off");
    const uint64_t t0 = anchor_prepare_mono_ms();
    const int w = anchor_prepare_wait_stop(g_ctl, t0 + (uint64_t)seconds * 1000u);
    const char *reason = w == ANCHOR_PREPARE_STOP ? "owner stop" : w == ANCHOR_PREPARE_EOF ? "owner gone" : w == ANCHOR_PREPARE_DEADLINE ? "deadline" : w == ANCHOR_PREPARE_OVERLONG ? "owner sent an overlong line" : "control read error";
    /* QUIESCE before counting: no more offers are accepted, a reception still reading is shut down (its temp is removed,
     * nothing is published), one that had already received every byte may finish publishing, and the receiver thread has
     * exited and been joined; only THEN is the snapshot taken, so nothing can be published after the receipt. A receiver
     * that does not quiesce in time yields NO snapshot: an explicit failure. */
    const uint64_t tq = anchor_prepare_mono_ms();
    if (!anchor_rx_quiesce(th, 5000)) { OUT("PREPARE failed: the artifact receiver did not quiesce within 5 s after %s; no snapshot taken (files already published are kept, nothing else is trusted)", reason); return; }
    const double quiesce_ms = (double)(anchor_prepare_mono_ms() - tq);
    size_t present = 0; unsigned long long bytes = 0, total = 0;
    for (size_t i = 0; i < g_ecat.count; i++) {
        char nm[ANCHOR_ARTIFACT_NAME_LEN + 1]; anchor_artifact_name(g_ecat.entries[i].encoded_sha256, nm); total += g_ecat.entries[i].bytes;
        if (anchor_artifact_have(g_art_dirfd, nm, g_ecat.entries[i].bytes) == 1) { present++; bytes += g_ecat.entries[i].bytes; }
    }
    struct statvfs sv; const unsigned long long freeb = fstatvfs(g_art_dirfd, &sv) == 0 ? (unsigned long long)sv.f_bavail * sv.f_frsize : 0;
    OUT("PREPARATION quiesced in %.0f ms: receiver joined, no reception in flight", quiesce_ms);
    OUT("PREPARATION present %zu/%zu (%llu of %llu bytes, availability only: use-time reads verify), store free %llu MiB, %.1f s, reason=%s",
        present, g_ecat.count, bytes, total, freeb >> 20, (anchor_prepare_mono_ms() - t0) / 1e3, reason);
}
/* LOCAL: the whole model inside this VM (engine_local.cpp). No worker, no pads, no calibration: the model is staged and
 * judged exactly as for the split engine (whole-file digest against the pin, per-tensor digests for the verified loader),
 * then the local engine serves one accepted chat connection until the owner says BYE or goes away. */
typedef int (*engine_local_main_fn)(int, int, const char *, int, int);
typedef int (*engine_local_set_tpu_fn)(const char *, int, int, int);
/* The lane bundle and a drafter are PUBLIC files: anchor_public_file.h receives them, and answers 'K' for a stored copy only
 * after re-hashing it against the digest the owner announced (identity, not authentication: see that header). */
static void apf_out(const char *line) { OUT("%s", line); }
static int receive_public_file(int ls, uint64_t bytes, const char *name, char *path, size_t pathcap) {
    const char *es = AVmPayload_getEncryptedStoragePath(); if (!es) { OUT("LOCAL: no encrypted store for a public file"); return -1; }
    snprintf(path, pathcap, "%s/%s", es, name);
    int c = vs_accept(ls, 120000); if (c < 0) { OUT("LOCAL %s: no stream from the owner", name); return -1; }
    const int r = apf_receive(c, bytes, path, name, apf_out); close(c);
    return r < 0 ? -1 : 0;
}
/* Link-scaling benchmark: does the protected-VM boundary serialise, or does it scale per connection?
 *
 * The question matters because the exchange path moves 4471 KB per token at 22 MB/s while a plain
 * one-directional stream over the SAME boundary reaches 34-42 MB/s, and because an earlier attempt to
 * answer it by adding two averages taken over different windows proved nothing at all. So this is the
 * control that does settle it: the SAME total bytes, once over one link and once split evenly over N,
 * compared by MAKESPAN.
 *
 * These links carry benchmark bytes only. They never see a masked row, no pad is drawn for them, and they
 * are closed before the engine is loaded, so the lane's masking, verification, ordering and lifetimes are
 * untouched. The VM announces a byte count per link and the owner's side sends exactly that many.
 */
static void tpu_link_bench(int want) {
    int ls = vs_bind(BENCH_PORT);
    if (ls < 0) { OUT("LOCAL linkbench: cannot listen on the bench port; skipping"); return; }
    int fd[4], have = 0;
    for (int i = 0; i < want && i < 4; i++) { int f = vs_accept(ls, 20000); if (f < 0) break; fd[have++] = f; }
    if (have < 2) {
        OUT("LOCAL linkbench: %d bench link(s) connected, at least 2 are needed; skipping", have);
        for (int i = 0; i < have; i++) close(fd[i]);
        close(ls);
        return;
    }
    /* Each phase is run REPS times and the MEDIAN reported. A single pair was badly misleading: repeated
     * externally, the one-link baseline alone moved between 44.7 and 70.8 MB/s and the two-link scaling
     * between 0.79x and 1.92x, so the first measurement taken (1.92x) was the high tail of a noisy
     * distribution rather than the effect. The phases also alternate, so any drift over the run (thermal,
     * or the model still settling to disk) lands on both rather than on the second. */
    const size_t TOTAL = 8u << 20;
    bench_compare_result res;
    if (bench_compare(fd, have, TOTAL, 7, &res) != 0) {
        OUT("LOCAL linkbench: ABANDONED after %d complete pair(s): the %d-link phase of repetition %d did "
            "not finish. The streams are not resynchronised after a failed phase -- a peer may still be "
            "sending bytes announced for it -- so no number is reported rather than one from mismatched "
            "samples", res.n, res.failed_phase, res.failed_rep);
        for (int i = 0; i < have; i++) close(fd[i]);
        close(ls);
        return;
    }
    double one_s[16], many_s[16];
    for (int i = 0; i < res.n; i++) { one_s[i] = res.one[i]; many_s[i] = res.many[i]; }
    const double a = bench_median(one_s, res.n), b = bench_median(many_s, res.n);
    if (a > 0 && b > 0)
        OUT("LOCAL linkbench: %u MiB, medians of %d COMPLETE alternating pairs (a failed phase abandons the "
            "comparison, so these are not selected timings). ONE link %.0f ms (%.1f MB/s, spread %.0f-%.0f); "
            "the SAME %u MiB split over %d links %.0f ms (%.1f MB/s, spread %.0f-%.0f); scaling %.2fx "
            "(1.00 means the boundary serialises, %.2f means it is fully per-connection). TRANSPORT ONLY: "
            "this is not the masked exchange path and says nothing yet about decode",
            (unsigned)(TOTAL >> 20), res.n,
            a, (double)TOTAL / 1e6 / (a / 1000.0), one_s[0], one_s[res.n - 1],
            (unsigned)(TOTAL >> 20), have, b, (double)TOTAL / 1e6 / (b / 1000.0), many_s[0], many_s[res.n - 1],
            a / b, (double)have);
    else
        OUT("LOCAL linkbench: medians could not be formed from %d pairs", res.n);
    /* The exchange-SHAPED sweep (exbench.h), on the first benchmark link: request/reply round trips sized like the lane's
     * digit-split exchanges -- per row ~7.4 KB out and ~24.5 KB back (qc7: 1039 and 3432 KB per token over 140) -- with no
     * TPU and no pads. R rows, up then back down so drift lands on both; with and without 800 us of busy work before each
     * (the lane's VM works ~0.6-0.9 ms between exchanges); replies read with read()s (the lane) or one MSG_WAITALL. */
    {
        static const int rows[] = { 1, 2, 4, 8, 16, 16, 8, 4, 2, 1 };
        for (int w = 0; w < 2; w++) for (int g = 0; g < 2; g++) for (unsigned k = 0; k < sizeof rows / sizeof *rows; k++) {
            const int R = rows[k]; exbench_stat st; long reads = 0;
            if (exbench_run(fd[0], (size_t)R * 7424, (size_t)R * 24512, 100, g ? 800 : 0, w, &st, &reads) != 0) {
                OUT("LOCAL exbench: ABANDONED at R=%d gap=%d waitall=%d (a round trip failed; the stream cannot be resynchronised)", R, g ? 800 : 0, w);
                w = 2; g = 2; break;
            }
            OUT("LOCAL exbench R=%d gap_us=%d waitall=%d: %d round trips, min %.3f med %.3f p90 %.3f mean %.3f ms, %.2f reads per reply "
                "(request %d B, reply %d B; TRANSPORT ONLY, no TPU, no mask)", R, g ? 800 : 0, w, st.n, st.min_ms, st.med_ms, st.p90_ms, st.mean_ms,
                (double)reads / st.n, R * 7424, R * 24512);
        }
    }
    for (int i = 0; i < have; i++) close(fd[i]);
    close(ls);
}

#ifdef ANCHOR_TIER_PVM_CPU
#define PVM_CPU_CAPS_DOMAIN "enclave-pvm-cpu-caps-v1\n"
/* The engine's self-test result becomes the tier's capability report: strict JSON in exactly the relay parser's field set,
 * signed by the attested transport key over DOMAIN || report, emitted as "CAPS <report hex> <signature hex>". */
static void caps_sink(const char *id, int tokens, double pf, double dc, const uint8_t digest[32]) {
    if (!g_caps_nonce_kind) { OUT("CAPS not emitted: no attestation in this session"); return; }
    unsigned long long mem_kb = 0; { FILE *f = fopen("/proc/meminfo", "r"); char l[160];
        if (f) { while (fgets(l, sizeof l, f)) if (sscanf(l, "MemTotal: %llu kB", &mem_kb) == 1) break; fclose(f); } }
    char nh[65], mh[65], oh[65]; sh_pads_bin2hex(g_caps_nonce, 32, nh); sh_pads_bin2hex(g_model_digest, 32, mh); sh_pads_bin2hex(digest, 32, oh);
    char rep[1400];
    const int rn = snprintf(rep, sizeof rep,
        "{\"v\":1,\"tier\":\"pvm-cpu\",\"nonce\":\"%s\",\"mode\":\"%s\",\"model\":{\"sha256\":\"%s\",\"bytes\":%llu,\"ctx\":%d},"
        "\"vm\":{\"threads\":%d,\"mem_mib\":%llu},\"selftest\":{\"id\":\"%s\",\"tokens\":%d,\"prefill_tok_s\":%.2f,\"decode_tok_s\":%.2f,\"output_sha256\":\"%s\"},"
        "\"vm_ms\":%llu,\"attach_vm_ms\":%llu,\"device\":\"\"}",
        nh, g_pins.mode == ANCHOR_MODE_PROTECTED ? "protected" : "dev", mh, (unsigned long long)g_caps_model_bytes, g_caps_ctx,
        g_caps_threads, mem_kb / 1024, id, tokens, pf, dc, oh, (unsigned long long)boot_ms(), (unsigned long long)g_caps_attach_ms);
    if (rn <= 0 || rn >= (int)sizeof rep) { OUT("CAPS not emitted: report too long"); return; }
    const size_t dl = strlen(PVM_CPU_CAPS_DOMAIN), n = dl + (size_t)rn;
    unsigned char *m = malloc(n), *sm = malloc(n + 64); unsigned long long smlen = 0;
    if (!m || !sm) { free(m); free(sm); OUT("CAPS not emitted: out of memory"); return; }
    memcpy(m, PVM_CPU_CAPS_DOMAIN, dl); memcpy(m + dl, rep, (size_t)rn);
    crypto_sign(sm, &smlen, m, n, g_tsk);
    char sh[129]; sh_pads_bin2hex(sm, 64, sh); free(m); free(sm);
    char *rh = malloc((size_t)rn * 2 + 1); if (!rh) { OUT("CAPS not emitted: out of memory"); return; }
    sh_pads_bin2hex((const uint8_t *)rep, (size_t)rn, rh);
    OUT("CAPS %s %s", rh, sh); free(rh);
    OUT("CAPS summary: nonce=%s (%s) selftest %d tokens decode %.2f tok/s output %.16s...", nh, g_caps_nonce_kind == 2 ? "relay-bound" : "owner challenge only", tokens, dc, oh);
}
#endif
#ifdef ANCHOR_TIER_PVM_CPU
/* APP (PVM-CPU.md, "The app runtime"; runtime/pvm-rt): the portable component arrives on APP_PORT, is read into this VM's
 * memory, and pvm-rt verifies those exact bytes against the APP line's sha256 BEFORE compiling them to Pulley here. Output
 * comes back as APPOUT <stream> <hex> lines (1 = stdout, 2 = stderr), in 1 KiB chunks. The sha256 is the app's identity
 * (AppID), kept for the attestation binding (report_data[32:64], milestone 5). */
static uint8_t g_app_sha256[32]; static int g_app_have = 0;
/* the relay's fresh nonce for the app's ABI/2 evidence (APPNONCE): used instead of the attach nonce when present */
static uint8_t g_app_nonce[32]; static int g_app_nonce_set = 0;
typedef int (*pvmrt_identity_fn)(char *, size_t);
typedef int (*pvmrt_run_app_fn)(const uint8_t *, size_t, const uint8_t *, const char *const *, int, uint64_t, uint64_t,
                                const char *, const pvmrt_nn_ops *, void (*)(int, const uint8_t *, size_t), int *, uint64_t *,
                                uint64_t *, char *, size_t);
static void app_emit(int stream, const uint8_t *p, size_t n) {
    for (size_t off = 0; off < n; off += 1024) {
        const size_t m = n - off < 1024 ? n - off : 1024; char hx[2049];
        sh_pads_bin2hex(p + off, m, hx); OUT("APPOUT %d %s", stream, hx);
    }
}
/* One received component and the runtime that will run it. */
typedef struct { const anchor_app_plan *plan; uint8_t *bytes; pvmrt_run_app_fn run; void *rt; char identity[512]; } app_ready;
/* The component into memory (refused unless exactly plan->bytes arrived) and the runtime from this APK, its identity said. */
static int app_receive(const anchor_app_plan *plan, app_ready *a) {
    char path[600];
    memset(a, 0, sizeof *a); a->plan = plan;
    int ls = vs_bind(APP_PORT);
    if (ls < 0 || receive_public_file(ls, plan->bytes, "app.wasm", path, sizeof path) != 0) { if (ls >= 0) close(ls); OUT("APP refused: the component did not arrive whole"); return 4; }
    close(ls);
    FILE *f = fopen(path, "rb"); uint8_t *b = f ? malloc(plan->bytes) : NULL;
    const int whole = f && b && fread(b, 1, plan->bytes, f) == plan->bytes && fgetc(f) == EOF;
    if (f) fclose(f);
    if (!whole) { free(b); OUT("APP refused: the stored component is not %llu bytes", (unsigned long long)plan->bytes); return 4; }
    {   /* the AppID the VM is about to attest (app_attest_abi2) must be these bytes' digest: checked HERE, before any certificate
         * names it, not only by pvm-rt before compiling -- otherwise a host could obtain a genuine certificate naming an app the
         * VM then refuses to run */
        uint8_t got[32]; sha256(b, (size_t)plan->bytes, got);
        if (memcmp(got, plan->sha256, 32) != 0) {
            char gh[65], wh[65]; sh_pads_bin2hex(got, 32, gh); sh_pads_bin2hex(plan->sha256, 32, wh); free(b);
            OUT("APP refused: bundle sha256 %s is not the expected %s: refusing to compile (and to attest it)", gh, wh); return 4;
        }
    }
    char lib[700]; snprintf(lib, sizeof lib, "%s/lib/arm64-v8a/libpvm_rt.so", AVmPayload_getApkContentsPath());
    void *h = dlopen(lib, RTLD_NOW);
    pvmrt_identity_fn idf = h ? (pvmrt_identity_fn)dlsym(h, "pvmrt_identity") : NULL;
    pvmrt_run_app_fn run = h ? (pvmrt_run_app_fn)dlsym(h, "pvmrt_run_app") : NULL;
    if (!idf || !run) { free(b); OUT("APP refused: the runtime is not in this APK (%s)", h ? "symbols" : dlerror()); return 4; }
    if (idf(a->identity, sizeof a->identity) != 0) { free(b); OUT("APP refused: the runtime identity did not fit"); return 4; }
    OUT("APP runtime %s", a->identity);
    a->bytes = b; a->run = run; a->rt = h;
    return 0;
}
/* Verify, compile, run (pvm-rt does all three, in that order), then free the component. With `ops`, wasi:nn serves the
 * verified model under plan->graph; a run over the model gets 600 s, a component alone 60 s; both 256 MiB. */
static int app_exec(app_ready *a, const pvmrt_nn_ops *ops) {
    const anchor_app_plan *plan = a->plan;
    const char *argv[64]; int argc = 0;
    for (size_t i = 0; i < plan->args_len && argc < 64; ) { argv[argc++] = plan->args + i; i += strlen(plan->args + i) + 1; }
    int exit_code = -1; uint64_t cms = 0, rms = 0; char err[1024] = "";
    const int rc = a->run(a->bytes, plan->bytes, plan->sha256, argv, argc, 256ull << 20, ops ? 600000 : 60000,
                          ops ? plan->graph : NULL, ops, app_emit, &exit_code, &cms, &rms, err, sizeof err);
    free(a->bytes); a->bytes = NULL;
    char hh[65]; sh_pads_bin2hex(plan->sha256, 32, hh);
    if (rc != 0) { OUT("APP refused: %s", err); return 4; }
    memcpy(g_app_sha256, plan->sha256, 32); g_app_have = 1;
    OUT("APP ran %s exit=%d compile_ms=%llu run_ms=%llu%s%s", hh, exit_code, (unsigned long long)cms, (unsigned long long)rms, ops ? " graph=" : "", ops ? plan->graph : "");
    return 0;
}
/* ABI/2 for the app (PVM-CPU.md, milestone 5; isolation/contract RUNTIME.md): once the component is here, and before it runs,
 * the VM asks for a second AVF certificate whose 64-byte challenge is
 *     Bind2 = SHA-256("enclave-bind-v2\n" || transport SPKI || attach nonce || RuntimeID)  ||  AppID (the component's SHA-256)
 * RuntimeID = SHA-256 of the runtime identity exactly as printed (pvm-rt emits the contract's canonical JSON), so a verifier
 * recomputes it from the ABI2 runtime line and a restated identity breaks the binding. The runtime self-test tuple says what
 * this process may do with code pages, measured here: the W^X probe (map RW, then ask for R+X) and a scan of this process's
 * mappings, which is complete coverage because the runtime is a library in this process (scope=self). A writable+executable
 * mapping refuses the run. The chain is printed as ABI2_LINK<i>[k] lines, apart from the attach chain (CERT<i>[k]). Returns
 * 0 to run, non-zero to refuse. */
static const char *errno_name(int e, char *buf, size_t cap) {
    switch (e) { case EACCES: return "EACCES"; case EPERM: return "EPERM"; case ENOMEM: return "ENOMEM"; case EINVAL: return "EINVAL"; }
    snprintf(buf, cap, "errno%d", e); return buf;
}
/* The W^X tuple measured when the app was received (app_attest_abi2), for every later answer (the evidence endpoint). */
static char g_abi2_tuple[96] = "";
/* One ABI/2 certificate: RuntimeID = SHA-256(identity as printed), Bind2 = SHA-256("enclave-bind-v2\n" || transport SPKI ||
 * nonce || RuntimeID), challenge = Bind2 || AppID. v3 (inst != NULL, INSTANCE-BINDING.md): the VM INSTANCE inside the first
 * half, Bind3 = SHA-256("enclave-bind-v3-instance\n" || transport SPKI || nonce || RuntimeID || InstanceID) with InstanceID =
 * SHA-256(instance SPKI), and inst->sig = the instance key's signature over "enclave-pvm-instance-sig-v1\n" || challenge.
 * AppID stays whole as the second half. Returns the result (the caller frees it) or NULL with *st set. */
typedef struct { uint8_t id[32]; uint8_t spki[44]; uint8_t sig[64]; } abi2_instance;
static void instance_spki(uint8_t spki[44]) { memcpy(spki, ED25519_SPKI_PREFIX, 12); memcpy(spki + 12, g_ipk, 32); }
static AVmAttestationResult *abi2_certify(const char *identity, const uint8_t nonce[32], const uint8_t app_sha[32],
                                          uint8_t rid[32], uint8_t bind[32], abi2_instance *inst, AVmAttestationStatus *st) {
    uint8_t spki[44], ch[64];
    sha256((const uint8_t *)identity, strlen(identity), rid);
    memcpy(spki, ED25519_SPKI_PREFIX, 12); memcpy(spki + 12, g_tpk, 32);
    if (!inst) {
        static const char dom[] = "enclave-bind-v2\n"; uint8_t m[sizeof dom - 1 + 44 + 32 + 32]; size_t o = 0;
        memcpy(m + o, dom, sizeof dom - 1); o += sizeof dom - 1; memcpy(m + o, spki, 44); o += 44;
        memcpy(m + o, nonce, 32); o += 32; memcpy(m + o, rid, 32); o += 32; sha256(m, o, bind);
    } else {
        static const char dom[] = "enclave-bind-v3-instance\n"; uint8_t m[sizeof dom - 1 + 44 + 32 + 32 + 32]; size_t o = 0;
        instance_spki(inst->spki); sha256(inst->spki, 44, inst->id);
        memcpy(m + o, dom, sizeof dom - 1); o += sizeof dom - 1; memcpy(m + o, spki, 44); o += 44;
        memcpy(m + o, nonce, 32); o += 32; memcpy(m + o, rid, 32); o += 32; memcpy(m + o, inst->id, 32); o += 32; sha256(m, o, bind);
    }
    memcpy(ch, bind, 32); memcpy(ch + 32, app_sha, 32);
    if (inst) {   /* the instance key endorses exactly this challenge (TweetNaCl: sm = sig || m) */
        static const char dom[] = "enclave-pvm-instance-sig-v1\n"; uint8_t m[sizeof dom - 1 + 64], sm[64 + sizeof m]; unsigned long long smlen = 0;
        memcpy(m, dom, sizeof dom - 1); memcpy(m + sizeof dom - 1, ch, 64);
        crypto_sign(sm, &smlen, m, sizeof m, g_isk); memcpy(inst->sig, sm, 64);
    }
    AVmAttestationResult *res = NULL;
    *st = AVmPayload_requestAttestation(ch, sizeof ch, &res);
    if (*st != ATTESTATION_OK || !res) { if (res) AVmAttestationResult_free(res); return NULL; }
    return res;
}
static int app_attest_abi2(const char *identity, const uint8_t app_sha[32]) {
    char exec_pages[48], eb[16];
    void *pg = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (pg == MAP_FAILED) snprintf(exec_pages, sizeof exec_pages, "no-mapping:%s", errno_name(errno, eb, sizeof eb));
    else {
        if (mprotect(pg, 4096, PROT_READ | PROT_EXEC) == 0) snprintf(exec_pages, sizeof exec_pages, "allowed");
        else snprintf(exec_pages, sizeof exec_pages, "refused:%s", errno_name(errno, eb, sizeof eb));
        munmap(pg, 4096);
    }
    int wx = -1; { FILE *m = fopen("/proc/self/maps", "r"); char l[1024];
        if (m) { wx = 0; while (fgets(l, sizeof l, m)) { char perm[8] = ""; if (sscanf(l, "%*s %7s", perm) == 1 && strchr(perm, 'w') && strchr(perm, 'x')) wx++; } fclose(m); } }
    if (wx != 0) { OUT("APP refused: %s", wx < 0 ? "this process's mappings could not be read, so W^X cannot be stated" : "this process holds a writable+executable mapping"); return 4; }
    snprintf(g_abi2_tuple, sizeof g_abi2_tuple, "exec_pages=%s wx=clean maps=1 scope=self", exec_pages);
    OUT("ABI2 selftest %s", g_abi2_tuple);
    OUT("ABI2 runtime %s", identity);
    if (!g_caps_nonce_kind && !g_app_nonce_set) { OUT("ABI2 unavailable: no nonce in this session (the app runs; a verifier admits nothing without ABI/2 evidence)"); return 0; }
    const uint8_t *nonce = g_app_nonce_set ? g_app_nonce : g_caps_nonce;
    const char *nonce_kind = g_app_nonce_set ? "relay app nonce" : g_caps_nonce_kind == 2 ? "relay-bound" : "owner challenge only";
    uint8_t rid[32], bind[32];
    AVmAttestationStatus st; abi2_instance inst;
    AVmAttestationResult *res = abi2_certify(identity, nonce, app_sha, rid, bind, g_inst ? &inst : NULL, &st);
    char nh[65], ah[65], bh[65], rh[65]; sh_pads_bin2hex(nonce, 32, nh); sh_pads_bin2hex(app_sha, 32, ah); sh_pads_bin2hex(bind, 32, bh); sh_pads_bin2hex(rid, 32, rh);
    OUT("ABI2 binding nonce=%s (%s) runtime_id=%s %s=%s app=%s", nh, nonce_kind, rh, g_inst ? "bind3" : "bind2", bh, ah);
    if (g_inst) {   /* v3: the instance key and its signature, for the relay's hub to check at attach (public values) */
        char kh[89], sg[129], ih[65]; sh_pads_bin2hex(inst.spki, 44, kh); sh_pads_bin2hex(inst.sig, 64, sg); sh_pads_bin2hex(inst.id, 32, ih);
        OUT("ABI2 instance key=%s sig=%s id=%s", kh, sg, ih);
    }
    if (!res) { OUT("ABI2 unavailable: attestation status=%s (the app runs; a verifier admits nothing without ABI/2 evidence)", AVmAttestationStatus_toString(st)); return 0; }
    const size_t n = AVmAttestationResult_getCertificateCount(res);
    for (size_t i = 0; i < n; i++) {
        const size_t sz = AVmAttestationResult_getCertificateAt(res, i, NULL, 0);
        uint8_t *c = malloc(sz); if (!c) continue;
        AVmAttestationResult_getCertificateAt(res, i, c, sz);
        char label[24]; snprintf(label, sizeof label, "ABI2_LINK%zu", i); hexline(label, c, sz); free(c);
    }
    AVmAttestationResult_free(res);
    OUT("ABI2 end certs=%zu", n);
    return 0;
}
/* LAB, the client-verified channel (PVM-CPU.md): while the app is served over https, vsock EVIDENCE_PORT answers a CLIENT's
 * nonce with a fresh ABI/2 certificate for this app and this VM's transport key, so a client verifies the VM itself and
 * never takes a key or a verdict from the relay or the phone. One line in, `EVIDENCE <64 lowercase hex>`; one JSON line
 * out (format enclave-pvm-app-evidence/v1: nonce, app, spki, identity, selftest, chain). Bounded: a 5 s read, one request
 * per connection, at most one answer every 2 s and 120 per session. Logs public facts only (the nonce prefix, the count). */
#define EVIDENCE_PORT 7787
static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static size_t b64_encode(const uint8_t *in, size_t n, char *out) {
    size_t o = 0;
    for (size_t i = 0; i < n; i += 3) {
        const uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < n ? (uint32_t)in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
        out[o++] = B64[v >> 18 & 63]; out[o++] = B64[v >> 12 & 63];
        out[o++] = i + 1 < n ? B64[v >> 6 & 63] : '='; out[o++] = i + 2 < n ? B64[v & 63] : '=';
    }
    out[o] = 0; return o;
}
/* v2 (the browser channel, PVM-CPU.md): with an app key, each answer also carries appKey (the X25519 key pvm-rt made in this
 * process for sealed requests) and appKeySig, the transport key's Ed25519 signature over "enclave-pvm-app-key-v1\n" ||
 * nonce || app || appKey; the answered nonce then admits sealed requests (pvm-rt sealed.rs: its window and budget). */
typedef int (*pvmrt_http_sealed_nonce_fn)(const void *, const uint8_t *);
typedef struct { int ls; volatile int stop; const char *identity; uint8_t app[32]; int answered;
                 int sealed; uint8_t app_key[32]; const void *srv; pvmrt_http_sealed_nonce_fn admit; } evidence_srv;
static void evidence_answer(evidence_srv *e, int c) {
    struct timeval tv = { 5, 0 }; setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    char line[128]; size_t n = 0;
    while (n + 1 < sizeof line) { char ch; ssize_t r = read(c, &ch, 1); if (r <= 0) break; if (ch == '\n') break; line[n++] = ch; }
    line[n] = 0;
    const int v3 = strncmp(line, "EVIDENCE3 ", 10) == 0;   /* v3: bound to this VM instance (INSTANCE-BINDING.md) */
    const char *h = line + (v3 ? 10 : 9); size_t hl = 0;
    if (v3 || strncmp(line, "EVIDENCE ", 9) == 0) while (hl < 64 && ((h[hl] >= '0' && h[hl] <= '9') || (h[hl] >= 'a' && h[hl] <= 'f'))) hl++;
    if (hl != 64 || h[64] != 0) { write_all(c, "{\"error\":\"request is EVIDENCE <64 lowercase hex> or EVIDENCE3 <64 lowercase hex>\"}\n", strlen("{\"error\":\"request is EVIDENCE <64 lowercase hex> or EVIDENCE3 <64 lowercase hex>\"}\n")); return; }
    if (v3 && (!g_inst || !e->sealed)) { write_all(c, "{\"error\":\"v3 evidence needs this VM's instance key and a sealed app key\"}\n", strlen("{\"error\":\"v3 evidence needs this VM's instance key and a sealed app key\"}\n")); return; }
    if (e->answered >= 120) { write_all(c, "{\"error\":\"evidence budget spent for this session\"}\n", strlen("{\"error\":\"evidence budget spent for this session\"}\n")); return; }
    uint8_t nonce[32], rid[32], bind[32]; unhex(h, nonce, 32); abi2_instance inst;
    AVmAttestationStatus st; AVmAttestationResult *res = abi2_certify(e->identity, nonce, e->app, rid, bind, v3 ? &inst : NULL, &st);
    if (!res) { OUT("EVIDENCE unavailable: attestation status=%s", AVmAttestationStatus_toString(st)); write_all(c, "{\"error\":\"attestation unavailable\"}\n", strlen("{\"error\":\"attestation unavailable\"}\n")); return; }
    const size_t k = AVmAttestationResult_getCertificateCount(res);
    /* the answer's size, exactly: 4 KiB for the fields, the escaped identity (<= 2 x its 1024-byte bound) and the tail, plus
     * each certificate's exact base64 length and its quotes and comma. The old estimate (1 KiB + 4/3 of each certificate,
     * integer division) left v3's two extra fields without room: snprintf cut the final "]}\n" to "]}" + NUL on some
     * attestations (seen on the device, 2026-09-24: a v3 answer ending in 0x00, which the client refused as unparseable) */
    size_t cap = 4096 + 2 * strlen(e->identity); for (size_t i = 0; i < k; i++) cap += (AVmAttestationResult_getCertificateAt(res, i, NULL, 0) + 2) / 3 * 4 + 4;
    char *js = malloc(cap); uint8_t *der = NULL;
    if (!js) { AVmAttestationResult_free(res); return; }
    char nh[65], ah[65], sh[89]; uint8_t spki[44]; memcpy(spki, ED25519_SPKI_PREFIX, 12); memcpy(spki + 12, g_tpk, 32);
    sh_pads_bin2hex(nonce, 32, nh); sh_pads_bin2hex(e->app, 32, ah); for (int i = 0; i < 44; i++) sprintf(sh + 2 * i, "%02x", spki[i]);
    size_t o;
    if (v3) {   /* v3: the app key vouched for under THIS nonce, THIS app and THIS instance; the instance key and its signature */
        static const char dom[] = "enclave-pvm-app-key-v2\n"; uint8_t m[sizeof dom - 1 + 128], sig[64]; char kh[65], sg[129], ik[89], is[129];
        memcpy(m, dom, sizeof dom - 1); memcpy(m + sizeof dom - 1, nonce, 32); memcpy(m + sizeof dom - 1 + 32, e->app, 32);
        memcpy(m + sizeof dom - 1 + 64, inst.id, 32); memcpy(m + sizeof dom - 1 + 96, e->app_key, 32);
        { uint8_t sm[64 + sizeof m]; unsigned long long smlen = 0; crypto_sign(sm, &smlen, m, sizeof m, g_tsk); memcpy(sig, sm, 64); }
        sh_pads_bin2hex(e->app_key, 32, kh); sh_pads_bin2hex(sig, 64, sg); sh_pads_bin2hex(inst.spki, 44, ik); sh_pads_bin2hex(inst.sig, 64, is);
        o = (size_t)snprintf(js, cap, "{\"format\":\"enclave-pvm-app-evidence/v3\",\"nonce\":\"%s\",\"app\":\"%s\",\"spki\":\"%s\",\"instanceKey\":\"%s\",\"instanceSig\":\"%s\",\"appKey\":\"%s\",\"appKeySig\":\"%s\",\"identity\":\"", nh, ah, sh, ik, is, kh, sg);
    } else if (e->sealed) {   /* v2: the app key, vouched for by the attested transport key under THIS nonce and THIS app */
        static const char dom[] = "enclave-pvm-app-key-v1\n"; uint8_t m[sizeof dom - 1 + 96], sig[64]; char kh[65], sg[129];
        memcpy(m, dom, sizeof dom - 1); memcpy(m + sizeof dom - 1, nonce, 32); memcpy(m + sizeof dom - 1 + 32, e->app, 32); memcpy(m + sizeof dom - 1 + 64, e->app_key, 32);
        { uint8_t sm[64 + sizeof m]; unsigned long long smlen = 0; crypto_sign(sm, &smlen, m, sizeof m, g_tsk); memcpy(sig, sm, 64); }   /* TweetNaCl: sig || m */
        sh_pads_bin2hex(e->app_key, 32, kh); sh_pads_bin2hex(sig, 64, sg);
        o = (size_t)snprintf(js, cap, "{\"format\":\"enclave-pvm-app-evidence/v2\",\"nonce\":\"%s\",\"app\":\"%s\",\"spki\":\"%s\",\"appKey\":\"%s\",\"appKeySig\":\"%s\",\"identity\":\"", nh, ah, sh, kh, sg);
    } else o = (size_t)snprintf(js, cap, "{\"format\":\"enclave-pvm-app-evidence/v1\",\"nonce\":\"%s\",\"app\":\"%s\",\"spki\":\"%s\",\"identity\":\"", nh, ah, sh);
    for (const char *q = e->identity; *q && o + 4 < cap; q++) { if (*q == '"' || *q == '\\') js[o++] = '\\'; js[o++] = *q; }   /* the identity as a JSON string */
    o += (size_t)snprintf(js + o, cap - o, "\",\"selftest\":\"%s\",\"chain\":[", g_abi2_tuple);
    for (size_t i = 0; i < k; i++) {
        const size_t sz = AVmAttestationResult_getCertificateAt(res, i, NULL, 0);
        uint8_t *nd = realloc(der, sz); if (!nd) break; der = nd;
        AVmAttestationResult_getCertificateAt(res, i, der, sz);
        js[o++] = i ? ',' : ' '; if (!i) o--; js[o++] = '"'; o += b64_encode(der, sz, js + o); js[o++] = '"';
    }
    o += (size_t)snprintf(js + o, cap - o, "]}\n");
    AVmAttestationResult_free(res); free(der);
    if (o >= cap || js[o - 1] != '\n') {   /* fail closed: a cut answer is never sent as evidence */
        OUT("EVIDENCE refused: the answer (%zu bytes) did not fit its buffer (%zu)", o, cap);
        write_all(c, "{\"error\":\"evidence answer did not fit\"}\n", strlen("{\"error\":\"evidence answer did not fit\"}\n")); free(js); return;
    }
    if (write_all(c, js, o) == 0) {
        e->answered++;
        const int admitted = e->sealed && e->admit && e->admit(e->srv, nonce) == 0;
        OUT("EVIDENCE answered nonce=%.16s... (%s, %zu certificates, answer %d%s)", nh, v3 ? "v3" : e->sealed ? "v2" : "v1", k, e->answered, admitted ? ": sealed requests admitted under it" : "");
    }
    free(js);
}
static void *evidence_server(void *arg) {
    evidence_srv *e = (evidence_srv *)arg; uint64_t last = 0;
    while (!e->stop) {
        struct pollfd pf = { .fd = e->ls, .events = POLLIN };
        if (poll(&pf, 1, 500) <= 0 || !(pf.revents & POLLIN)) continue;
        const int c = accept(e->ls, NULL, NULL); if (c < 0) continue;
        const uint64_t now = boot_ms();
        if (last && now - last < 2000) { write_all(c, "{\"error\":\"one evidence answer every 2 s\"}\n", strlen("{\"error\":\"one evidence answer every 2 s\"}\n")); close(c); continue; }
        last = now; evidence_answer(e, c); close(c);
    }
    return NULL;
}
/* A wasi:http app (APP ... serve=http; runtime/pvm-rt httpd.rs): verified, compiled and pre-instantiated once, then served
 * on APP_HTTP_PORT one connection at a time -- a fresh instance per request, 256 MiB and a deadline each -- until the owner
 * sends STOP on the control channel, the channel closes, or an hour passes with neither a connection nor a word. */
typedef void *(*pvmrt_http_open_fn)(const uint8_t *, size_t, const uint8_t *, uint64_t, uint64_t, const char *, const pvmrt_nn_ops *,
                                    void (*)(int, const uint8_t *, size_t), uint64_t *, char *, size_t);
typedef int (*pvmrt_http_serve_fd_fn)(void *, int, char *, size_t);
typedef uint64_t (*pvmrt_http_requests_fn)(const void *);
typedef void (*pvmrt_http_close_fn)(void *);
typedef void *(*pvmrt_https_open_fn)(const uint8_t *, size_t, const uint8_t *, uint64_t, uint64_t, const char *, const pvmrt_nn_ops *,
                                     const uint8_t *, void (*)(int, const uint8_t *, size_t), uint64_t *, char *, size_t);
typedef int (*pvmrt_http_sealed_enable_fn)(void *, const uint8_t *, const uint8_t *, uint8_t *);
typedef int (*pvmrt_http_serve_sealed_fd_fn)(void *, int, char *, size_t);
#define SEALED_PORT 7788   /* LAB, the browser channel: one HPKE-sealed HTTP request per connection (pvm-rt sealed.rs) */
static int app_serve(app_ready *a, const pvmrt_nn_ops *ops) {
    const anchor_app_plan *plan = a->plan;
    pvmrt_http_open_fn hopen = (pvmrt_http_open_fn)dlsym(a->rt, "pvmrt_http_open");
    pvmrt_https_open_fn hsopen = (pvmrt_https_open_fn)dlsym(a->rt, "pvmrt_https_open");
    const int tls = plan->http == 2;
    pvmrt_http_serve_fd_fn hserve = (pvmrt_http_serve_fd_fn)dlsym(a->rt, "pvmrt_http_serve_fd");
    pvmrt_http_requests_fn hreqs = (pvmrt_http_requests_fn)dlsym(a->rt, "pvmrt_http_requests");
    pvmrt_http_close_fn hclose = (pvmrt_http_close_fn)dlsym(a->rt, "pvmrt_http_close");
    if (!hopen || !hserve || !hreqs || !hclose || (tls && !hsopen)) { free(a->bytes); a->bytes = NULL; OUT("APP refused: this runtime cannot serve wasi:http%s", tls ? " over TLS" : ""); return 4; }
    uint64_t cms = 0; char err[1024] = "";
    /* https: TLS 1.3 terminates in this process with the VM's Ed25519 transport key -- the key the attach transcript and the
     * app's ABI/2 evidence bind -- so whatever carries the bytes (the phone's Android app, the relay) holds only ciphertext.
     * The seed is libsodium's secret key's first half; pvm-rt copies it into its TLS config and zeroes its own copy. */
    void *srv = tls ? hsopen(a->bytes, plan->bytes, plan->sha256, 256ull << 20, ops ? 600000 : 60000, ops ? plan->graph : NULL, ops, g_tsk, app_emit, &cms, err, sizeof err)
                    : hopen(a->bytes, plan->bytes, plan->sha256, 256ull << 20, ops ? 600000 : 60000, ops ? plan->graph : NULL, ops, app_emit, &cms, err, sizeof err);
    free(a->bytes); a->bytes = NULL;
    char hh[65]; sh_pads_bin2hex(plan->sha256, 32, hh);
    if (!srv) { OUT("APP refused: %s", err); return 4; }
    memcpy(g_app_sha256, plan->sha256, 32); g_app_have = 1;
    const int ls = vs_bind(APP_HTTP_PORT);
    if (ls < 0) { hclose(srv); OUT("APP refused: cannot listen on the http port"); return 4; }
    evidence_srv ev = { .ls = -1, .stop = 0, .identity = a->identity, .answered = 0 }; pthread_t evt; int ev_on = 0;
    int ls_sealed = -1;
    pvmrt_http_serve_sealed_fd_fn hsealed_serve = NULL;
    if (tls) {   /* LAB, the browser channel: an app key made in pvm-rt, signed into v2 evidence, and a sealed-request port */
        pvmrt_http_sealed_enable_fn hsealed = (pvmrt_http_sealed_enable_fn)dlsym(a->rt, "pvmrt_http_sealed_enable");
        pvmrt_http_sealed_nonce_fn hadmit = (pvmrt_http_sealed_nonce_fn)dlsym(a->rt, "pvmrt_http_sealed_nonce");
        hsealed_serve = (pvmrt_http_serve_sealed_fd_fn)dlsym(a->rt, "pvmrt_http_serve_sealed_fd");
        uint8_t rid[32]; sha256((const uint8_t *)a->identity, strlen(a->identity), rid);   /* the RuntimeID ABI/2 binds */
        if (hsealed && hadmit && hsealed_serve && hsealed(srv, plan->sha256, rid, ev.app_key) == 0 && (ls_sealed = vs_bind(SEALED_PORT)) >= 0) {
            ev.sealed = 1; ev.srv = srv; ev.admit = hadmit;
            char kh[65]; sh_pads_bin2hex(ev.app_key, 32, kh);
            OUT("APP sealed requests on vsock %d: app key %.16s... (X25519, made in this process; evidence is v2)", SEALED_PORT, kh);
        } else OUT("APP sealed requests NOT available (evidence stays v1: no browser channel)");
    }
    if (tls) {   /* LAB: the client-verified channel's evidence endpoint beside the TLS app port */
        memcpy(ev.app, plan->sha256, 32); ev.ls = vs_bind(EVIDENCE_PORT);
        if (ev.ls >= 0 && pthread_create(&evt, NULL, evidence_server, &ev) == 0) { ev_on = 1; OUT("APP evidence endpoint on vsock %d: a client's nonce gets a fresh ABI/2 certificate for this app and this VM's transport key", EVIDENCE_PORT); }
        else { if (ev.ls >= 0) close(ev.ls); OUT("APP evidence endpoint NOT available (a client cannot verify this VM itself)"); }
    }
    OUT("APP serving %s on vsock %d: %s compile_ms=%llu%s%s", tls ? "https (TLS 1.3, the attested transport key)" : "http", APP_HTTP_PORT, hh, (unsigned long long)cms, ops ? " graph=" : "", ops ? plan->graph : "");
    for (;;) {
        struct pollfd pf[3] = { { .fd = ls, .events = POLLIN }, { .fd = g_ctl, .events = POLLIN }, { .fd = ls_sealed, .events = POLLIN } };
        const int r = poll(pf, ls_sealed >= 0 ? 3 : 2, 3600 * 1000);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) { OUT("APP http: an hour without a connection or a word from the owner; stopping"); break; }
        if (pf[1].revents) { char l[64]; if (read_line(g_ctl, l, sizeof l) < 0 || !strcmp(l, "STOP")) { OUT("APP http: stopped by the owner"); break; } OUT("APP http: control line ignored while serving"); continue; }
        if (pf[0].revents & POLLIN) {
            const int c = accept(ls, NULL, NULL); if (c < 0) continue;
            char e[512] = ""; const int rc = hserve(srv, c, e, sizeof e);
            OUT("APP http connection closed%s%s (requests so far %llu)", rc ? ": " : "", rc ? e : "", (unsigned long long)hreqs(srv));
        }
        if (ls_sealed >= 0 && (pf[2].revents & POLLIN)) {
            const int c = accept(ls_sealed, NULL, NULL); if (c < 0) continue;
            char e[512] = ""; const int rc = hsealed_serve(srv, c, e, sizeof e);
            OUT("APP sealed connection closed%s%s (requests so far %llu)", rc ? ": " : "", rc ? e : "", (unsigned long long)hreqs(srv));
        }
    }
    close(ls); if (ls_sealed >= 0) close(ls_sealed);
    if (ev_on) { ev.stop = 1; pthread_join(evt, NULL); close(ev.ls); OUT("APP evidence endpoint closed after %d answers", ev.answered); }
    OUT("APP served %s requests=%llu%s%s", hh, (unsigned long long)hreqs(srv), ops ? " graph=" : "", ops ? plan->graph : "");
    hclose(srv);
    return 0;
}
static int run_app(const anchor_app_plan *plan) {
    app_ready a; int r = app_receive(plan, &a);
    if (!r && (r = app_attest_abi2(a.identity, plan->sha256)) != 0) free(a.bytes);
    return r ? r : plan->http ? app_serve(&a, NULL) : app_exec(&a, NULL);
}
/* APP over LOCAL (milestone 3): the component first (small, and refused before any model work if it does not arrive), then
 * the staged model loaded and self-tested by the CPU engine exactly as for a conversation; the engine then hands its model
 * to app_nn_host instead of serving the chat port. The capability report (CAPS, with the self-test digest) is emitted
 * before the app runs, so one capture holds both digests: the engine's own path and the app's path through wasi:nn. */
static int app_nn_host(const pvmrt_nn_ops *ops, void *arg) { app_ready *a = (app_ready *)arg; return a->plan->http ? app_serve(a, ops) : app_exec(a, ops); }
static int run_app_nn(const anchor_local_plan *lp, const anchor_app_plan *ap) {
    app_ready a; int r = app_receive(ap, &a); if (r) return r;
    if ((r = app_attest_abi2(a.identity, ap->sha256)) != 0) { free(a.bytes); return r; }
    const char *apk = AVmPayload_getApkContentsPath();
    char lib_dir[512]; snprintf(lib_dir, sizeof lib_dir, "%s/lib/arm64-v8a", apk);
    if (model_stage(lp->model_bytes) != 0) { free(a.bytes); return 4; }   /* hashed + judged after the last write, before any parse */
    if (g_model_state != 1 || !g_staged_table || !g_staged_table->t) { free(a.bytes); OUT("APP refused: no staged model table"); return 4; }
    static const char *libs[] = { "libc++_shared.so", "libggml-base.so", "libggml.so", "libllama.so", "libllama-common.so", "liblocalengine.so" };
    void *h = NULL;
    for (unsigned i = 0; i < sizeof libs / sizeof *libs; i++) {
        char path[600]; snprintf(path, sizeof path, "%s/%s", lib_dir, libs[i]);
        if (!(h = dlopen(path, RTLD_NOW | RTLD_GLOBAL))) { free(a.bytes); OUT("APP refused: dlopen %s: %s", libs[i], dlerror()); return 4; }
    }
    engine_local_main_fn em = (engine_local_main_fn)dlsym(h, "engine_local_main");
    void (*setw)(int (*)(const char *, size_t)) = (void (*)(int (*)(const char *, size_t)))dlsym(h, "engine_local_set_ctl_writer");
    void (*sett)(const anchor_gguf_table *, const anchor_hash_ops *) = (void (*)(const anchor_gguf_table *, const anchor_hash_ops *))dlsym(h, "engine_local_set_model_table");
    void (*setst)(void (*)(const char *, int, double, double, const uint8_t *)) = (void (*)(void (*)(const char *, int, double, double, const uint8_t *)))dlsym(h, "engine_local_set_selftest");
    void (*setnn)(pvmrt_nn_host_fn, void *) = (void (*)(pvmrt_nn_host_fn, void *))dlsym(h, "engine_local_set_nn_host");
    if (!em || !setw || !sett || !setst || !setnn) { free(a.bytes); OUT("APP refused: liblocalengine.so lacks the engine, its self-test or its app-runtime hook"); return 4; }
    setw(anchor_ctl_write); sett(g_staged_table, &g_hash_ops);
    g_caps_threads = lp->threads; g_caps_ctx = lp->ctx; g_caps_model_bytes = lp->model_bytes; setst(caps_sink);   /* the tier's self-test is not optional */
    setnn(app_nn_host, &a);
    if (AVmPayload_getEncryptedStoragePath()) setenv("ANCHOR_ENCRYPTED_STORE", AVmPayload_getEncryptedStoragePath(), 1);
    if (lp->dthreads > 0) { char dv[16]; snprintf(dv, sizeof dv, "%d", lp->dthreads); setenv("ANCHOR_DECODE_THREADS", dv, 1); }
    if (lp->poll >= 0) { char pv[16]; snprintf(pv, sizeof pv, "%d", lp->poll); setenv("ANCHOR_POOL_POLL", pv, 1); }
    OUT("APP over the model: %" PRIu64 " bytes, %d threads, ctx %d, graph %s", lp->model_bytes, lp->threads, lp->ctx, ap->graph);
    r = em(-1, g_model_fd, lib_dir, lp->threads, lp->ctx);
    if (a.bytes) { free(a.bytes); OUT("APP refused: the engine ended before the app ran (engine exit %d)", r); return 4; }
    return r == 0 ? 0 : 4;
}
#endif
static void run_local(const anchor_local_plan *plan, int ls_wk) {
    const char *apk = AVmPayload_getApkContentsPath();
    char lib_dir[512]; snprintf(lib_dir, sizeof lib_dir, "%s/lib/arm64-v8a", apk);
    int ls_chat = vs_bind(LOCAL_PORT);
    if (ls_chat < 0) { OUT("LOCAL refused: cannot listen on the chat port"); return; }
    if (g_auth_catalog_requested) { OUT("LOCAL refused: catalog authentication is not wired into the local engine yet; stage with the whole-file digest"); close(ls_chat); return; }
    if (model_stage(plan->model_bytes) != 0) { close(ls_chat); return; }   /* hashed + judged after the last write, before any parse */
    int model_fd = g_model_fd;
    if (g_model_state != 1 || !g_staged_table || !g_staged_table->t) { OUT("LOCAL refused: no staged model table"); close(ls_chat); return; }
    char bundle[600] = ""; int worker_fd = -1;
    if (plan->tpu_bundle_bytes) {   /* Shielded-TPU decode: the public lane bundle, then the app's TPU worker on the worker port */
        int ls_b = vs_bind(BUNDLE_PORT); if (ls_b < 0 || receive_public_file(ls_b, plan->tpu_bundle_bytes, "tpu.bundle", bundle, sizeof bundle) != 0) { if (ls_b >= 0) close(ls_b); close(ls_chat); return; }
        close(ls_b);
        worker_fd = vs_accept(ls_wk, 300000);      /* the worker loads 35 compiled graphs before it dials */
        if (worker_fd < 0) { OUT("LOCAL tpu: no worker connection from the owner within 300 s"); close(ls_chat); return; }
        OUT("LOCAL tpu: worker connected; masked rows only cross this link");
        if (plan->links >= 2) tpu_link_bench(plan->links);   /* its OWN port; closed before the engine loads */
    }
    char draft[600] = "";
    if (plan->draft_bytes) {   /* speculative rows: a drafter model, public and unauthenticated on purpose (the target verifies every proposal) */
        int ls_d = vs_bind(DRAFT_PORT); if (ls_d < 0 || receive_public_file(ls_d, plan->draft_bytes, "draft.gguf", draft, sizeof draft) != 0) { if (ls_d >= 0) close(ls_d); if (worker_fd >= 0) close(worker_fd); close(ls_chat); return; }
        close(ls_d);
    }
    static const char *libs[] = { "libc++_shared.so", "libggml-base.so", "libggml.so", "libllama.so", "libllama-common.so", "liblocalengine.so" };   /* the CPU module is loaded by the engine: the REPACKING build */
    void *h = NULL;
    for (unsigned i = 0; i < sizeof libs / sizeof *libs; i++) {
        char path[600]; snprintf(path, sizeof path, "%s/%s", lib_dir, libs[i]);
        h = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
        if (!h) { OUT("LOCAL dlopen %s: %s", libs[i], dlerror()); close(ls_chat); return; }
    }
    engine_local_main_fn em = (engine_local_main_fn)dlsym(h, "engine_local_main");
    void (*setw)(int (*)(const char *, size_t)) = (void (*)(int (*)(const char *, size_t)))dlsym(h, "engine_local_set_ctl_writer");
    void (*sett)(const anchor_gguf_table *, const anchor_hash_ops *) = (void (*)(const anchor_gguf_table *, const anchor_hash_ops *))dlsym(h, "engine_local_set_model_table");
    if (!em || !setw || !sett) { OUT("LOCAL refused: liblocalengine.so lacks engine_local_main / its setters"); close(ls_chat); return; }
    setw(anchor_ctl_write); sett(g_staged_table, &g_hash_ops);
#ifdef ANCHOR_TIER_PVM_CPU
    {   /* the tier's capability self-test is not optional: an engine that cannot run it does not serve this tier */
        void (*setst)(void (*)(const char *, int, double, double, const uint8_t *)) =
            (void (*)(void (*)(const char *, int, double, double, const uint8_t *)))dlsym(h, "engine_local_set_selftest");
        if (!setst) { OUT("LOCAL refused: this engine cannot run the pVM CPU capability self-test"); close(ls_chat); return; }
        g_caps_threads = plan->threads; g_caps_ctx = plan->ctx; g_caps_model_bytes = plan->model_bytes; setst(caps_sink);
    }
#endif
    if (draft[0]) {
        int (*setd)(const char *, int) = (int (*)(const char *, int))dlsym(h, "engine_local_set_draft");
        if (!setd || setd(draft, plan->draft_max) != 0) { OUT("LOCAL refused: this engine cannot take a drafter"); if (worker_fd >= 0) close(worker_fd); close(ls_chat); return; }
    }
    if (worker_fd >= 0) {
        engine_local_set_tpu_fn settpu = (engine_local_set_tpu_fn)dlsym(h, "engine_local_set_tpu");
        if (!settpu || settpu(bundle, worker_fd, plan->bank, plan->refill) != 0) { OUT("LOCAL refused: this engine cannot take the Shielded-TPU link"); close(worker_fd); close(ls_chat); return; }
    }
    if (AVmPayload_getEncryptedStoragePath()) setenv("ANCHOR_ENCRYPTED_STORE", AVmPayload_getEncryptedStoragePath(), 1);   /* engine-local.err lives there */
    if (plan->spin > 0) { char sv[16]; snprintf(sv, sizeof sv, "%d", plan->spin); setenv("ANCHOR_TPU_SPIN_US", sv, 1); }   /* read once, lazily, by ggml-tpu.cpp */
    if (plan->vthreads > 0) { char vv[16]; snprintf(vv, sizeof vv, "%d", plan->vthreads); setenv("ANCHOR_VERIFY_THREADS", vv, 1); }   /* engine_local.cpp: the verification pool */
    if (plan->corr > 0) { char cv[16]; snprintf(cv, sizeof cv, "%d", plan->corr); setenv("ANCHOR_TPU_CORR_THREADS", cv, 1); }   /* ggml-tpu.cpp: correction helpers */
    if (plan->dthreads > 0) { char dv[16]; snprintf(dv, sizeof dv, "%d", plan->dthreads); setenv("ANCHOR_DECODE_THREADS", dv, 1); }   /* engine_local.cpp: a separate decode pool */
    if (plan->poll >= 0) { char pv[16]; snprintf(pv, sizeof pv, "%d", plan->poll); setenv("ANCHOR_POOL_POLL", pv, 1); }   /* engine_local.cpp: the thread pool's polling level */
    OUT("LOCAL listening on vsock %d for the conversation; model %" PRIu64 " bytes, %d threads, ctx %d", LOCAL_PORT, plan->model_bytes, plan->threads, plan->ctx);
    int chat = vs_accept(ls_chat, 120000); close(ls_chat);
    if (chat < 0) { OUT("LOCAL no chat connection from the owner within 120 s"); return; }
    int rc = em(chat, model_fd, lib_dir, plan->threads, plan->ctx);
    close(chat);
    OUT("LOCAL exit %d", rc);
}
static void run_engine(int ls_wk, int ls_model, int ls_pads, const char *prompt, int n_predict, int threads, uint64_t model_bytes, int with_pads, int with_prefix) {
    const char *apk = AVmPayload_getApkContentsPath();
    char lib_dir[512], calib[512]; snprintf(lib_dir, sizeof lib_dir, "%s/lib/arm64-v8a", apk); snprintf(calib, sizeof calib, "%s/assets/model.calib", apk);
    int worker_fd = vs_accept(ls_wk, 60000);
    if (worker_fd < 0) { OUT("ENGINE no worker bridge from the owner"); return; }
    (void)ls_model;
    if (model_stage(model_bytes) != 0) { close(worker_fd); return; }   /* hashed + judged after the last write, before any parse */
    int model_fd = g_model_fd;
    static const char *libs[] = { "libc++_shared.so", "libggml-base.so", "libggml.so", "libggml-cpu.so", "libllama.so", "libengine.so" };
    void *h = NULL;
    for (unsigned i = 0; i < sizeof libs / sizeof *libs; i++) {
        char path[600]; snprintf(path, sizeof path, "%s/%s", lib_dir, libs[i]);
        h = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
        if (!h) { OUT("ENGINE dlopen %s: %s", libs[i], dlerror()); close(worker_fd); close(model_fd); return; }
    }
    engine_main_fn em = (engine_main_fn)dlsym(h, "engine_main");
    { void (*setw)(int (*)(const char *, size_t)) = (void (*)(int (*)(const char *, size_t)))dlsym(h, "engine_set_ctl_writer");
      if (setw) setw(anchor_ctl_write); else OUT("ENGINE has no engine_set_ctl_writer: its lines bypass the writers' lock"); }
    { /* Optional, and only the quiet opt-in uses it: the BOUNDED writer. An engine
       * without the setter simply never gets one, and its quiet opt-in refuses to
       * enable rather than falling back to the blocking writer. */
      void (*setwt)(int (*)(const char *, size_t, uint64_t)) =
          (void (*)(int (*)(const char *, size_t, uint64_t)))dlsym(h, "engine_set_ctl_writer_timed");
      if (setwt) setwt(anchor_ctl_write_timed); }
    if (g_model_state != 1 || !g_staged_table || !g_staged_table->t) { OUT("ENGINE refused: no staged model table"); close(worker_fd); close(model_fd); return; }
    if (g_auth_mode == ANCHOR_MODEL_AUTH_CATALOG_V1) {   /* the engine must take the versioned capability or it does not run this model */
      int (*seta)(const anchor_model_auth_v1 *) = (int (*)(const anchor_model_auth_v1 *))dlsym(h, "engine_set_model_auth_v1");
      if (!seta) { OUT("ENGINE refused: this engine cannot interpret catalog authentication (no engine_set_model_auth_v1)"); close(worker_fd); close(model_fd); return; }
      static anchor_model_auth_v1 auth; memset(&auth, 0, sizeof auth);
      auth.size = sizeof auth; auth.version = ANCHOR_MODEL_AUTH_VERSION; auth.mode = ANCHOR_MODEL_AUTH_CATALOG_V1; auth.table = g_staged_table; auth.hops = &g_hash_ops;
      memcpy(auth.model_identity, g_cat.model_identity, 32); memcpy(auth.source_catalog_sha256, g_cat.catalog_identity, 32);
      if (g_ecat.authenticated) { memcpy(auth.encoded_catalog_sha256, g_ecat.identity, 32); auth.encoded = &g_ecat; auth.artifact_open = artifact_open_cb; auth.artifact_suspect = artifact_suspect_cb; }
      if (seta(&auth) != 0) { OUT("ENGINE refused: the engine did not take the catalog authentication"); close(worker_fd); close(model_fd); return; }
      OUT("ENGINE model authentication: catalog-v1%s", g_ecat.authenticated ? " with encoded artifacts available (engine opt-in ANCHOR_ENCODED_ARTIFACTS=1)" : "");
    } else {
      void (*sett)(const anchor_gguf_table *, const anchor_hash_ops *) = (void (*)(const anchor_gguf_table *, const anchor_hash_ops *))dlsym(h, "engine_set_model_table");
      if (!sett) { OUT("ENGINE refused: engine has no engine_set_model_table"); close(worker_fd); close(model_fd); return; }
      sett(g_staged_table, &g_hash_ops); }
    if (!em) { OUT("ENGINE libengine.so has no engine_main"); return; }
    if (AVmPayload_getEncryptedStoragePath()) setenv("ANCHOR_ENCRYPTED_STORE", AVmPayload_getEncryptedStoragePath(), 1);   /* engine.err lives there */
    anchor_pads pads = { g_tsk, g_ledger_pk, g_pad_name, g_seed_id_hex, g_ledger_pinned };
    const anchor_pads *pp = NULL;
    if (with_prefix) {
        /* the owner streams prefix.kv, prefix.kv.sig and prefix.txt over the
         * pads port; the engine waits for them, verifies against PREFIXPK
         * and this model, and prefills only the user's part */
        if (!g_prefix_pk_hex[0]) { OUT("ENGINE prefix requested but no PREFIXPK from the owner; refusing"); close(worker_fd); close(model_fd); return; }
        if (!g_pads_dir[0]) pads_dir(g_pads_dir, sizeof g_pads_dir);
        char kv[600], pf[600]; snprintf(kv, sizeof kv, "%s/prefix.kv", g_pads_dir); snprintf(pf, sizeof pf, "%s/prefix.txt", g_pads_dir);
        setenv("SHIELDED_PREFIX_KV", kv, 1); setenv("SHIELDED_PREFIX_FILE", pf, 1); setenv("SHIELDED_PREFIX_KV_PK", g_prefix_pk_hex, 1);
        OUT("ENGINE shared-prefix KV expected at %s", kv);
    }
    if (with_pads) {
        if (!g_have_seed || !g_have_ledger) { OUT("ENGINE pads requested but no seed/ledger from the owner; refusing to mint for myself"); close(worker_fd); close(model_fd); return; }
        pads_dir(g_pads_dir, sizeof g_pads_dir);
        char hs[65], hid[33], hsk[65];
        sh_pads_bin2hex(g_seed, 32, hs); sh_pads_bin2hex(g_seed_id, 16, hid); sh_pads_bin2hex(g_psk, 32, hsk);
        setenv("SHIELDED_PAD_SOURCE", g_pads_dir, 1); setenv("SHIELDED_PAD_SEED", hs, 1); setenv("SHIELDED_PAD_SEED_ID", hid, 1); setenv("SHIELDED_PAD_SK", hsk, 1);
        setenv("SHIELDED_PAD_PRUNE", "1", 1);      /* the encrypted store's copy is ours: spent shipments go */
        setenv("SHIELDED_PAD_WAIT_MS", "90000", 1); /* the first shipment lands ~15-20 s after the app starts the dealer; the link's default 10 s bank wait quit before it (seen 2026-09-08) */
        setenv("SHIELDED_PAD_CHECK", "1", 0);        /* the pVM checks every imported pad against the weights: a wrong dealer is refused before use */
        /* Pin the model: only shipments the dealer minted for THIS calibration
         * (SHA-512/256 of the calib file, what shielded-dealer records) are used. */
        { uint8_t dg[32]; char dh[65];
          if (!calib_digest_file(calib, dg)) {   /* no digest, no engine: an all-zero pin is still a value a forged header could carry */
              OUT("ENGINE refused: model.calib could not be hashed whole, no pad model pin"); memset(hs, 0, sizeof hs); memset(hsk, 0, sizeof hsk);
              close(worker_fd); close(model_fd); return;
          }
          sh_pads_bin2hex(dg, 32, dh); setenv("SHIELDED_PAD_MODEL_DIGEST", dh, 1); }
        memset(hs, 0, sizeof hs); memset(hsk, 0, sizeof hsk);
        pp = &pads;
        OUT("ENGINE dealt pads on: bank %s, seed %s", g_pads_dir, g_seed_id_hex);
    }
    if (with_pads || with_prefix || g_ecat.authenticated) {
        /* shipments, the prefix files, and catalog artifacts ride the same port into the store; without the receiver
         * nothing can arrive, so a thread that cannot start refuses the engine now instead of waiting for it */
        pthread_t th; const int prc = pthread_create(&th, NULL, pads_receiver, (void *)(intptr_t)ls_pads);
        if (prc != 0) { OUT("ENGINE refused: pads-port receiver thread: %s", strerror(prc)); close(worker_fd); close(model_fd); return; }
        pthread_detach(th);
    }
    OUT("ENGINE libraries loaded from %s; starting", lib_dir);
    /* ANCHOR_WEIGHT_CACHE=1 (owner-settable, boolean): the compact encoded-weight cache lives in a directory
     * THIS payload chooses inside its encrypted store, never a host-supplied path */
    { const char *wc = getenv("ANCHOR_WEIGHT_CACHE"); const char *es = AVmPayload_getEncryptedStoragePath();
      if (wc && !strcmp(wc, "1") && es) { char d[512]; snprintf(d, sizeof d, "%s/wcache", es); if (mkdir(d, 0700) == 0 || errno == EEXIST) { setenv("SHIELDED_WEIGHT_CACHE_DIR", d, 1); OUT("ENGINE weight cache: %s", d); } else OUT("ENGINE weight cache: cannot create %s: %s", d, strerror(errno)); }
      else if (wc && !strcmp(wc, "1")) OUT("ENGINE weight cache requested but no encrypted store: off");
      else unsetenv("SHIELDED_WEIGHT_CACHE_DIR"); }
    mem_line("before engine");
    int rc = em(g_ctl, worker_fd, model_fd, lib_dir, calib, prompt, n_predict, threads, pp);
    mem_line("after engine");
    OUT("ENGINE exit %d", rc);
    close(model_fd);
}

/* split-harness.c's main, as a function: same fixture, same order of draws, same digest */
/* Worker-bridge frame diagnostic (BRIDGEBENCH): the guest is the client on the worker fd, so the path is
 * guest vsock -> app pump -> TCP echo and back, the same pump a real leg uses. The framed round trip,
 * absolute deadline (both directions), deterministic fill + full compare, and first-failure abort live in
 * anchor-frame-loop.h so a host socketpair fixture exercises the identical code. Strict bounded size
 * parse; a failure stops the whole run and prints BENCH RUN FAILED (never "done"), so the script gate and
 * a reader cannot mistake a desynchronized socket for a result. */
static int run_bridgebench(int fd, const char *sizes) {
    if (fd < 0) { OUT("BENCH no worker bridge"); return -1; }
    static uint8_t sbuf[3u << 20], rbuf[3u << 20]; const size_t cap = sizeof sbuf;
    /* START handshake: the server primes the idle established socket (~2 s) for the watchdog's start
     * bracket, then acks. Generous timeout covers the priming hold. Fail closed. */
    if (anchor_frame_control(fd, 20000) != AFL_OK) { OUT("BENCH START handshake failed"); OUT("BENCH RUN FAILED"); return -1; }
    char csv[128]; snprintf(csv, sizeof csv, "%s", sizes); if (!csv[0]) snprintf(csv, sizeof csv, "65536,262144,1048576,3145728");
    for (char *tok = strtok(csv, ","); tok; tok = strtok(NULL, ",")) {
        while (*tok == ' ') tok++;
        char *end = NULL; errno = 0; unsigned long long v = strtoull(tok, &end, 10);
        if (errno || !end || *end || v < 1 || v > cap) { OUT("BENCH size '%s' out of range (1..%zu)", tok, cap); OUT("BENCH RUN FAILED"); return -1; }
        anchor_frame_stats st = {0};
        const int rc = anchor_frame_bench(fd, (size_t)v, 10, 200, 30000, sbuf, rbuf, &st);
        if (rc != AFL_OK) {
            static const char *const ph[] = {"none","write_len","write_payload","read_len","read_payload"};
            const int pv = st.fail_phase >= 0 && st.fail_phase <= 4 ? st.fail_phase : 0;
            OUT("BENCH %llu B: FAILED (%s) at iter %d phase=%s moved=%llu/%llu (which direction stalled and how far)",
                v, afl_strerror(rc), st.fail_iter, ph[pv], st.fail_moved, st.fail_total);
            OUT("BENCH RUN FAILED"); return -1;
        }
        OUT("BENCH %llu B: p50=%.0f us p90=%.0f us min=%.0f us (n=%d, framed)", v, st.p50_us, st.p90_us, st.min_us, st.iters);
    }
    /* END handshake: the guest is done measuring; the server records t_end and holds the established
     * socket (~1 s) for the watchdog's end bracket, then acks. Fail closed. */
    if (anchor_frame_control(fd, 20000) != AFL_OK) { OUT("BENCH END handshake failed"); OUT("BENCH RUN FAILED"); return -1; }
    OUT("BENCH done");
    return 0;
}

static void run_shape(int64_t K, int64_t N, int n_nodes, int iters, int xmax, int bridge_fd) {
    if (xmax <= 0) { double s_ = 900.0 * sqrt(896.0 / (double)K); xmax = (int)(s_ < 1 ? 1 : s_); }
    fx_rng g = { FX_SEED };
    int8_t *w[AN_MAX_NODES] = { 0 };
    for (int i = 0; i < n_nodes; i++) if (!(w[i] = fx_weight(&g, K, N))) { OUT("{\"K\":%" PRId64 ",\"error\":\"oom\"}", K); return; }
    int64_t *x = malloc((size_t)K * 8); int8_t *planes = malloc((size_t)3 * K), *planes2 = malloc((size_t)3 * K);
    int64_t Ks[AN_MAX_NODES], Ns[AN_MAX_NODES];
    for (int i = 0; i < n_nodes; i++) { Ks[i] = K; Ns[i] = N; }
    const size_t footprint = an_footprint(n_nodes, Ks, Ns);

    an_ctx *a = an_create(rng_os);
    if (!a || !x || !planes || !planes2) { OUT("{\"K\":%" PRId64 ",\"error\":\"oom\"}", K); return; }
    for (int i = 0; i < n_nodes; i++) an_add_weight(a, w[i], K, N);
    double t0 = now_us();
    if (an_prepare(a) != AN_OK) { OUT("{\"K\":%" PRId64 ",\"error\":\"prepare\"}", K); return; }
    double prepare_us = now_us() - t0;

    wk W; memset(&W, 0, sizeof W);
    W.bridge = bridge_fd >= 0;
    if (W.bridge) {
        for (int i = 0; i < n_nodes; i++) if (wc_add(&W.wc, K, N) < 0) { OUT("{\"K\":%" PRId64 ",\"error\":\"wc_add %s\"}", K, W.wc.err); return; }
        sh_pipe *pipe = sh_pipe_open_fd(bridge_fd);
        if (!pipe || wc_install(&W.wc, pipe, (const int8_t *const *)w, 0) != SH_OK) { OUT("{\"K\":%" PRId64 ",\"error\":\"install %s\"}", K, W.wc.err); return; }
    } else {
        W.W = (const int8_t *const *)w; W.K = K; W.N = Ns; W.n = n_nodes;
        W.xm = malloc((size_t)K * 8); W.rlen = (size_t)n_nodes * N * 4; W.reply = malloc(W.rlen);
    }

    double *tp = malloc(iters * 8), *tm = malloc(iters * 8), *tw = malloc(iters * 8), *tf = malloc(iters * 8);
    int exact = 1, verified = 1, lie_rejected = 0, pads_distinct = 0, ywidth = 0;
    int64_t peak = 0; uint64_t digest = 1469598103934665603ull;
    const uint8_t *reply; size_t rlen;

    fx_activation(&g, K, x, xmax);
    for (int r = 0; r < 2; r++) {
        if (an_pad_gen(a) != AN_OK || an_mask(a, x, r ? planes2 : planes) != AN_OK) return;
        if (!wk_exchange(&W, r ? planes2 : planes, &reply, &rlen, &ywidth)) { OUT("{\"K\":%" PRId64 ",\"error\":\"exchange %s\"}", K, W.wc.err); return; }
        if (an_finish(a, reply, rlen, ywidth) != AN_OK) verified = 0;
    }
    pads_distinct = memcmp(planes, planes2, (size_t)3 * K) != 0;

    if (an_pad_gen(a) == AN_OK && an_mask(a, x, planes) == AN_OK && wk_exchange(&W, planes, &reply, &rlen, &ywidth)) {
        uint8_t *evil = malloc(rlen);
        if (evil) { memcpy(evil, reply, rlen); evil[rlen / 2] ^= 1; lie_rejected = an_finish(a, evil, rlen, ywidth) == AN_ERR_VERIFY; free(evil); }
    }

    int done = 0;
    for (int it = 0; it < iters; it++) {
        fx_activation(&g, K, x, xmax);
        double a0 = now_us(); if (an_pad_gen(a) != AN_OK) break;
        double a1 = now_us(); if (an_mask(a, x, planes) != AN_OK) break;
        double a2 = now_us(); if (!wk_exchange(&W, planes, &reply, &rlen, &ywidth)) { OUT("{\"K\":%" PRId64 ",\"error\":\"exchange %s\"}", K, W.wc.err); break; }
        double a3 = now_us(); int rc = an_finish(a, reply, rlen, ywidth);
        double a4 = now_us();
        if (rc != AN_OK) { verified = 0; break; }
        if (an_check_local(a) != AN_OK) { exact = 0; break; }
        for (int nd = 0; nd < n_nodes; nd++) { digest ^= an_y_digest(a, nd); digest *= 1099511628211ull; }
        { int64_t pk = an_peak_abs_y(a); if (pk > peak) peak = pk; }
        tp[it] = a1 - a0; tm[it] = a2 - a1; tw[it] = a3 - a2; tf[it] = a4 - a3; done++;
    }
    uint64_t pads = 0, ex = 0, vf = 0; an_stats(a, &pads, &ex, &vf);
    if (W.bridge) wc_close(&W.wc);
    const int pass = exact && verified && lie_rejected && pads_distinct && done == iters;
    OUT("{\"rung\":\"%s\",\"K\":%" PRId64 ",\"N\":%" PRId64 ",\"nodes\":%d,\"iters\":%d,\"done\":%d,\"xmax\":%d,\"ywidth\":%d,"
        "\"exact\":%s,\"verified\":%s,\"lie_rejected\":%s,\"pads_distinct\":%s,"
        "\"footprint_kb\":%zu,\"prepare_us\":%.0f,\"peak_abs_y\":%" PRId64 ",\"y_digest\":\"%016" PRIx64 "\","
        "\"median_us\":{\"pad\":%.1f,\"mask\":%.1f,\"worker\":%.1f,\"finish\":%.1f},"
        "\"pads_issued\":%" PRIu64 ",\"verify_fail\":%" PRIu64 ",\"PASS\":%s}",
        W.bridge ? "avf-pvm-gpu" : "avf-pvm-local", K, N, n_nodes, iters, done, xmax, ywidth,
        exact?"true":"false", verified?"true":"false", lie_rejected?"true":"false", pads_distinct?"true":"false",
        footprint / 1024, prepare_us, peak, digest,
        done?median(tp,done):0, done?median(tm,done):0, done?median(tw,done):0, done?median(tf,done):0,
        pads, vf, pass?"true":"false");
    an_destroy(a);
    for (int i = 0; i < n_nodes; i++) free(w[i]);
    free(x); free(planes); free(planes2); free(tp); free(tm); free(tw); free(tf); free(W.xm); free(W.reply);
}

int AVmPayload_main(void) {
    /* Writes to a control or pads connection whose peer is gone, and the receiver's own write after a quiesce shutdown, must fail
     * with EPIPE rather than kill the payload (the default SIGPIPE action would end the VM mid-run). */
    signal(SIGPIPE, SIG_IGN);
    setvbuf(stdout, NULL, _IONBF, 0);
    int ls_ctl = vs_bind(CTRL_PORT), ls_wk = vs_bind(WORKER_PORT), ls_model = vs_bind(MODEL_PORT), ls_pads = vs_bind(PADS_PORT);
    g_ls_model = ls_model;
    crypto_sign_keypair(g_tpk, g_tsk);
    crypto_box_keypair(g_ppk, g_psk);                 /* the pad key: the platform's seed is boxed to it */
#ifdef ANCHOR_TIER_PVM_CPU
    {   /* the INSTANCE key (INSTANCE-BINDING.md): seeded from the VM instance's secret, the same for this instance every boot */
        static const char ident[] = "enclave-pvm-instance-key-v1"; uint8_t seed[32];
        AVmPayload_getVmInstanceSecret(ident, sizeof ident - 1, seed, sizeof seed);
        crypto_sign_ed25519_tweet_seed_keypair(g_ipk, g_isk, seed); memset(seed, 0, sizeof seed); g_inst = 1;
    }
#endif
    AVmPayload_notifyPayloadReady();
    g_ctl = vs_accept(ls_ctl, 20000);
    {   /* the first thing the owner hears is the transport key it will present to the relay */
        uint8_t spki[44]; memcpy(spki, ED25519_SPKI_PREFIX, 12); memcpy(spki + 12, g_tpk, 32);
        char hx[89]; for (int i = 0; i < 44; i++) sprintf(hx + 2 * i, "%02x", spki[i]); hx[88] = 0;
        OUT("SPKI %s", hx);
        char pk[65]; sh_pads_bin2hex(g_ppk, 32, pk);
        OUT("PADKEY %s", pk);
    }
    {   /* the measured pins: mode, ledger key, model digest, prefix key (anchor_pins.h) */
        if (anchor_pins_load("/mnt/apk/assets", &g_pins)) {
            if (g_pins.has_ledger) { memcpy(g_ledger_pk, g_pins.ledger_pk, 32); g_ledger_pinned = 1; g_have_ledger = 1; }
            if (g_pins.has_prefix) { sh_pads_bin2hex(g_pins.prefix_pk, 32, g_prefix_pk_hex); }
            OUT("PINS mode=%s ledger=%s model=%s prefix=%s sha256=%s tier=%s", g_pins.mode == ANCHOR_MODE_PROTECTED ? "protected" : "dev",
                g_pins.has_ledger ? "pinned" : "app", g_pins.has_model ? "pinned" : "unpinned", g_pins.has_prefix ? "pinned" : "app", anchor_sha256_backend(),
                ANCHOR_TIER_NAME);
        } else OUT("PINS INVALID: %s - pads, prefix and the engine are refused", g_pins.err);
        storage_probe();
    }
    OUT("ANCHOR start in pVM apk=%s control=%s", AVmPayload_getApkContentsPath(), g_ctl >= 0 ? "owner-connected" : "none");
#ifdef ANCHOR_TIER_PVM_CPU
    if (g_inst) {   /* public: the device campaign compares it across restarts and re-provisioning (INSTANCE-BINDING.md) */
        uint8_t sp[44], id[32]; char ih[65]; instance_spki(sp); sha256(sp, 44, id); sh_pads_bin2hex(id, 32, ih);
        OUT("INSTANCE id=%s (Ed25519, seeded from this VM instance's secret)", ih);
    }
#endif
    {
        FILE *f = fopen("/proc/cpuinfo", "r"); char line[1024]; char feats[1024] = "?";
        if (f) { while (fgets(line, sizeof line, f)) if (!strncmp(line, "Features", 8)) { strncpy(feats, line + 10, sizeof feats - 1); break; } fclose(f); }
        feats[strcspn(feats, "\n")] = 0;
        OUT("ANCHOR cpu nproc=%ld features=%s", sysconf(_SC_NPROCESSORS_ONLN), feats);
    }

    /* the owner's instructions; without an owner (a vm-tool run) the built-in local self-test */
    int bridge = 0, n_shapes = 0; int64_t SK[MAX_SHAPES], SN[MAX_SHAPES]; int Snode[MAX_SHAPES], Siter[MAX_SHAPES], Sx[MAX_SHAPES];
    int engine = 0, eng_n = 8, eng_threads = 4; uint64_t eng_model = 0; static char eng_prompt[2048] = "The capital of France is";
    int echo = 0, with_pads = 0, with_prefix = 0;
    int bridgebench = 0; static char bench_sizes[128] = "";
    int maskbench = 0, maskbench_bad = 0;                     /* MASKBENCH: the sampler + cell-import speed probe; no model, seed, worker or shapes */
    int local = 0, local_bad = 0; anchor_local_plan local_plan; memset(&local_plan, 0, sizeof local_plan);   /* LOCAL: the whole model in this VM (run_local) */
    int prepare = 0, prep_seconds = 300, prep_bad = 0;        /* PREPARE [seconds]: artifacts preparation, no engine (run_prepare); malformed or repeated = refused at RUN */
    int tier_bad = 0; (void)tier_bad;                         /* ANCHOR_TIER_PVM_CPU: a split-engine line arrived (refused at RUN) */
    int app = 0, app_bad = 0; (void)app; (void)app_bad;       /* ANCHOR_TIER_PVM_CPU: APP, the portable component (run_app) */
    static anchor_app_plan app_plan; memset(&app_plan, 0, sizeof app_plan);
    if (g_ctl >= 0) {
        char l[2400]; static char bound[2100] = "";
        while (read_line(g_ctl, l, sizeof l) >= 0) {
            if (!strncmp(l, "BOUND ", 6)) { strncpy(bound, l + 6, sizeof bound - 1); bound[sizeof bound - 1] = 0; }
            else if (!strncmp(l, "CHAL ", 5)) attest(l + 5, bound);
#ifdef ANCHOR_TIER_PVM_CPU
            /* pads, the pad ledger and the shared prefix serve the split engine only: refused as they arrive, and the run is
             * refused at RUN, so no line can make this build stage state the tier does not use */
            else if (!strncmp(l, "PAD", 3) || !strncmp(l, "PREFIXPK ", 9) || !strncmp(l, "WORKER ", 7) || !strncmp(l, "SHAPE ", 6)) {
                tier_bad = 1; OUT("TIER pvm-cpu refused: %.12s is split-engine machinery", l); }
            else if (!strncmp(l, "APP ", 4)) {   /* the portable component (anchor_app.h): strict, once; malformed or repeated refuses at RUN */
                if (app || !anchor_app_parse(l, &app_plan)) { app_bad = 1; OUT("APP refused: %s", app ? "repeated" : "malformed (APP bytes=N sha256=<64 hex>[ args=<hex>])"); }
                app = 1; }
            else if (!strncmp(l, "APPNONCE ", 9)) {   /* the relay's fresh nonce for this app's ABI/2 evidence: 64 lowercase hex, once */
                const char *h = l + 9; size_t n = 0; while (n < 64 && ((h[n] >= '0' && h[n] <= '9') || (h[n] >= 'a' && h[n] <= 'f'))) n++;
                if (g_app_nonce_set || n != 64 || h[64] != 0) { app_bad = 1; OUT("APP refused: APPNONCE %s", g_app_nonce_set ? "repeated" : "malformed (64 lowercase hex)"); }
                else { unhex(h, g_app_nonce, 32); g_app_nonce_set = 1; OUT("APPNONCE accepted: the app's ABI/2 evidence binds the relay's nonce"); } }
#endif
            else if (!strncmp(l, "PREFIXPK ", 9)) {    /* the platform's shared-prefix key (prefix-kv.h) */
                char h[65] = ""; uint8_t pk[32];
                if (g_pins.mode == ANCHOR_MODE_INVALID) OUT("PREFIXPK refused: pins invalid");
                else if (g_pins.has_prefix) { const int same = sscanf(l + 9, "%64s", h) == 1 && sh_pads_hex2bin(h, pk, 32) && !memcmp(pk, g_pins.prefix_pk, 32);
                                              OUT("PREFIXPK %s", same ? "ok (pinned)" : "REFUSED: not the key this build was measured with"); }
                else if (sscanf(l + 9, "%64s", h) == 1 && sh_pads_hex2bin(h, pk, 32)) { strncpy(g_prefix_pk_hex, h, 64); g_prefix_pk_hex[64] = 0; OUT("PREFIXPK ok (unpinned)"); }
                else { g_prefix_pk_hex[0] = 0; OUT("PREFIXPK fail"); }
            }
            else if (!strncmp(l, "PADLEDGER ", 10) && g_pins.mode == ANCHOR_MODE_INVALID) OUT("PADLEDGER refused: pins invalid");
            else if (!strncmp(l, "PADLEDGER ", 10)) {  /* the relay's ledger key: windows are verified against it */
                if (g_ledger_pinned) { uint8_t k[32]; const int same = sh_pads_hex2bin(l + 10, k, 32) && !memcmp(k, g_ledger_pk, 32);
                                       OUT("PADLEDGER %s", same ? "ok (pinned)" : "REFUSED: not the key this build was measured with"); }
                else { g_have_ledger = sh_pads_hex2bin(l + 10, g_ledger_pk, 32); OUT("PADLEDGER %s", g_have_ledger ? "ok (unpinned)" : "fail"); }
            }
            else if (!strncmp(l, "MODEL ", 6)) {       /* MODEL <bytes> [sha256]: receive (or reuse the cache when the owner's tag matches) and judge the bytes that will be parsed */
                unsigned long long mb = 0; char sha[80] = "";
                if (sscanf(l + 6, "%llu %79s", &mb, sha) >= 1 && strlen(sha) == 64) { strncpy(g_model_sha, sha, 64); g_model_sha[64] = 0; }   /* a cache tag, nothing more: the hash below decides */
                const int tok = anchor_auth_token(l);                                       /* MODEL <bytes> [sha256] [auth=catalog|whole-file] [cache=only]: strict, once, exact */
                const int ctok = anchor_cache_token(l);
                g_auth_catalog_requested = tok == ANCHOR_AUTH_TOKEN_CATALOG; g_model_cache_only = ctok == ANCHOR_CACHE_TOKEN_ONLY; g_model_cache_verdict = -1;
                if (tok == ANCHOR_AUTH_TOKEN_MALFORMED) OUT("MODEL fail auth token: exactly one of auth=catalog or auth=whole-file (an unknown mode never becomes the full scan)");
                else if (ctok == ANCHOR_CACHE_TOKEN_MALFORMED) OUT("MODEL fail cache token: only \"cache=only\" is accepted, once; store unchanged");
                else if (!mb) OUT("MODEL fail bytes"); else (void)model_stage(mb);
            }
            else if (!strncmp(l, "PADREQ2 ", 8)) {     /* PADREQ2 <name> -> PADREQ2 <name> <model_digest> <calib_digest> <nonce> <sig> | PADREQ2 fail <why> */
                char name[65] = ""; sscanf(l + 8, "%64s", name);
                if (!name[0]) OUT("PADREQ2 fail name");
                else if (g_pins.mode == ANCHOR_MODE_INVALID) OUT("PADREQ2 fail pins-invalid");
                else if (g_have_seed) OUT("PADREQ2 fail active-seed");          /* a grant may not reset a live bank into pad reuse */
                else if (!g_have_ledger) OUT("PADREQ2 fail no-ledger-key");
                else {
                    char why[160] = "";
                    /* the digest in the request is the STAGED model's (MODEL <bytes>: received, hashed, judged against
                     * the pin); a model that has not been staged cannot be requested for - first boot included */
                    if (g_model_state != 1) { strncpy(why, "model-not-staged", sizeof why - 1); OUT("PADREQ2 fail model-not-staged (send MODEL <bytes> first)"); }
                    else memcpy(g_req_model, g_model_digest, 32);
                    if (why[0]) { /* refused above */ }
                    else if (!calib_digest32(g_req_calib)) OUT("PADREQ2 fail calib-unreadable (the APK's model.calib could not be hashed whole)");
                    else {
                        randombytes(g_req_nonce, 32);
                        strncpy(g_req_name, name, 64); g_req_name[64] = 0;
                        char mh[65], ch[65], nh[65]; sh_pads_bin2hex(g_req_model, 32, mh); sh_pads_bin2hex(g_req_calib, 32, ch); sh_pads_bin2hex(g_req_nonce, 32, nh);
                        const char *fields[3] = { g_req_name, mh, ch };
                        uint8_t sig[64]; char hs[129];
                        if (sh_pads_request_sign(g_tsk, "seed-v2", fields, 3, nh, sig) != SH_OK) OUT("PADREQ2 fail sign");
                        else { sh_pads_bin2hex(sig, 64, hs); g_req_pending = 1; OUT("PADREQ2 %s %s %s %s %s", g_req_name, mh, ch, nh, hs); }
                    }
                }
            }
            else if (!strncmp(l, "PADGRANT ", 9)) {    /* PADGRANT <version> <seed_id> <epoch> <epk> <nonce> <box> <grant_sig> */
                unsigned ver = 0; char sid[33] = "", epk_h[65] = "", nonce_h[25] = "", box_h[97] = "", sig_h[129] = ""; unsigned long long epoch = 0;
                sh_pad_seed_grant g; memset(&g, 0, sizeof g);
                if (g_pins.mode == ANCHOR_MODE_INVALID) OUT("PADGRANT fail pins-invalid");
                else if (!g_req_pending) OUT("PADGRANT fail no-pending-request");
                else if (g_model_state != 1 || memcmp(g_model_digest, g_req_model, 32) != 0) { g_req_pending = 0; OUT("PADGRANT fail model-changed-since-request"); }   /* belt to the re-stage drop above */
                else if (sscanf(l + 9, "%u %32s %llu %64s %24s %96s %128s", &ver, sid, &epoch, epk_h, nonce_h, box_h, sig_h) != 7 || ver != 1 ||
                         strlen(sid) != 32 || strlen(epk_h) != 64 || strlen(nonce_h) != 24 || strlen(box_h) != 96 || strlen(sig_h) != 128 ||
                         !sh_pads_hex2bin(sid, g.seed_id, 16) || !sh_pads_hex2bin(epk_h, g.epk, 32) || !sh_pads_hex2bin(nonce_h, g.nonce, 12) ||
                         !sh_pads_hex2bin(box_h, g.box, 48) || !sh_pads_hex2bin(sig_h, g.sig, 64)) OUT("PADGRANT fail malformed");
                else {
                    g.epoch = epoch;
                    sh_pad_grant_context c; memset(&c, 0, sizeof c);
                    strncpy(c.name, g_req_name, 64); memcpy(c.transport_pk, g_tpk, 32); memcpy(c.pad_pk, g_ppk, 32);
                    memcpy(c.model_digest, g_req_model, 32); memcpy(c.calib_digest, g_req_calib, 32); memcpy(c.request_nonce, g_req_nonce, 32);
                    if (!sh_pad_grant_verify(g_ledger_pk, &c, &g)) OUT("PADGRANT fail signature (ledger key %s)", g_ledger_pinned ? "pinned" : "unpinned");
                    else if (sh_pads_seed_open(g.epk, g.nonce, g.box, 48, g_psk, g_ppk, g_seed) != 0) OUT("PADGRANT fail box");
                    else {
                        g_req_pending = 0;                                     /* one grant per request, ever */
                        memcpy(g_grant_model, g_req_model, 32);                 /* the model this seed is for: a later swap is refused */
                        memcpy(g_seed_id, g.seed_id, 16); strncpy(g_pad_name, g_req_name, sizeof g_pad_name - 1); strncpy(g_seed_id_hex, sid, 32); g_have_seed = 1;
                        ack_identity_set(g_seed_id, sid, g_req_name, g_req_calib);   /* acknowledgments are signed for THIS grant's calibration */
                        if (!g_pads_dir[0]) pads_dir(g_pads_dir, sizeof g_pads_dir);
                        int dropped = pads_prune(sid, 0);
                        OUT("PADGRANT ok %s (%s ledger key)", sid, g_ledger_pinned ? "pinned" : "UNPINNED");
                        { struct statvfs sv; if (statvfs(g_pads_dir, &sv) == 0) OUT("PADS store: %llu MiB free of %llu", (unsigned long long)sv.f_bavail * sv.f_frsize >> 20, (unsigned long long)sv.f_blocks * sv.f_frsize >> 20); }
                        if (dropped) OUT("PADS dropped %d shipment(s) of other seeds", dropped);
                    }
                }
            }
            else if (!strncmp(l, "PADSEED ", 8) && (g_ledger_pinned || g_pins.mode != ANCHOR_MODE_DEV)) OUT("PADSEED refused: only an unpinned dev build takes the legacy unsigned seed");
            else if (!strncmp(l, "PADSEED ", 8)) {     /* PADSEED <name> <seed_id> <epoch> <epk> <nonce> <box> (dev builds only) */
                char name[64] = "", sid[33] = "", epk_h[65] = "", nonce_h[25] = "", box_h[97] = ""; unsigned epoch = 0;
                uint8_t epk[32], nonce[12], box[48];
                if (sscanf(l + 8, "%63s %32s %u %64s %24s %96s", name, sid, &epoch, epk_h, nonce_h, box_h) == 6 &&
                    sh_pads_hex2bin(sid, g_seed_id, 16) && sh_pads_hex2bin(epk_h, epk, 32) && sh_pads_hex2bin(nonce_h, nonce, 12) && sh_pads_hex2bin(box_h, box, 48) &&
                    sh_pads_seed_open(epk, nonce, box, 48, g_psk, g_ppk, g_seed) == 0) {
                    strncpy(g_pad_name, name, sizeof g_pad_name - 1); strncpy(g_seed_id_hex, sid, 32); g_have_seed = 1;
                    { uint8_t cd[32]; if (calib_digest32(cd)) ack_identity_set(g_seed_id, sid, name, cd); else OUT("PADS acknowledgments withheld: model.calib could not be hashed whole"); }
                    if (!g_pads_dir[0]) pads_dir(g_pads_dir, sizeof g_pads_dir);
                    int dropped = pads_prune(sid, 0);
                    OUT("PADSEED ok %s", sid);
                    { struct statvfs sv; if (statvfs(g_pads_dir, &sv) == 0) OUT("PADS store: %llu MiB free of %llu", (unsigned long long)sv.f_bavail * sv.f_frsize >> 20, (unsigned long long)sv.f_blocks * sv.f_frsize >> 20); }
                    if (dropped) OUT("PADS dropped %d shipment(s) of other seeds", dropped);
                } else { g_have_seed = 0; OUT("PADSEED fail"); }
            }
            else if (!strncmp(l, "PADSIGN ", 8)) {     /* PADSIGN <kind> <nonce> [fields...] -> PADSIG <hex> */
                char *save = NULL, *kind = strtok_r(l + 8, " ", &save), *nonce = kind ? strtok_r(NULL, " ", &save) : NULL;
                const char *fields[8]; size_t nf = 0; char *f;
                while (nonce && nf < 8 && (f = strtok_r(NULL, " ", &save))) fields[nf++] = f;
                /* The transport key signs platform requests the pVM itself composes (PADREQ2, PADWIN, RECEIPT).
                 * The only app-composed request left is the legacy unsigned-seed request of a dev build:
                 * kind "seed" with this tunnel's name as its single field. Anything else - other kinds,
                 * extra fields, fabricated receipts - is refused. */
                const int legacy_seed = kind && nonce && !strcmp(kind, "seed") && nf == 1 && !g_ledger_pinned;
                if (legacy_seed) { uint8_t sig[64]; char hs[129]; if (sh_pads_request_sign(g_tsk, kind, fields, nf, nonce, sig) != SH_OK) OUT("PADSIG fail"); else { sh_pads_bin2hex(sig, 64, hs); OUT("PADSIG %s", hs); } }
                else OUT("PADSIG refused: only the legacy seed request may be signed for the app, and only in an unpinned build");
            }
            else if (!strncmp(l, "WORKER ", 7)) bridge = !strcmp(l + 7, "bridge");
            else if (!strncmp(l, "LOCAL", 5)) {           /* LOCAL model_bytes=N threads=N ctx=N: strict, once (anchor_local.h); malformed or repeated refuses the run at RUN */
                if (local || !anchor_local_parse(l, &local_plan)) { local_bad = 1; OUT("LOCAL refused: %s", local ? "repeated" : "malformed (LOCAL model_bytes=N threads=1..16 ctx=512..32768)"); }
                local = 1; }
            else if (!strncmp(l, "ENGINE ", 7)) {          /* ENGINE model_bytes=N n=N threads=N prompt=<hex> */
                engine = 1; char *q;
                if ((q = strstr(l, "model_bytes="))) eng_model = strtoull(q + 12, NULL, 10);
                if ((q = strstr(l, "model_sha256="))) { strncpy(g_model_sha, q + 13, 64); g_model_sha[64] = 0; }
                if ((q = strstr(l, " n="))) eng_n = atoi(q + 3);
                if ((q = strstr(l, "threads="))) eng_threads = atoi(q + 8);
                if ((q = strstr(l, " mtp="))) { char kb[8]; snprintf(kb, sizeof kb, "%d", atoi(q + 5)); setenv("ANCHOR_MTP_K", kb, 1); }   /* engine.cpp: MTP-head draft depth */
                if ((q = strstr(l, " boost="))) { char kb[8]; snprintf(kb, sizeof kb, "%d", atoi(q + 7)); setenv("ANCHOR_BOOST_THREADS", kb, 1); }   /* engine.cpp: clock-keeping spinners */
                if ((q = strstr(l, " env="))) {                /* extra engine environment: hex of "K=V,K=V" */
                    char ev[1024]; size_t k = unhex(q + 5, (uint8_t *)ev, sizeof ev - 1); ev[k] = 0;
                    /* performance knobs only: the app must not reach the keys that decide what is trusted
                     * (calibration, pad checks, model digest, prefix key, zero pads, the link itself) */
                    static const char *const env_ok[] = { "SHIELDED_LOCAL_SITES", "SHIELDED_MAX_M", "SHIELDED_OVERLAP_VERIFY", "SHIELDED_FUSE_LOCAL",
                        "ANCHOR_MTP_K", "ANCHOR_MTP_PMIN", "ANCHOR_DRAFT_AHEAD", "ANCHOR_HEAD_THREADS", "ANCHOR_HEAD_OWN_POOL", "ANCHOR_FINE_PLACEMENT", "ANCHOR_PREFILL_THREADS", "ANCHOR_BOOST_THREADS", "ANCHOR_LINK_ECHO",
                        "ANCHOR_PAD_RX_PROFILE", "ANCHOR_CPU_IDLE_PARK", "ANCHOR_BENCH_IDLE_PARK", "ANCHOR_BENCH_RCVLOWAT", "SHIELDED_RCVLOWAT", "ANCHOR_BENCH_RCVBUF", "SHIELDED_RCVBUF", "SHIELDED_SOURCE_PROFILE", "SHIELDED_WIRE_PROFILE", "SHIELDED_RECV_PROFILE", "SHIELDED_WIRE_SCHED", "SHIELDED_PROFILE", "SHIELDED_SPIN_US", "SHIELDED_REFILL_THREADS", "SHIELDED_VERBOSE", "ENGINE_LOG_INFO", "ENGINE_EXPORT_STDERR", "ENGINE_EXPORT_STDERR_MAX", "ANCHOR_WEIGHT_CACHE", "ANCHOR_STREAM_WEIGHTS", "ANCHOR_ENCODED_ARTIFACTS", "ANCHOR_ARTIFACT_WAIT_S", "ANCHOR_ARTIFACT_PROFILE", "SHIELDED_PAD_PREPARE_TILED", "SHIELDED_PAD_PREPARE_THREADS", "SHIELDED_PAD_PREPARE_PROFILE", "SHIELDED_PAD_BUDGET", "ANCHOR_QUIET_PADS", "SHIELDED_WEIGHT_CACHE_SHA256", "SHIELDED_UPLOAD_PREFETCH", "SHIELDED_PUBLIC_WEIGHT_CACHE", "SHIELDED_PUBLIC_WEIGHT_CACHE_ONLY", "SHIELDED_SOURCE_PREFETCH", "SHIELDED_PAD_CHECK_TILED", "SHIELDED_ARM_TUNED", "SHIELDED_PAD_ACK_STREAM", "SHIELDED_PAD_R4", "ANCHOR_CPU_POLL", "ANCHOR_SOURCE_READ_THREADS", "ANCHOR_STREAM_MIN_BYTES", "ANCHOR_BENCH_TRIALS", NULL };
                    for (char *tok = strtok(ev, ","); tok; tok = strtok(NULL, ",")) {
                        char *eq = strchr(tok, '='); if (!eq) continue; *eq = 0;
                        int ok = 0; for (int i = 0; env_ok[i]; i++) if (!strcmp(tok, env_ok[i])) ok = 1;
                        if (ok) setenv(tok, eq + 1, 1); else OUT("ENGINE env: refused %s (not a performance knob)", tok);
                    }
                }
                if ((q = strstr(l, "prompt="))) { size_t k = unhex(q + 7, (uint8_t *)eng_prompt, sizeof eng_prompt - 1); eng_prompt[k] = 0; }
                with_pads = strstr(l, " pads=1") != NULL;
                with_prefix = strstr(l, " prefix=1") != NULL;
                { const int tok = anchor_auth_token(l);                                    /* strict; must agree with the MODEL line that staged it, or the stage is refused */
                  if (tok == ANCHOR_AUTH_TOKEN_MALFORMED) { engine = 0; OUT("ENGINE refused: auth token: exactly one of auth=catalog or auth=whole-file"); }
                  g_auth_catalog_requested = tok == ANCHOR_AUTH_TOKEN_CATALOG; }
            }
            else if (!strncmp(l, "SHAPE ", 6) && n_shapes < MAX_SHAPES) {
                long long k, n; int nd, it, xm;
                if (sscanf(l + 6, "%lld %lld %d %d %d", &k, &n, &nd, &it, &xm) == 5) { SK[n_shapes] = k; SN[n_shapes] = n; Snode[n_shapes] = nd; Siter[n_shapes] = it; Sx[n_shapes] = xm; n_shapes++; }
            }
            else if (!strcmp(l, "MASKBENCH")) { if (maskbench) { maskbench_bad = 1; OUT("MASKBENCH refused: repeated"); } maskbench = 1; }   /* exact line, once */
            else if (!strcmp(l, "ECHO")) echo = 1;
            else if (!strncmp(l, "BRIDGEBENCH ", 12)) { bridgebench = 1; snprintf(bench_sizes, sizeof bench_sizes, "%s", l + 12); }
            else if (!strncmp(l, "ARTIFACT_PROFILE", 16)) {   /* ARTIFACT_PROFILE 0|1: strict, once; malformed or repeated refuses the run at RUN */
                int on = 0; if (g_artifact_profile >= 0 || !anchor_artifact_profile_parse(l, &on)) { g_artifact_profile_bad = 1; OUT("ARTIFACT_PROFILE refused: %s", g_artifact_profile >= 0 ? "repeated" : "malformed (ARTIFACT_PROFILE 0|1)"); }
                else { g_artifact_profile = on; OUT("ARTIFACT_PROFILE %s", on ? "on: one ARTIFACT PROFILE line per completed reception" : "off"); } }
            else if (!strncmp(l, "PADWINDOW", 9)) {   /* pad listener credit window; the WHOLE line must be one of exactly two, once, before any pads-port connection */
                const int zero = !strcmp(l, "PADWINDOW 0"), eight_k = !strcmp(l, "PADWINDOW 8192");
                if (g_pad_window_seen) { g_pad_window_bad = 1; OUT("PADWINDOW refused: repeated"); }
                else if (!zero && !eight_k) { g_pad_window_seen = 1; g_pad_window_bad = 1; OUT("PADWINDOW refused: malformed (the line must be exactly \"PADWINDOW 0\" or \"PADWINDOW 8192\")"); }
                else {
                    g_pad_window_seen = 1;
                    if (zero) OUT("PADWINDOW ok listener=0");                        /* default: nothing applied */
                    else if (ls_pads < 0) { g_pad_window_bad = 1; OUT("PADWINDOW refused: no pads listener"); }
                    else {
                        /* The kernel creates and initialises an accepted child - inheriting buffer_size - when the
                         * REQUEST arrives, not when this payload calls accept(2), so a connection already sitting in
                         * the listener's queue holds a DEFAULT-window child. A non-blocking poll refuses that case.
                         * It is not a proof of absence: a REQUEST landing between this poll and the setsockopt below
                         * still yields a default-window child, and nothing here can stop another client of this port.
                         * What makes the order sound is the owner's protocol - this line is sent and ACKNOWLEDGED
                         * before ANY pads-port sender starts - and the per-child readback in the receiver, which
                         * refuses (and stops on) any child that did not inherit the window. */
                        struct pollfd qp = { .fd = ls_pads, .events = POLLIN, .revents = 0 };
                        uint64_t want = 8192, got = 0; socklen_t gl = sizeof got;
                        int lw = -1; socklen_t ll = sizeof lw;
                        if (poll(&qp, 1, 0) != 0) { g_pad_window_bad = 1; OUT("PADWINDOW refused: pads listener queue probe was not clear (events=%u)", (unsigned)qp.revents); }
                        else if (setsockopt(ls_pads, AF_VSOCK, SO_VM_SOCKETS_BUFFER_SIZE, &want, sizeof want) != 0) { g_pad_window_bad = 1; OUT("PADWINDOW refused: setsockopt: %s", strerror(errno)); }
                        else if (getsockopt(ls_pads, AF_VSOCK, SO_VM_SOCKETS_BUFFER_SIZE, &got, &gl) != 0 || gl != sizeof got || got != want) { g_pad_window_bad = 1; OUT("PADWINDOW refused: listener readback len=%u value=%llu", (unsigned)gl, (unsigned long long)got); }
                        else if (getsockopt(ls_pads, SOL_SOCKET, SO_RCVLOWAT, &lw, &ll) != 0 || ll != sizeof lw || lw != 1) { g_pad_window_bad = 1; OUT("PADWINDOW refused: listener lowat len=%u value=%d (nothing but 1 may be inherited alongside an 8192 window)", (unsigned)ll, lw); }
                        else { g_pad_window = 8192; OUT("PADWINDOW ok listener=8192"); }
                    }
                }
            }
            else if (!strncmp(l, "PREPARE", 7)) { int sec = 0; if (prepare || !anchor_prepare_parse(l, &sec)) { prep_bad = 1; OUT("PREPARE refused: %s", prepare ? "repeated" : "malformed (PREPARE [1..600])"); } prepare = 1; prep_seconds = sec ? sec : prep_seconds; }
            else if (!strcmp(l, "RUN")) break;
        }
    }
#ifdef ANCHOR_TIER_PVM_CPU
    /* The pVM CPU build (PVM-CPU.md) runs ONE thing: the whole model on this VM's own vCPUs (mode local). Every other mode,
     * the TPU tail, the link benchmark and the worker bridge are refused here, before any of them is judged; nothing is
     * resolved by precedence. The build ships none of their libraries either, so this is the readable form of a refusal the
     * loader would also make. */
    {   const char *why = tier_bad ? "a split-engine control line was sent"
                        : app_bad ? "the APP line was malformed or repeated"
                        : (app && local && !app_plan.graph[0]) ? "APP with LOCAL needs the APP line's graph= (the name the app loads the model by)"
                        : (app && !local && app_plan.graph[0]) ? "the APP line names a graph but no LOCAL line brings the model"
                        : (app && local && local_plan.draft_bytes) ? "APP over the model takes no drafter"
                        : (!local && !app) ? "only a LOCAL or an APP run is served by this build"
                        : (maskbench || echo || prepare || engine || bridgebench || n_shapes || bridge) ? "a conflicting mode command was sent"
                        : (local && local_plan.tpu_bundle_bytes) ? "the LOCAL line carries the TPU tail"
                        : (local && local_plan.links) ? "the LOCAL line asks for benchmark links" : NULL;
        if (why) {
            OUT("TIER pvm-cpu refused: %s", why); OUT("END");
            if (ls_model >= 0) close(ls_model); if (ls_wk >= 0) close(ls_wk); if (ls_pads >= 0) close(ls_pads); if (ls_ctl >= 0) close(ls_ctl);
            ctl_close(); sleep(1); return 4;
        }
    }
    if (app) {
        const int arc = local ? run_app_nn(&local_plan, &app_plan) : run_app(&app_plan);
        OUT("END");
        if (ls_model >= 0) close(ls_model); if (ls_wk >= 0) close(ls_wk); if (ls_pads >= 0) close(ls_pads); if (ls_ctl >= 0) close(ls_ctl);
        ctl_close(); sleep(1); return arc;
    }
#endif
    if (maskbench) {   /* speed probe of the existing pad sampler and the 3-byte cell import; judged BEFORE every other mode so nothing else can win the dispatch */
        int mrc = 4;                                              /* failure unless both halves pass: the exit must agree with the status line (as BRIDGEBENCH) */
        if (maskbench_bad) OUT("MASKBENCH refused: repeated MASKBENCH line");
        else if (engine || echo || prepare || bridgebench || n_shapes) OUT("MASKBENCH refused: conflicting mode commands on the same run (ENGINE/ECHO/PREPARE/BRIDGEBENCH/SHAPE)");
        else {
            OUT("MASKBENCH begin: existing sh_pad_r sampler on public inputs, then warm-file cell import; no model, no seed, no worker, no inference");
            const int checks4 = astra_chacha4_check();
            OUT("PRG4_CHECK status=%s comparisons=%d", checks4 == 608 ? "PASS" : "FAIL", checks4);
            const int g = astra_output_mask_speed(sh_pad_r, maskbench_clock_us, maskbench_line);
            const int g4 = checks4 == 608 ? astra_output_mask_speed(astra_pad_r4, maskbench_clock_us, maskbench_line4) : 2;
            const int ga = astra_output_mask_speed(sh_pad_r, maskbench_clock_us, maskbench_line_again);
            const char *es = AVmPayload_getEncryptedStoragePath(), *apk = AVmPayload_getApkContentsPath();
            char asset[600]; snprintf(asset, sizeof asset, "%s/assets/maskbench.pads", apk ? apk : "");   /* the host-minted public shipment (build: ANCHOR_MASKBENCH_PADS) */
            const int i = es && apk ? anchor_maskbench_import(es, asset, maskbench_clock_us, maskbench_line) : 2;
            if (!es || !apk) OUT("CELL_IMPORT FAIL no encrypted store or APK path");
            if (g == 0 && i == 0 && g4 == 0 && ga == 0) mrc = 0;
            OUT("MASKBENCH status=%s generation_rc=%d import_rc=%d fourblock_rc=%d repeat_rc=%d", mrc == 0 ? "PASS" : "FAIL", g, i, g4, ga);
        }
        OUT("END");
        if (ls_model >= 0) close(ls_model); if (ls_wk >= 0) close(ls_wk); if (ls_pads >= 0) close(ls_pads); if (ls_ctl >= 0) close(ls_ctl);
        ctl_close();
        sleep(1); return mrc;
    }
    if (echo) {   /* the vsock round trip itself, app <-> guest, nothing else in the loop */
        int ls = vs_bind(ECHO_PORT); int c = vs_accept(ls, 20000);
        OUT("ECHO %s", c >= 0 ? "connected" : "no peer");
        if (c >= 0) { static uint8_t b[65536]; ssize_t r; while ((r = read(c, b, sizeof b)) > 0) { if (write(c, b, (size_t)r) != r) break; } close(c); }
        if (ls >= 0) close(ls);
        OUT("END");
        ctl_close();
        sleep(1); return 0;
    }
    if (prepare) {   /* artifacts preparation: no engine/seed/worker; bounded; reports presence, never a decode result */
        if (g_pins.mode == ANCHOR_MODE_INVALID) OUT("PREPARE refused: pins invalid (%s)", g_pins.err);
        else if (prep_bad) OUT("PREPARE refused: malformed or repeated PREPARE line");
        else if (g_artifact_profile_bad) OUT("PREPARE refused: malformed or repeated ARTIFACT_PROFILE line");
        else if (g_pad_window_bad) OUT("PREPARE refused: PADWINDOW was refused; the pad receive window is not what was asked for");
        else if (engine || echo || bridgebench || n_shapes) OUT("PREPARE refused: conflicting mode commands on the same run (ENGINE/ECHO/BRIDGEBENCH/SHAPE)");
        else run_prepare(ls_pads, prep_seconds);
        OUT("END");
        if (ls_model >= 0) close(ls_model); if (ls_wk >= 0) close(ls_wk); if (ls_ctl >= 0) close(ls_ctl);
        ctl_close();
        sleep(1); return 0;
    }
    if (local) {   /* phone-only: no worker, no pads, no seed; conflicts are refused, never resolved by precedence */
        if (g_pins.mode == ANCHOR_MODE_INVALID) OUT("LOCAL refused: pins invalid (%s)", g_pins.err);
        else if (local_bad) OUT("LOCAL refused: malformed or repeated LOCAL line");
        else if (engine || echo || bridgebench || n_shapes || bridge) OUT("LOCAL refused: conflicting mode commands on the same run (ENGINE/ECHO/BRIDGEBENCH/SHAPE/WORKER bridge)");
        else { OUT("ANCHOR local mode: the whole model runs in this VM"); run_local(&local_plan, ls_wk); g_model_fd = -1; g_model_state = 0; anchor_gguf_free(&g_model_table); }
        OUT("END");
        if (ls_model >= 0) close(ls_model); if (ls_wk >= 0) close(ls_wk); if (ls_pads >= 0) close(ls_pads); if (ls_ctl >= 0) close(ls_ctl);
        ctl_close();
        sleep(1); return 0;
    }
    if (engine) {
        OUT("ANCHOR engine mode: model %" PRIu64 " bytes, %d tokens, %d threads", eng_model, eng_n, eng_threads);
        if (g_pins.mode == ANCHOR_MODE_INVALID) OUT("ENGINE refused: pins invalid (%s)", g_pins.err);
        else if (g_artifact_profile_bad) OUT("ENGINE refused: malformed or repeated ARTIFACT_PROFILE line");
        else if (g_pad_window_bad) OUT("ENGINE refused: PADWINDOW was refused; the pad receive window is not what was asked for");
        else { run_engine(ls_wk, ls_model, ls_pads, eng_prompt, eng_n, eng_threads, eng_model, with_pads, with_prefix); g_model_fd = -1; g_model_state = 0; anchor_gguf_free(&g_model_table); }
        OUT("END");
        if (ls_model >= 0) close(ls_model); if (ls_wk >= 0) close(ls_wk); if (ls_ctl >= 0) close(ls_ctl);
        ctl_close();
        sleep(1); return 0;
    }
    if (bridgebench) {   /* the worker-bridge frame diagnostic: run on the bridged worker fd, then exit */
        int fd = vs_accept(ls_wk, 20000);
        OUT("BRIDGEBENCH %s sizes=%s", fd >= 0 ? "connected" : "no worker bridge", bench_sizes);
        int brc = run_bridgebench(fd, bench_sizes);
        if (fd >= 0) close(fd);
        OUT("END");
        if (ls_model >= 0) close(ls_model); if (ls_wk >= 0) close(ls_wk); if (ls_ctl >= 0) close(ls_ctl);
        ctl_close();
        sleep(1); return brc ? 4 : 0;   /* a failed bench run must not exit 0 */
    }
    if (n_shapes == 0) { SK[0]=256; SN[0]=256; Snode[0]=1; Siter[0]=30; Sx[0]=0; SK[1]=896; SN[1]=896; Snode[1]=1; Siter[1]=30; Sx[1]=0; SK[2]=896; SN[2]=4864; Snode[2]=2; Siter[2]=12; Sx[2]=0; n_shapes = 3; }
    OUT("ANCHOR worker=%s shapes=%d", bridge ? "bridge" : "local", n_shapes);
    bench_refill(896, 896); bench_refill(896, 4864);

    for (int s = 0; s < n_shapes; s++) {
        int fd = -1;
        if (bridge) { fd = vs_accept(ls_wk, 20000); if (fd < 0) { OUT("{\"K\":%" PRId64 ",\"error\":\"no worker bridge\"}", SK[s]); continue; } }
        run_shape(SK[s], SN[s], Snode[s], Siter[s], Sx[s], fd);
    }
    OUT("END");
    if (ls_model >= 0) close(ls_model);
    if (ls_wk >= 0) close(ls_wk);
    if (ls_ctl >= 0) close(ls_ctl);
    ctl_close();
    sleep(1);
    return 0;
}
