#include "anchor_pins.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#if defined(__aarch64__) && defined(__linux__)
#include <arm_neon.h>
#include <asm/hwcap.h>
#include <sys/auxv.h>
#define ANCHOR_SHA2_ARM 1
#endif

/* ---- SHA-256 ---------------------------------------------------------------------- */
static const uint32_t K256[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2 };
typedef void (*sha_blocks_fn)(uint32_t h[8], const uint8_t *data, size_t blocks);
typedef struct { uint32_t h[8]; uint8_t buf[64]; size_t used; uint64_t total; sha_blocks_fn blocks; } sha256_ctx;
static void sha_block(uint32_t h[8], const uint8_t blk[64]) {
    uint32_t w[64];
    for (int t = 0; t < 16; t++) w[t] = ((uint32_t)blk[4*t] << 24) | ((uint32_t)blk[4*t+1] << 16) | ((uint32_t)blk[4*t+2] << 8) | blk[4*t+3];
    for (int t = 16; t < 64; t++) { uint32_t a = w[t-15], b = w[t-2]; uint32_t s0 = ((a>>7)|(a<<25)) ^ ((a>>18)|(a<<14)) ^ (a>>3), s1 = ((b>>17)|(b<<15)) ^ ((b>>19)|(b<<13)) ^ (b>>10); w[t] = w[t-16] + s0 + w[t-7] + s1; }
    uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
    for (int t = 0; t < 64; t++) { uint32_t S1 = ((e>>6)|(e<<26)) ^ ((e>>11)|(e<<21)) ^ ((e>>25)|(e<<7)), ch = (e&f) ^ (~e&g), t1 = hh + S1 + ch + K256[t] + w[t];
        uint32_t S0 = ((a>>2)|(a<<30)) ^ ((a>>13)|(a<<19)) ^ ((a>>22)|(a<<10)), mj = (a&b) ^ (a&c) ^ (b&c), t2 = S0 + mj; hh=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2; }
    h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e; h[5]+=f; h[6]+=g; h[7]+=hh;
}
static void sha_blocks_scalar(uint32_t h[8], const uint8_t *data, size_t blocks) {
    for (size_t i = 0; i < blocks; i++) sha_block(h, data + 64*i);
}
#ifdef ANCHOR_SHA2_ARM
/* SHA256H/H2 process four rounds; SU0/SU1 expand the next four schedule
 * words. Only this function requires SHA2; the fallback remains baseline
 * AArch64 and is selected when the guest kernel does not advertise SHA2. */
#if defined(__clang__)
__attribute__((target("sha2")))
#else
__attribute__((target("+crypto")))
#endif
static void sha_blocks_arm(uint32_t h[8], const uint8_t *data, size_t blocks) {
    uint32x4_t abcd = vld1q_u32(h), efgh = vld1q_u32(h + 4);
    for (size_t b = 0; b < blocks; b++, data += 64) {
        const uint32x4_t old_abcd = abcd, old_efgh = efgh;
        uint32x4_t w[4];
        for (int i = 0; i < 4; i++) w[i] = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(data + 16*i)));
