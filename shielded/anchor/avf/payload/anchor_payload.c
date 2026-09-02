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
#include <inttypes.h>
#include <math.h>
#include <poll.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/socket.h>
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
void randombytes(unsigned char *p, unsigned long long n) {
    while (n) { ssize_t r = getrandom(p, (size_t)n, 0); if (r <= 0) abort(); p += r; n -= (unsigned long long)r; }
}
static const uint8_t ED25519_SPKI_PREFIX[12] = { 0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00 };
#define WORKER_PORT 7778
#define MAX_SHAPES  16

/* ---- the mouth: every line to stdout (debug VMs), logcat, and the control vsock ---- */
static int g_ctl = -1;
static void outf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void outf(const char *fmt, ...) {
    char line[4096]; va_list ap; va_start(ap, fmt); int n = vsnprintf(line, sizeof line - 1, fmt, ap); va_end(ap);
    if (n < 0) return; if ((size_t)n > sizeof line - 2) n = sizeof line - 2;
    line[n] = '\n'; line[n + 1] = 0;
    fputs(line, stdout); fflush(stdout);
    __android_log_print(ANDROID_LOG_INFO, TAG, "%.*s", n, line);
    if (g_ctl >= 0) { const char *p = line; size_t left = (size_t)n + 1; while (left) { ssize_t w = write(g_ctl, p, left); if (w <= 0) { close(g_ctl); g_ctl = -1; break; } p += w; left -= (size_t)w; } }
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
static void attest(const char *hex, const char *bound_hex) {
    uint8_t ch[32] = {0}; unhex(hex, ch, 32);
    uint8_t bound[1024]; size_t blen = unhex(bound_hex, bound, sizeof bound);
    if (!blen) { memcpy(bound, ch, 32); blen = 32; }
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
        size_t ssz = AVmAttestationResult_sign(res, bound, blen, NULL, 0);
        uint8_t *sig = malloc(ssz);
        if (sig) { AVmAttestationResult_sign(res, bound, blen, sig, ssz); hexline("SIG", sig, ssz); free(sig); }
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
    int ls_ctl = vs_bind(CTRL_PORT), ls_wk = vs_bind(WORKER_PORT);
    crypto_sign_keypair(g_tpk, g_tsk);
    AVmPayload_notifyPayloadReady();
    g_ctl = vs_accept(ls_ctl, 20000);
    {   /* the first thing the owner hears is the transport key it will present to the relay */
        uint8_t spki[44]; memcpy(spki, ED25519_SPKI_PREFIX, 12); memcpy(spki + 12, g_tpk, 32);
        char hx[89]; for (int i = 0; i < 44; i++) sprintf(hx + 2 * i, "%02x", spki[i]); hx[88] = 0;
        OUT("SPKI %s", hx);
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
    if (g_ctl >= 0) {
        char l[2400]; static char bound[2100] = "";
        while (read_line(g_ctl, l, sizeof l) >= 0) {
            if (!strncmp(l, "BOUND ", 6)) { strncpy(bound, l + 6, sizeof bound - 1); bound[sizeof bound - 1] = 0; }
            else if (!strncmp(l, "CHAL ", 5)) attest(l + 5, bound);
            else if (!strncmp(l, "WORKER ", 7)) bridge = !strcmp(l + 7, "bridge");
            else if (!strncmp(l, "SHAPE ", 6) && n_shapes < MAX_SHAPES) {
                long long k, n; int nd, it, xm;
                if (sscanf(l + 6, "%lld %lld %d %d %d", &k, &n, &nd, &it, &xm) == 5) { SK[n_shapes] = k; SN[n_shapes] = n; Snode[n_shapes] = nd; Siter[n_shapes] = it; Sx[n_shapes] = xm; n_shapes++; }
            }
            else if (!strcmp(l, "RUN")) break;
        }
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
    if (ls_wk >= 0) close(ls_wk);
    if (ls_ctl >= 0) close(ls_ctl);
    if (g_ctl >= 0) { shutdown(g_ctl, SHUT_WR); close(g_ctl); }
    sleep(1);
    return 0;
}
