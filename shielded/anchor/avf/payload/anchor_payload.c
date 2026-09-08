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
#include "anchor_pins.h"
#include "anchor_names.h"
#include "anchor_gguf.h"
#include "anchor_copy.h"
#include <fcntl.h>
#include <inttypes.h>
#include <math.h>
#include <poll.h>
#include <stdarg.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/mman.h>
#include <sys/socket.h>
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
static uint8_t g_ppk[32];   /* the pad key, defined with its secret half below; attest() checks the app's BOUND against it */
void randombytes(unsigned char *p, unsigned long long n) {
    while (n) { ssize_t r = getrandom(p, (size_t)n, 0); if (r <= 0) abort(); p += r; n -= (unsigned long long)r; }
}
static const uint8_t ED25519_SPKI_PREFIX[12] = { 0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00 };
#define WORKER_PORT 7778
#define MODEL_PORT  7779
#define PADS_PORT   7780     /* owner -> guest: dealt-pad shipments into the bank dir (PADS <name> <bytes>\n, bytes) */
#define ECHO_PORT   7780
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
            if (sig) { AVmAttestationResult_sign(res, bound, blen, sig, ssz); hexline("SIG", sig, ssz); free(sig); }
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
static int model_file(uint64_t bytes, int *existing) {
    *existing = 0;
    const char *es = AVmPayload_getEncryptedStoragePath();
    if (es) {
        char path[512], side[512]; snprintf(path, sizeof path, "%s/model.gguf", es); sidecar_path(side, sizeof side, es);
        struct stat st; char have[80] = "";
        { FILE *f = fopen(side, "r"); if (f) { if (!fgets(have, sizeof have, f)) have[0] = 0; fclose(f); have[strcspn(have, "\n")] = 0; } }
        if (stat(path, &st) == 0 && (uint64_t)st.st_size == bytes && g_model_sha[0] && !strcmp(have, g_model_sha)) {
            int fd = open(path, O_RDONLY); if (fd >= 0) { *existing = 1; return fd; }
        }
        unlink(side);                                             /* whatever is there is not what the owner is offering */
        int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0600);
        if (fd >= 0 && ftruncate(fd, (off_t)bytes) == 0) return fd;
        OUT("ENGINE encrypted storage %s: %s", path, strerror(errno));
        if (fd >= 0) close(fd);
    }
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
static int receive_model(int ls_model, uint64_t bytes, int *out_fd) {
    int c = vs_accept(ls_model, 60000);
    if (c < 0) { OUT("ENGINE no model stream from the owner"); return -1; }
    uint64_t hdr = 0; if (read_exact(c, &hdr, 8) != 0 || hdr != bytes) { OUT("ENGINE model stream header %" PRIu64 " != %" PRIu64, hdr, bytes); close(c); return -1; }
    int existing = 0, fd = model_file(bytes, &existing);
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
        char side[512]; sidecar_path(side, sizeof side, AVmPayload_getEncryptedStoragePath());
        FILE *f = fopen(side, "w"); if (f) { fprintf(f, "%s\n", g_model_sha); fclose(f); }
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
static int pads_judge_fd(const char *name, int fd, char *ack, size_t ackcap) {
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
    if (anchor_sha256_fd(fd, sha, &bytes) != 0 || !bytes) { OUT("PADS %s REJECTED (cannot hash it for the acknowledgment: %s): removed", name, strerror(errno)); return -1; }
    char shah[65], i0s[24], cnts[24], nh[33], sh[129]; uint8_t nonce[16], sig[64];
    sh_pads_bin2hex(sha, 32, shah); snprintf(i0s, sizeof i0s, "%llu", (unsigned long long)i0); snprintf(cnts, sizeof cnts, "%llu", (unsigned long long)cnt);
    randombytes(nonce, 16); sh_pads_bin2hex(nonce, 16, nh);
    const char *fields[5] = { id.name, id.seed_id_hex, i0s, cnts, shah };     /* enclave-pads-ack\n<name>\n<seed_id>\n<index0>\n<count>\n<sha256>\n<nonce> */
    if (sh_pads_request_sign(g_tsk, "ack", fields, 5, nh, sig) != SH_OK) { OUT("PADS %s kept, acknowledgment not signed (a re-offer will retry)", name); return 0; }
    sh_pads_bin2hex(sig, 64, sh);
    snprintf(ack, ackcap, "PADACK %s %s %s %s %s %s", id.seed_id_hex, i0s, cnts, shah, nh, sh);
    return 1;
}
static void *pads_receiver(void *arg) {
    int ls = (int)(intptr_t)arg;
    for (;;) {
        int c = vs_accept(ls, 3600000);
        if (c < 0) continue;
        char hdr[256]; size_t n = 0;
        while (n + 1 < sizeof hdr) { char ch; if (read(c, &ch, 1) != 1) { n = 0; break; } if (ch == '\n') break; hdr[n++] = ch; }
        hdr[n] = 0;
        char name[128] = ""; unsigned long long bytes = 0;
        if (n == 0 || sscanf(hdr, "PADS %127s %llu", name, &bytes) != 2) { close(c); continue; }
        /* only two kinds of file may land here: a canonical shipment (judged against its header, acknowledged)
         * or one of the exact shared-prefix assets (stored as offered, verified at use, never acknowledged) */
        const anchor_name_class kind = anchor_name_classify(name, NULL, NULL, NULL);
        if (kind == ANCHOR_NAME_REFUSED) { OUT("PADS %s refused: neither a shipment nor a prefix asset", name); (void)!write(c, "E", 1); close(c); continue; }
        char tmp[700], fin[700]; snprintf(tmp, sizeof tmp, "%s/.%s.tmp", g_pads_dir, name); snprintf(fin, sizeof fin, "%s/%s", g_pads_dir, name);
        struct stat st;
        {   /* have it already? judged and hashed on a retained descriptor (the owner may be retrying a lost
             * acknowledgment; the engine may prune the NAME at any moment, the inode we hold stays) */
            int hfd; do { hfd = open(fin, O_RDONLY | O_CLOEXEC); } while (hfd < 0 && errno == EINTR);
            if (hfd >= 0) {
                if (fstat(hfd, &st) == 0 && (unsigned long long)st.st_size == bytes) {
                    char ack[512] = ""; const int j = kind == ANCHOR_NAME_SHIPMENT ? pads_judge_fd(name, hfd, ack, sizeof ack) : 0; close(hfd);
                    if (j < 0) { unlink(fin); (void)!write(c, "E", 1); }
                    else { (void)!write(c, "H", 1); if (ack[0]) OUT("%s", ack); }
                    close(c); continue;
                }
                close(hfd);                                       /* another size under that name: it is replaced below */
            }
        }
        (void)!write(c, "G", 1);
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
        while (fd >= 0 && got < bytes) {
            size_t want = bytes - got < sizeof buf ? (size_t)(bytes - got) : sizeof buf;
            ssize_t r = read(c, buf, want); if (r < 0 && (errno == EINTR || errno == EAGAIN)) continue;
            if (r <= 0) { last_r = r; read_errno = errno; break; }
            if (write_all(fd, buf, (size_t)r) != 0) { write_errno = errno; break; }
            got += (unsigned long long)r;
        }
        int synced = 0;
        if (fd >= 0) { int rc; do { rc = fsync(fd); } while (rc < 0 && errno == EINTR); synced = rc == 0; if (!synced && !write_errno) write_errno = errno; }
        char ack[512] = "";
        if (fd >= 0 && got == bytes && synced) {
            /* judged and hashed while still HIDDEN, through the descriptor we hold; then published; then the
             * directory made durable; only then is anyone told and the prepared acknowledgment emitted */
            const int j = kind == ANCHOR_NAME_SHIPMENT ? pads_judge_fd(name, fd, ack, sizeof ack) : 0;   /* a prefix asset is stored as offered */
            close(fd); fd = -1;
            if (j < 0) { unlink(tmp); (void)!write(c, "E", 1); }
            else if (rename(tmp, fin) != 0) { const int e = errno; unlink(tmp); (void)!write(c, "E", 1); OUT("PADS %s: publish failed: %s", name, strerror(e)); }
            else if (dir_sync(g_pads_dir) != 0) { const int e = errno; unlink(fin); (void)!write(c, "E", 1); OUT("PADS %s: directory fsync failed (%s): withdrawn, not acknowledged", name, strerror(e)); }
            else { (void)!write(c, "K", 1); OUT("PADS %s %llu bytes", name, got); if (ack[0]) OUT("%s", ack); }
        }
        else { if (fd >= 0) close(fd); unlink(tmp); (void)!write(c, "E", 1);
               OUT("PADS %s FAILED at %llu of %llu (sock fd %d, file fd %d, read %zd/%s, write %s)", name, got, bytes, c, fd,
                   last_r, last_r < 0 ? strerror(read_errno) : "eof", write_errno ? strerror(write_errno) : "ok"); }
        close(c);
    }
    return NULL;
}

typedef int (*engine_main_fn)(int, int, int, const char *, const char *, const char *, int, int, const anchor_pads *);
/* A rejected model must not survive as "cached": the sidecar carries the owner's tag, so a lying
 * first stream (right tag, wrong bytes) would otherwise be answered 'K' on every later honest run. */
static void model_cache_purge(void) {
    const char *es = AVmPayload_getEncryptedStoragePath();
    if (es) { char path[512], side[512]; snprintf(path, sizeof path, "%s/model.gguf", es); sidecar_path(side, sizeof side, es); unlink(side); unlink(path); }
    unlink("/data/anchor-model.gguf");
    OUT("MODEL cache purged: a rejected model is not kept");
}
static int model_stage(uint64_t bytes) {
    if (g_pins.mode == ANCHOR_MODE_INVALID) { OUT("MODEL fail pins-invalid"); return -1; }
    if (g_model_fd >= 0 && g_model_state == 1 && g_model_fd_bytes == bytes) {              /* staged already, unchanged: say so, the owner waits for a verdict */
        char dh[65]; sh_pads_bin2hex(g_model_digest, 32, dh); OUT("MODEL ok %s (staged already, unchanged)", dh); return 0;
    }
    if (g_model_fd >= 0) { close(g_model_fd); g_model_fd = -1; }
    g_model_state = 0; anchor_gguf_free(&g_model_table);                                  /* any (re)reception invalidates */
    if (g_req_pending) { g_req_pending = 0; OUT("PADREQ2 request dropped: the model is being re-staged, request again for the new bytes"); }   /* a grant for the old digest must not land on new bytes */
    int fd = -1;
    if (receive_model(g_ls_model, bytes, &fd) != 0) { OUT("MODEL fail receive"); return -1; }
    /* the bytes that will be parsed, judged by ONE read: GGUF header walked, whole-file digest (the pin's
     * form) and each tensor's digest from the same pass; then the pin and the grant's frozen digest */
    char why[256] = "";
    if (!anchor_gguf_stage(fd, &g_model_table, &g_hash_ops, g_model_digest, why, sizeof why)) { close(fd); OUT("MODEL fail not a usable GGUF: %s", why); model_cache_purge(); return -1; }
    if (g_pins.has_model && memcmp(g_model_digest, g_pins.model_sha256, 32) != 0) { anchor_gguf_free(&g_model_table); close(fd); OUT("MODEL fail model differs from the measured pin"); model_cache_purge(); return -1; }
    if (g_have_seed && memcmp(g_model_digest, g_grant_model, 32) != 0) { anchor_gguf_free(&g_model_table); close(fd); OUT("MODEL fail model differs from the one the seed was granted for"); model_cache_purge(); return -1; }
    g_model_fd = fd; g_model_fd_bytes = bytes; g_model_state = 1;
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
    { void (*sett)(const anchor_gguf_table *, const anchor_hash_ops *) = (void (*)(const anchor_gguf_table *, const anchor_hash_ops *))dlsym(h, "engine_set_model_table");
      if (!sett || g_model_state != 1 || !g_model_table.t) { OUT("ENGINE refused: %s", sett ? "no staged model table" : "engine has no engine_set_model_table"); close(worker_fd); close(model_fd); return; }
      sett(&g_model_table, &g_hash_ops); }
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
    if (with_pads || with_prefix) {
        /* shipments, and the prefix files, ride the same port into the store */
        pthread_t th; pthread_create(&th, NULL, pads_receiver, (void *)(intptr_t)ls_pads); pthread_detach(th);
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
    setvbuf(stdout, NULL, _IONBF, 0);
    int ls_ctl = vs_bind(CTRL_PORT), ls_wk = vs_bind(WORKER_PORT), ls_model = vs_bind(MODEL_PORT), ls_pads = vs_bind(PADS_PORT);
    g_ls_model = ls_model;
    crypto_sign_keypair(g_tpk, g_tsk);
    crypto_box_keypair(g_ppk, g_psk);                 /* the pad key: the platform's seed is boxed to it */
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
            OUT("PINS mode=%s ledger=%s model=%s prefix=%s sha256=%s", g_pins.mode == ANCHOR_MODE_PROTECTED ? "protected" : "dev",
                g_pins.has_ledger ? "pinned" : "app", g_pins.has_model ? "pinned" : "unpinned", g_pins.has_prefix ? "pinned" : "app", anchor_sha256_backend());
        } else OUT("PINS INVALID: %s - pads, prefix and the engine are refused", g_pins.err);
        storage_probe();
    }
    OUT("ANCHOR start in pVM apk=%s control=%s", AVmPayload_getApkContentsPath(), g_ctl >= 0 ? "owner-connected" : "none");
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
    if (g_ctl >= 0) {
        char l[2400]; static char bound[2100] = "";
        while (read_line(g_ctl, l, sizeof l) >= 0) {
            if (!strncmp(l, "BOUND ", 6)) { strncpy(bound, l + 6, sizeof bound - 1); bound[sizeof bound - 1] = 0; }
            else if (!strncmp(l, "CHAL ", 5)) attest(l + 5, bound);
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
                if (!mb) OUT("MODEL fail bytes"); else (void)model_stage(mb);
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
                        "ANCHOR_MTP_K", "ANCHOR_MTP_PMIN", "ANCHOR_DRAFT_AHEAD", "ANCHOR_HEAD_THREADS", "ANCHOR_FINE_PLACEMENT", "ANCHOR_PREFILL_THREADS", "ANCHOR_BOOST_THREADS", "ANCHOR_LINK_ECHO",
                        "SHIELDED_PROFILE", "SHIELDED_SPIN_US", "SHIELDED_REFILL_THREADS", "SHIELDED_VERBOSE", "ANCHOR_WEIGHT_CACHE", "ANCHOR_STREAM_WEIGHTS", "SHIELDED_PAD_PREPARE_TILED", "SHIELDED_WEIGHT_CACHE_SHA256", "SHIELDED_UPLOAD_PREFETCH", "SHIELDED_PUBLIC_WEIGHT_CACHE", NULL };
                    for (char *tok = strtok(ev, ","); tok; tok = strtok(NULL, ",")) {
                        char *eq = strchr(tok, '='); if (!eq) continue; *eq = 0;
                        int ok = 0; for (int i = 0; env_ok[i]; i++) if (!strcmp(tok, env_ok[i])) ok = 1;
                        if (ok) setenv(tok, eq + 1, 1); else OUT("ENGINE env: refused %s (not a performance knob)", tok);
                    }
                }
                if ((q = strstr(l, "prompt="))) { size_t k = unhex(q + 7, (uint8_t *)eng_prompt, sizeof eng_prompt - 1); eng_prompt[k] = 0; }
                with_pads = strstr(l, " pads=1") != NULL;
                with_prefix = strstr(l, " prefix=1") != NULL;
            }
            else if (!strncmp(l, "SHAPE ", 6) && n_shapes < MAX_SHAPES) {
                long long k, n; int nd, it, xm;
                if (sscanf(l + 6, "%lld %lld %d %d %d", &k, &n, &nd, &it, &xm) == 5) { SK[n_shapes] = k; SN[n_shapes] = n; Snode[n_shapes] = nd; Siter[n_shapes] = it; Sx[n_shapes] = xm; n_shapes++; }
            }
            else if (!strcmp(l, "ECHO")) echo = 1;
            else if (!strcmp(l, "RUN")) break;
        }
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
    if (engine) {
        OUT("ANCHOR engine mode: model %" PRIu64 " bytes, %d tokens, %d threads", eng_model, eng_n, eng_threads);
        if (g_pins.mode == ANCHOR_MODE_INVALID) OUT("ENGINE refused: pins invalid (%s)", g_pins.err);
        else { run_engine(ls_wk, ls_model, ls_pads, eng_prompt, eng_n, eng_threads, eng_model, with_pads, with_prefix); g_model_fd = -1; g_model_state = 0; anchor_gguf_free(&g_model_table); }
        OUT("END");
        if (ls_model >= 0) close(ls_model); if (ls_wk >= 0) close(ls_wk); if (ls_ctl >= 0) close(ls_ctl);
        ctl_close();
        sleep(1); return 0;
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