#if defined(__clang__)
#pragma clang loop unroll(full)
#endif
        for (int r = 0; r < 16; r++) {
            const int i = r & 3;
            const uint32x4_t wk = vaddq_u32(w[i], vld1q_u32(K256 + 4*r));
            const uint32x4_t before = abcd;
            abcd = vsha256hq_u32(abcd, efgh, wk);
            efgh = vsha256h2q_u32(efgh, before, wk);
            if (r < 12) w[i] = vsha256su1q_u32(vsha256su0q_u32(w[i], w[(i+1)&3]), w[(i+2)&3], w[(i+3)&3]);
        }
        abcd = vaddq_u32(abcd, old_abcd); efgh = vaddq_u32(efgh, old_efgh);
    }
    vst1q_u32(h, abcd); vst1q_u32(h + 4, efgh);
}
#endif
static sha_blocks_fn sha_select(void) {
#ifdef ANCHOR_SHA2_ARM
    if (getauxval(AT_HWCAP) & HWCAP_SHA2) return sha_blocks_arm;
#endif
    return sha_blocks_scalar;
}
const char *anchor_sha256_backend(void) {
#ifdef ANCHOR_SHA2_ARM
    if (sha_select() == sha_blocks_arm) return "arm_sha2";
#endif
    return "scalar";
}
static void sha_init(sha256_ctx *c) {
    static const uint32_t iv[8] = { 0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19 };
    memcpy(c->h, iv, sizeof iv); c->used = 0; c->total = 0; c->blocks = sha_select();
}
static void sha_update(sha256_ctx *c, const uint8_t *m, size_t n) {
    if (!n) return;
    c->total += n;
    if (c->used) {
        const size_t take = 64 - c->used < n ? 64 - c->used : n;
        if (take) memcpy(c->buf + c->used, m, take);
        c->used += take; m += take; n -= take;
        if (c->used < 64) return;
        c->blocks(c->h, c->buf, 1); c->used = 0;
    }
    const size_t blocks = n / 64;
    if (blocks) { c->blocks(c->h, m, blocks); m += blocks*64; n -= blocks*64; }
    if (n) { memcpy(c->buf, m, n); c->used = n; }
}
static void sha_final(sha256_ctx *c, uint8_t out[32]) {
    const uint64_t bits = c->total * 8; uint8_t pad = 0x80, z = 0; sha_update(c, &pad, 1);
    while (c->used != 56) sha_update(c, &z, 1);
    uint8_t len[8]; for (int b = 0; b < 8; b++) len[b] = (uint8_t)(bits >> (8 * (7 - b))); sha_update(c, len, 8);
    for (int j = 0; j < 8; j++) { out[4*j] = (uint8_t)(c->h[j] >> 24); out[4*j+1] = (uint8_t)(c->h[j] >> 16); out[4*j+2] = (uint8_t)(c->h[j] >> 8); out[4*j+3] = (uint8_t)c->h[j]; }
}
void anchor_sha256(const uint8_t *m, size_t n, uint8_t out[32]) { sha256_ctx c; sha_init(&c); sha_update(&c, m, n); sha_final(&c, out); }
_Static_assert(sizeof(sha256_ctx) <= sizeof(anchor_sha256_ctx), "incremental SHA context is too small");
/* Copying the small state avoids alignment and aliasing requirements for an
 * opaque caller buffer; bulk message bytes still go directly to SHA2. */
void anchor_sha256_init(void *ctx) {
    sha256_ctx c = {0}; sha_init(&c);
    memset(ctx, 0, sizeof(anchor_sha256_ctx)); memcpy(ctx, &c, sizeof c);
}
void anchor_sha256_update(void *ctx, const uint8_t *m, size_t n) {
    sha256_ctx c; memcpy(&c, ctx, sizeof c); sha_update(&c, m, n); memcpy(ctx, &c, sizeof c);
}
void anchor_sha256_final(void *ctx, uint8_t out[32]) {
    sha256_ctx c; memcpy(&c, ctx, sizeof c); sha_final(&c, out);
    memset(ctx, 0, sizeof(anchor_sha256_ctx));
}
/* -1 on ANY failure, including a read error mid-file: a short digest must never pass for the file's. */
int anchor_sha256_file(const char *path, uint8_t out[32], uint64_t *bytes) {
    FILE *f = fopen(path, "rb"); if (!f) return -1;
    uint8_t *buf = (uint8_t *)malloc(1 << 20); if (!buf) { fclose(f); return -1; }   /* per call: hashers may run on two threads */
    sha256_ctx c; sha_init(&c); size_t n; uint64_t total = 0;
    while ((n = fread(buf, 1, 1 << 20, f)) > 0) { sha_update(&c, buf, n); total += n; }
    const int bad = ferror(f);
    fclose(f); free(buf);
    if (bad) return -1;
    sha_final(&c, out); if (bytes) *bytes = total; return 0;
}

/* ---- pins ------------------------------------------------------------------------- */
/* 0 = absent, 1 = well-formed 32 bytes, -1 = present but malformed */
static int read_hex32(const char *dir, const char *name, uint8_t out[32]) {
    char path[600]; snprintf(path, sizeof path, "%s/%s", dir, name);
    FILE *f = fopen(path, "rb"); if (!f) return errno == ENOENT ? 0 : -1;   /* present but unreadable is NOT absent */
    char buf[80]; size_t n = fread(buf, 1, sizeof buf, f); const int bad = ferror(f); fclose(f);
    if (bad) return -1;
    if (n == 65 && buf[64] == '\n') n = 64;
    if (n != 64) return -1;
    for (size_t i = 0; i < 64; i++) {
        const char c = buf[i]; int v;
        if (c >= '0' && c <= '9') v = c - '0'; else if (c >= 'a' && c <= 'f') v = c - 'a' + 10; else return -1;   /* lowercase only: one canonical spelling */
        if (i & 1) out[i / 2] = (uint8_t)(out[i / 2] | v); else out[i / 2] = (uint8_t)(v << 4);
    }
    return 1;
}

int anchor_pins_load(const char *dir, anchor_pins *p) {
    if (!p) return 0;
    memset(p, 0, sizeof *p);
    char path[600]; snprintf(path, sizeof path, "%s/anchor.mode", dir ? dir : "");
    FILE *f = fopen(path, "rb");
    if (!f) { snprintf(p->err, sizeof p->err, "anchor.mode missing: the trust mode is a measured build option, not a default"); return 0; }
    /* exact canonical bytes: "dev" or "protected", at most one trailing newline, nothing else - no
     * embedded NUL (strcmp would stop there), no padding, no longer file */
    char m[32]; size_t n = fread(m, 1, sizeof m, f); const int bad = ferror(f); fclose(f);
    if (bad || n == sizeof m) { snprintf(p->err, sizeof p->err, "anchor.mode unreadable or too long"); return 0; }
    if (n && m[n - 1] == '\n') n--;
    if (n == 3 && !memcmp(m, "dev", 3)) p->mode = ANCHOR_MODE_DEV;
    else if (n == 9 && !memcmp(m, "protected", 9)) p->mode = ANCHOR_MODE_PROTECTED;
    else { snprintf(p->err, sizeof p->err, "anchor.mode is neither dev nor protected"); return 0; }
    const int rl = read_hex32(dir, "ledger.pk", p->ledger_pk), rm = read_hex32(dir, "model.sha256", p->model_sha256), rp = read_hex32(dir, "prefix.pk", p->prefix_pk);
    if (rl < 0) { snprintf(p->err, sizeof p->err, "ledger.pk present but malformed or unreadable"); p->mode = ANCHOR_MODE_INVALID; return 0; }
    if (rm < 0) { snprintf(p->err, sizeof p->err, "model.sha256 present but malformed or unreadable"); p->mode = ANCHOR_MODE_INVALID; return 0; }
    if (rp < 0) { snprintf(p->err, sizeof p->err, "prefix.pk present but malformed or unreadable"); p->mode = ANCHOR_MODE_INVALID; return 0; }
    p->has_ledger = rl == 1; p->has_model = rm == 1; p->has_prefix = rp == 1;
    if (p->mode == ANCHOR_MODE_PROTECTED && !(p->has_ledger && p->has_model && p->has_prefix)) {
        snprintf(p->err, sizeof p->err, "protected build without pins:%s%s%s", p->has_ledger ? "" : " ledger", p->has_model ? "" : " model", p->has_prefix ? "" : " prefix");
        p->mode = ANCHOR_MODE_INVALID; return 0;
    }
    return 1;
}

int anchor_pins_model_matches(const anchor_pins *p, const char *path, uint8_t digest_out[32], char *err, size_t errcap) {
    uint8_t d[32]; uint64_t bytes = 0;
    if (!p || !p->has_model) { if (err) snprintf(err, errcap, "no model pin in this build"); return 0; }
    if (anchor_sha256_file(path, d, &bytes) != 0 || bytes == 0) { if (err) snprintf(err, errcap, "model unreadable or empty"); return 0; }
    if (digest_out) memcpy(digest_out, d, 32);
    if (memcmp(d, p->model_sha256, 32) != 0) { if (err) snprintf(err, errcap, "model digest differs from the measured pin"); return 0; }
    return 1;
}

int anchor_sha256_fd(int fd, uint8_t out[32], uint64_t *bytes) {
    if (fd < 0) return -1;
    uint8_t *buf = (uint8_t *)malloc(1 << 20); if (!buf) return -1;
    sha256_ctx c; sha_init(&c); uint64_t off = 0;
    for (;;) {
        ssize_t r = pread(fd, buf, 1 << 20, (off_t)off);   /* by offset: the caller's file position is untouched */
        if (r < 0) { if (errno == EINTR) continue; free(buf); return -1; }
        if (r == 0) break;
        sha_update(&c, buf, (size_t)r); off += (uint64_t)r;
    }
    free(buf);
    sha_final(&c, out); if (bytes) *bytes = off; return 0;
}

int anchor_pins_model_fd_check(const anchor_pins *p, int fd, const uint8_t *frozen, uint8_t digest_out[32], char *err, size_t errcap) {
    uint8_t d[32]; uint64_t bytes = 0;
    if (anchor_sha256_fd(fd, d, &bytes) != 0 || bytes == 0) { if (err) snprintf(err, errcap, "model unreadable or empty"); return 0; }
    if (digest_out) memcpy(digest_out, d, 32);
    if (p && p->has_model && memcmp(d, p->model_sha256, 32) != 0) { if (err) snprintf(err, errcap, "model differs from the measured pin"); return 0; }
    if (frozen && memcmp(d, frozen, 32) != 0) { if (err) snprintf(err, errcap, "model differs from the one the seed was granted for"); return 0; }
    return 1;
}
