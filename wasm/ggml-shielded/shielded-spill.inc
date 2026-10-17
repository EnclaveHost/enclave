/* shielded-spill.inc -- the disk tier behind the pad rings. See shielded-spill.h.
 * Included by shielded-tee.c (which defines _GNU_SOURCE), its only user, so
 * every build of the trusted half carries it without another source to list. */
#include "shielded-spill.h"
#include "shielded-field.h"
#include "shielded-pads.h"
#include "shielded-tee.h"
#include "shielded-simd.h"
#include "poly1305-donna.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <unistd.h>

#define SPILL_MAX_PARTS 16
#define SPILL_MAX_SLOTS (UINT32_C(1) << 24)
#define SPILL_TAG 16
/* One I/O covers at most this much: several slots of a small group, or one of
 * the vocabulary projection. */
#define SPILL_IO_TARGET (UINT64_C(4) << 20)

struct sh_spill {
    int       part;
    size_t    n;
    uint64_t  base, bytes, row_bytes;
    uint64_t  next;                 /* first byte past the last region: the headroom starts here */
    uint32_t  slots;
    int64_t  *K, *u_len;
    uint64_t *gfp;                  /* per group: the registration its pads were minted for */
    uint64_t *slot_bytes, *region;
    uint64_t  io_bytes;
    sh_spill_stream_fn stream;
    uint8_t   aead_key[32];
    uint32_t  mask_key[8];
};

/* The device: opened once per process, shared by partition. */
static struct {
    pthread_mutex_t mu;
    bool tried, ok;
    int fd, parts;
    uint64_t bytes, align;
    bool claimed[SPILL_MAX_PARTS];
    char why[160];
} sp_dev = { .mu = PTHREAD_MUTEX_INITIALIZER, .fd = -1 };

static bool sp_random(void *buf, size_t n) {
    uint8_t *p = (uint8_t *)buf;
    while (n) {
        const ssize_t got = getrandom(p, n, 0);
        if (got < 0) { if (errno == EINTR) continue; return false; }
        p += got; n -= (size_t)got;
    }
    return true;
}

static void sp_wipe(void *p, size_t n) { volatile uint8_t *v = (volatile uint8_t *)p; while (n--) *v++ = 0; }

/* The spill's AEAD: RFC 8439 ChaCha20-Poly1305, no AAD, laid out tag || ciphertext,
 * the same bytes as sh_aead_seal / sh_aead_open (shielded-pads.c). Every pad a request
 * takes from the spill is opened here, ~3.6 GB a Z-Image 512px step, and the scalar
 * ChaCha block was the largest cost on the request path (2026-10-17 host profile:
 * 22% of the DiT's critical path). The body runs sixteen blocks at a time on AVX-512
 * once sp_aead_admit has compared both directions with the scalar AEAD; otherwise,
 * and for every tail, the scalar block. */
static pthread_once_t sp_aead_once = PTHREAD_ONCE_INIT;
static bool sp_aead_vec;

static uint32_t sp_ld32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
#define SP_ROTL(v, c) (((v) << (c)) | ((v) >> (32 - (c))))
#define SP_QR(a, b, c, d) (a += b, d ^= a, d = SP_ROTL(d, 16), c += d, b ^= c, b = SP_ROTL(b, 12), a += b, d ^= a, d = SP_ROTL(d, 8), c += d, b ^= c, b = SP_ROTL(b, 7))
static void sp_chacha_block(const uint8_t key[32], uint32_t counter, const uint8_t nonce[12], uint8_t out[64]) {
    uint32_t s[16], x[16];
    s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
    for (int i = 0; i < 8; i++) s[4 + i] = sp_ld32(key + 4 * i);
    s[12] = counter; s[13] = sp_ld32(nonce); s[14] = sp_ld32(nonce + 4); s[15] = sp_ld32(nonce + 8);
    memcpy(x, s, sizeof x);
    for (int i = 0; i < 10; i++) {
        SP_QR(x[0], x[4], x[8], x[12]); SP_QR(x[1], x[5], x[9], x[13]); SP_QR(x[2], x[6], x[10], x[14]); SP_QR(x[3], x[7], x[11], x[15]);
        SP_QR(x[0], x[5], x[10], x[15]); SP_QR(x[1], x[6], x[11], x[12]); SP_QR(x[2], x[7], x[8], x[13]); SP_QR(x[3], x[4], x[9], x[14]);
    }
    for (int i = 0; i < 16; i++) { const uint32_t v = x[i] + s[i]; out[4 * i] = (uint8_t)v; out[4 * i + 1] = (uint8_t)(v >> 8); out[4 * i + 2] = (uint8_t)(v >> 16); out[4 * i + 3] = (uint8_t)(v >> 24); }
    sp_wipe(x, sizeof x); sp_wipe(s, sizeof s);
}
#undef SP_QR
#undef SP_ROTL

/* in may equal out (the read opens in place). */
static void sp_xor_stream(const uint8_t key[32], const uint8_t nonce[12], const uint8_t *in, size_t n, uint8_t *out, bool vec) {
    size_t off = 0;
#if !defined(__aarch64__)
    if (vec) off = sh_simd_avx512_chacha_ietf_xor(key, 1, nonce, in, out, n);
#else
    (void)vec;
#endif
    uint8_t blk[64];
    for (uint32_t ctr = 1 + (uint32_t)(off / 64); off < n; off += 64, ctr++) {
        sp_chacha_block(key, ctr, nonce, blk);
        const size_t take = n - off < 64 ? n - off : 64;
        for (size_t i = 0; i < take; i++) out[off + i] = in[off + i] ^ blk[i];
    }
    sp_wipe(blk, sizeof blk);
}
static void sp_tag(const uint8_t key[32], const uint8_t nonce[12], const uint8_t *ct, size_t n, uint8_t tag[16]) {
    static const uint8_t zeros[16] = {0};
    uint8_t blk[64], lens[16] = {0};
    sp_chacha_block(key, 0, nonce, blk);                 /* the one-time Poly1305 key */
    poly1305_context st;
    poly1305_init(&st, blk);
    poly1305_update(&st, ct, n);
    if (n % 16) poly1305_update(&st, zeros, 16 - n % 16);
    for (int i = 0; i < 8; i++) lens[8 + i] = (uint8_t)((uint64_t)n >> (8 * i));
    poly1305_update(&st, lens, 16);
    poly1305_finish(&st, tag);
    sp_wipe(blk, sizeof blk); sp_wipe(&st, sizeof st);
}
static void sp_seal_with(const uint8_t key[32], const uint8_t nonce[12], const uint8_t *msg, size_t n, uint8_t *box, bool vec) {
    sp_xor_stream(key, nonce, msg, n, box + SPILL_TAG, vec);
    sp_tag(key, nonce, box + SPILL_TAG, n, box);
}
static int sp_open_with(const uint8_t key[32], const uint8_t nonce[12], const uint8_t *box, size_t n, uint8_t *out, bool vec) {
    uint8_t tag[16];
    sp_tag(key, nonce, box + SPILL_TAG, n, tag);
    if (!poly1305_verify(tag, box)) return SH_ERR_VERIFY;
    sp_xor_stream(key, nonce, box + SPILL_TAG, n, out, vec);
    return SH_OK;
}

/* Sealed by the vector body == sealed by sh_aead_seal, and each opens the other's box,
 * over lengths that cover whole 1 KiB groups, tails, and a 1-byte message. */
static void sp_aead_admit(void) {
#if !defined(__aarch64__)
    __builtin_cpu_init();
    if (!__builtin_cpu_supports("avx512f") || !__builtin_cpu_supports("avx512bw") || !__builtin_cpu_supports("avx512vl") ||
        !__builtin_cpu_supports("avx512dq") || !__builtin_cpu_supports("avx512vnni")) return;
    static const size_t lens[] = {1, 1023, 1024, 3 * 1024 + 37, 64 * 1024 + 5};
    const size_t most = 64 * 1024 + 5;
    uint8_t key[32], nonce[12];
    uint8_t *msg = (uint8_t *)malloc(most), *a = (uint8_t *)malloc(most + SPILL_TAG), *b = (uint8_t *)malloc(most + SPILL_TAG), *o = (uint8_t *)malloc(most);
    bool ok = msg && a && b && o && sp_random(key, sizeof key) && sp_random(nonce, sizeof nonce) && sp_random(msg, most);
    for (size_t i = 0; ok && i < sizeof lens / sizeof lens[0]; i++) {
        const size_t n = lens[i];
        sh_aead_seal(key, nonce, msg, n, a);
        sp_seal_with(key, nonce, msg, n, b, true);
        ok = !memcmp(a, b, n + SPILL_TAG) &&
             sp_open_with(key, nonce, a, n, o, true) == SH_OK && !memcmp(o, msg, n) &&
             sh_aead_open(key, nonce, b, n, o) == SH_OK && !memcmp(o, msg, n);
        b[SPILL_TAG + n / 2] ^= 1;                        /* and a flipped bit is refused */
        ok = ok && sp_open_with(key, nonce, b, n, o, true) == SH_ERR_VERIFY;
    }
    sp_wipe(key, sizeof key);
    if (msg) { sp_wipe(msg, most); free(msg); }
    if (o) { sp_wipe(o, most); free(o); }
    free(a); free(b);
    sp_aead_vec = ok;
    if (!ok) fprintf(stderr, "[shielded] pad spill: the vector AEAD disagrees with the scalar one; using the scalar\n");
#endif
}
static void sp_seal(const uint8_t key[32], const uint8_t nonce[12], const uint8_t *msg, size_t n, uint8_t *box) {
    pthread_once(&sp_aead_once, sp_aead_admit);
    sp_seal_with(key, nonce, msg, n, box, sp_aead_vec);
}
static int sp_open(const uint8_t key[32], const uint8_t nonce[12], const uint8_t *box, size_t n, uint8_t *out) {
    pthread_once(&sp_aead_once, sp_aead_admit);
    return sp_open_with(key, nonce, box, n, out, sp_aead_vec);
}

/* Under sp_dev.mu. */
static void sp_dev_open(void) {
    if (sp_dev.tried) return;
    sp_dev.tried = true;
    const char *e = getenv("SHIELDED_PAD_SPILL");
    if (!e || !*e) return;                                    /* not configured: no reason to give */
    char *end = NULL;
    const long fd = strncmp(e, "fd:", 3) ? -1 : strtol(e + 3, &end, 10);
    if (fd < 3 || fd > 65535 || !end || *end) { snprintf(sp_dev.why, sizeof sp_dev.why, "SHIELDED_PAD_SPILL must be fd:N"); return; }
    const int fl = fcntl((int)fd, F_GETFL);
    if (fl < 0) { snprintf(sp_dev.why, sizeof sp_dev.why, "fd %ld is not open", fd); return; }
    if ((fl & O_ACCMODE) != O_RDWR) { snprintf(sp_dev.why, sizeof sp_dev.why, "fd %ld is not open read-write", fd); return; }
    struct stat st;
    if (fstat((int)fd, &st) != 0) { snprintf(sp_dev.why, sizeof sp_dev.why, "fstat fd %ld: %s", fd, strerror(errno)); return; }
    uint64_t bytes = 0, align = 4096;
    if (S_ISBLK(st.st_mode)) {
        int lbs = 0;
        if (ioctl((int)fd, BLKGETSIZE64, &bytes) != 0 || ioctl((int)fd, BLKSSZGET, &lbs) != 0) {
            snprintf(sp_dev.why, sizeof sp_dev.why, "block device size: %s", strerror(errno)); return;
        }
        align = lbs > 512 ? (uint64_t)lbs : 512;
    } else if (S_ISREG(st.st_mode)) {
        bytes = (uint64_t)st.st_size;
    } else {
        snprintf(sp_dev.why, sizeof sp_dev.why, "fd %ld is neither a block device nor a file", fd); return;
    }
    if (align > 4096 || (align & (align - 1))) { snprintf(sp_dev.why, sizeof sp_dev.why, "unsupported block size %llu", (unsigned long long)align); return; }
    /* O_DIRECT, or nothing: through the page cache the store would occupy the
     * guest RAM it exists to save. */
    if (fcntl((int)fd, F_SETFL, fl | O_DIRECT) != 0) { snprintf(sp_dev.why, sizeof sp_dev.why, "O_DIRECT refused: %s", strerror(errno)); return; }
    (void)fcntl((int)fd, F_SETFD, FD_CLOEXEC);
    const char *pe = getenv("SHIELDED_PAD_SPILL_PARTS");
    int parts = pe && *pe ? atoi(pe) : 2;
    if (parts < 1) parts = 1;
    if (parts > SPILL_MAX_PARTS) parts = SPILL_MAX_PARTS;
    sp_dev.fd = (int)fd; sp_dev.bytes = bytes; sp_dev.align = align; sp_dev.parts = parts;
    sp_dev.ok = true;
}

static uint64_t sp_round_up(uint64_t x, uint64_t a) { return (x + a - 1) / a * a; }

void sh_spill_detach(sh_spill *s) {
    if (!s) return;
    pthread_mutex_lock(&sp_dev.mu);
    if (s->part >= 0 && s->part < SPILL_MAX_PARTS) sp_dev.claimed[s->part] = false;
    pthread_mutex_unlock(&sp_dev.mu);
    sp_wipe(s->aead_key, sizeof s->aead_key); sp_wipe(s->mask_key, sizeof s->mask_key);
    free(s->K); free(s->u_len); free(s->gfp); free(s->slot_bytes); free(s->region);
    free(s);
}

/* Per-group arrays sized for n groups (the old contents kept). */
static bool sp_grow(sh_spill *s, size_t n) {
    int64_t *K = (int64_t *)realloc(s->K, n * sizeof *K);           if (K) s->K = K;
    int64_t *U = (int64_t *)realloc(s->u_len, n * sizeof *U);       if (U) s->u_len = U;
    uint64_t *F = (uint64_t *)realloc(s->gfp, n * sizeof *F);       if (F) s->gfp = F;
    uint64_t *B = (uint64_t *)realloc(s->slot_bytes, n * sizeof *B); if (B) s->slot_bytes = B;
    uint64_t *R = (uint64_t *)realloc(s->region, n * sizeof *R);    if (R) s->region = R;
    return K && U && F && B && R;
}

static bool sp_shape_ok(int64_t K, int64_t u_len) {
    return K >= 1 && K <= (INT64_C(1) << 24) && u_len >= 1 && u_len <= (INT64_C(1) << 26);
}

sh_spill *sh_spill_attach(const int64_t *K, const int64_t *u_len, const uint64_t *gfp, size_t n,
                          sh_spill_stream_fn stream, char *why, size_t why_cap) {
    if (why && why_cap) why[0] = 0;
#define REFUSE(...) do { if (why && why_cap) snprintf(why, why_cap, __VA_ARGS__); goto fail; } while (0)
    sh_spill *s = NULL;
    pthread_mutex_lock(&sp_dev.mu);
    sp_dev_open();
    if (!sp_dev.ok) {
        if (why && why_cap && sp_dev.why[0]) snprintf(why, why_cap, "%s", sp_dev.why);
        pthread_mutex_unlock(&sp_dev.mu);
        return NULL;
    }
    int part = -1;
    for (int p = 0; p < sp_dev.parts; p++) if (!sp_dev.claimed[p]) { part = p; break; }
    if (part < 0) { pthread_mutex_unlock(&sp_dev.mu); if (why && why_cap) snprintf(why, why_cap, "every partition of the spill device is taken"); return NULL; }
    sp_dev.claimed[part] = true;
    const uint64_t part_bytes = sp_dev.bytes / (uint64_t)sp_dev.parts / sp_dev.align * sp_dev.align;
    const uint64_t align = sp_dev.align;
    pthread_mutex_unlock(&sp_dev.mu);

    s = (sh_spill *)calloc(1, sizeof *s);
    if (!s) { pthread_mutex_lock(&sp_dev.mu); sp_dev.claimed[part] = false; pthread_mutex_unlock(&sp_dev.mu); REFUSE("out of memory"); }
    s->part = part;
    if (!n || n > 65536 || !K || !u_len || !gfp) REFUSE("no groups to lay out");
    s->stream = stream;
    if (!sp_grow(s, n)) REFUSE("out of memory");
    s->n = n;
    uint64_t row = 0, widest = 0;
    for (size_t g = 0; g < n; g++) {
        if (!sp_shape_ok(K[g], u_len[g])) REFUSE("group %zu has an unsupported shape", g);
        s->K[g] = K[g]; s->u_len[g] = u_len[g]; s->gfp[g] = gfp[g];
        s->slot_bytes[g] = sp_round_up(SPILL_TAG + 3 * (uint64_t)u_len[g], align);
        if (s->slot_bytes[g] > widest) widest = s->slot_bytes[g];
        row += s->slot_bytes[g];
    }
    s->row_bytes = row;
    /* Headroom for groups registered later (an MTP head discovered by the
     * first speculative request): they get regions of their own past `next`,
     * and every group already here keeps its pads (sh_spill_extend). */
    const char *he = getenv("SHIELDED_PAD_SPILL_HEADROOM_PCT");
    int headroom = he && *he ? atoi(he) : 15;
    if (headroom < 0) headroom = 0;
    if (headroom > 100) headroom = 100;
    uint64_t slots = part_bytes / (row + row * (uint64_t)headroom / 100);
    if (slots > SPILL_MAX_SLOTS) slots = SPILL_MAX_SLOTS;
    if (slots < 2) REFUSE("%.1f GiB per partition holds fewer than two pads per group (%.1f MiB a row)",
                          part_bytes / 1073741824.0, row / 1048576.0);
    s->slots = (uint32_t)slots;
    s->base = (uint64_t)part * part_bytes;
    s->bytes = part_bytes;
    uint64_t at = s->base;
    for (size_t g = 0; g < n; g++) { s->region[g] = at; at += (uint64_t)s->slots * s->slot_bytes[g]; }
    s->next = at;
    s->io_bytes = sp_round_up(widest > SPILL_IO_TARGET ? widest : SPILL_IO_TARGET, 4096);
    if (!sp_random(s->aead_key, sizeof s->aead_key) || !sp_random(s->mask_key, sizeof s->mask_key))
        REFUSE("no entropy for the spill keys");
    return s;
fail:
    sh_spill_detach(s);
    return NULL;
#undef REFUSE
}

int sh_spill_extend(sh_spill *s, const int64_t *K, const int64_t *u_len, const uint64_t *gfp, size_t n, uint8_t *kept) {
    if (!s || !K || !u_len || !gfp || !kept || n < s->n || n > 65536) return SH_ERR_RANGE;
    pthread_mutex_lock(&sp_dev.mu);
    const uint64_t align = sp_dev.align;
    pthread_mutex_unlock(&sp_dev.mu);
    /* Plan first, commit after: a refusal changes nothing. */
    uint64_t need = 0;
    for (size_t g = 0; g < n; g++) {
        kept[g] = g < s->n && s->gfp[g] == gfp[g] && s->K[g] == K[g] && s->u_len[g] == u_len[g];
        if (kept[g]) continue;
        if (!sp_shape_ok(K[g], u_len[g])) return SH_ERR_RANGE;
        const uint64_t sb = sp_round_up(SPILL_TAG + 3 * (uint64_t)u_len[g], align);
        if (sb > s->io_bytes) return SH_ERR_RANGE;
        need += (uint64_t)s->slots * sb;
    }
    if (s->next + need > s->base + s->bytes) return SH_ERR_RANGE;
    if (!sp_grow(s, n)) return SH_ERR_NOMEM;
    uint64_t row = 0;
    for (size_t g = 0; g < n; g++) {
        if (!kept[g]) {
            s->K[g] = K[g]; s->u_len[g] = u_len[g]; s->gfp[g] = gfp[g];
            s->slot_bytes[g] = sp_round_up(SPILL_TAG + 3 * (uint64_t)u_len[g], align);
            s->region[g] = s->next;                      /* a changed group's old region is simply left behind */
            s->next += (uint64_t)s->slots * s->slot_bytes[g];
        }
        row += s->slot_bytes[g];
    }
    s->n = n; s->row_bytes = row;
    return SH_OK;
}
uint32_t sh_spill_slots(const sh_spill *s) { return s ? s->slots : 0; }
int      sh_spill_part(const sh_spill *s) { return s ? s->part : -1; }
uint64_t sh_spill_bytes(const sh_spill *s) { return s ? s->bytes : 0; }
uint64_t sh_spill_row_bytes(const sh_spill *s) { return s ? s->row_bytes : 0; }

uint8_t *sh_spill_io_alloc(const sh_spill *s) {
    if (!s) return NULL;
    void *p = NULL;
    return posix_memalign(&p, 4096, (size_t)s->io_bytes) == 0 ? (uint8_t *)p : NULL;
}

/* maskbank_issue's stream, at a chosen index instead of the next one. */
void sh_spill_mask(const sh_spill *s, uint64_t wid, int32_t *r, int64_t K) {
    if (wid >= SH_SPILL_WID_LIMIT) abort();          /* 2^40 writes: unreachable, and never a repeated stream */
    if (s->stream) { s->stream(s->mask_key, wid << 24, r, (size_t)K); return; }
    uint32_t blk[16];
    uint64_t ctr = wid << 24;
    int64_t produced = 0;
    while (produced < K) {
        sh_chacha20_block(s->mask_key, ctr++, blk);
        for (int i = 0; i + 1 < 16 && produced < K; i += 2) {
            const uint64_t v = ((uint64_t)blk[i + 1] << 32) | blk[i];
            r[produced++] = (int32_t)(v % (uint64_t)SH_M_MOD);
        }
    }
    sp_wipe(blk, sizeof blk);
}

static void sp_nonce(uint64_t wid, size_t g, uint8_t nonce[12]) {
    for (int i = 0; i < 8; i++) nonce[i] = (uint8_t)(wid >> (8 * i));
    for (int i = 0; i < 4; i++) nonce[8 + i] = (uint8_t)((uint64_t)g >> (8 * i));
}

/* Balanced values in [-(M-1)/2, (M-1)/2] fit 24-bit two's complement with room
 * to spare; anything else is refused, never truncated. */
static bool sp_pack24(const int32_t *u, int64_t n, uint8_t *p) {
    for (int64_t i = 0; i < n; i++) {
        const int32_t v = u[i];
        if (v < -SH_HALF_M || v > SH_HALF_M) return false;
        const uint32_t w = (uint32_t)v;
        p[3 * i] = (uint8_t)w; p[3 * i + 1] = (uint8_t)(w >> 8); p[3 * i + 2] = (uint8_t)(w >> 16);
    }
    return true;
}
static bool sp_unpack24(const uint8_t *p, int64_t n, int32_t *u) {
    for (int64_t i = 0; i < n; i++) {
        const int32_t raw = (int32_t)((uint32_t)p[3 * i] | (uint32_t)p[3 * i + 1] << 8 | (uint32_t)p[3 * i + 2] << 16);
        const int32_t v = (raw ^ 0x800000) - 0x800000;
        if (v < -SH_HALF_M || v > SH_HALF_M) return false;
        u[i] = v;
    }
    return true;
}

static int sp_io(bool write, void *buf, uint64_t len, uint64_t off) {
    uint8_t *p = (uint8_t *)buf;
    while (len) {
        const ssize_t got = write ? pwrite(sp_dev.fd, p, (size_t)len, (off_t)off) : pread(sp_dev.fd, p, (size_t)len, (off_t)off);
        if (got < 0) { if (errno == EINTR) continue; return SH_ERR_IO; }
        if (got == 0) return SH_ERR_IO;                /* past the end: the host shrank the disk */
        p += got; len -= (uint64_t)got; off += (uint64_t)got;
    }
    return SH_OK;
}

static bool sp_run_ok(const sh_spill *s, size_t g, uint32_t slot0, int b) {
    return s && g < s->n && b > 0 && slot0 < s->slots && (uint32_t)b <= s->slots && sp_dev.fd >= 0;
}

int sh_spill_write(const sh_spill *s, size_t g, uint32_t slot0, int b,
                   const uint64_t *wid, const int32_t *u, uint8_t *io) {
    if (!sp_run_ok(s, g, slot0, b) || !wid || !u || !io) return SH_ERR_RANGE;
    const uint64_t sb = s->slot_bytes[g];
    const int64_t n = s->u_len[g];
    const size_t body = (size_t)3 * (size_t)n;
    const uint32_t per_io = (uint32_t)(s->io_bytes / sb);
    for (int i = 0; i < b; ) {
        const uint32_t slot = (uint32_t)(((uint64_t)slot0 + (uint64_t)i) % s->slots);
        uint32_t run = (uint32_t)(b - i);
        if (run > s->slots - slot) run = s->slots - slot;      /* the region ends: wrap in a second I/O */
        if (run > per_io) run = per_io;
        for (uint32_t j = 0; j < run; j++) {
            uint8_t *box = io + (size_t)j * sb;
            if (!sp_pack24(u + (size_t)(i + (int)j) * (size_t)n, n, box + SPILL_TAG)) return SH_ERR_RANGE;
            memset(box + SPILL_TAG + body, 0, (size_t)sb - SPILL_TAG - body);
            uint8_t nonce[12];
            sp_nonce(wid[i + (int)j], g, nonce);
            sp_seal(s->aead_key, nonce, box + SPILL_TAG, body, box);
        }
        const int rc = sp_io(true, io, (uint64_t)run * sb, s->region[g] + (uint64_t)slot * sb);
        if (rc != SH_OK) return rc;
        i += (int)run;
    }
    return SH_OK;
}

int sh_spill_read(const sh_spill *s, size_t g, uint32_t slot0, int b,
                  const uint64_t *wid, int32_t *r_out, int32_t *u_out, uint8_t *io) {
    if (!sp_run_ok(s, g, slot0, b) || !wid || !r_out || !u_out || !io) return SH_ERR_RANGE;
    const uint64_t sb = s->slot_bytes[g];
    const int64_t n = s->u_len[g], K = s->K[g];
    const size_t body = (size_t)3 * (size_t)n;
    const uint32_t per_io = (uint32_t)(s->io_bytes / sb);
    for (int i = 0; i < b; ) {
        const uint32_t slot = (uint32_t)(((uint64_t)slot0 + (uint64_t)i) % s->slots);
        uint32_t run = (uint32_t)(b - i);
        if (run > s->slots - slot) run = s->slots - slot;
        if (run > per_io) run = per_io;
        const int rc = sp_io(false, io, (uint64_t)run * sb, s->region[g] + (uint64_t)slot * sb);
        if (rc != SH_OK) return rc;
        for (uint32_t j = 0; j < run; j++) {
            uint8_t *box = io + (size_t)j * sb;
            uint8_t nonce[12];
            sp_nonce(wid[i + (int)j], g, nonce);
            if (sp_open(s->aead_key, nonce, box, body, box + SPILL_TAG) != SH_OK) return SH_ERR_VERIFY;
            if (!sp_unpack24(box + SPILL_TAG, n, u_out + (size_t)(i + (int)j) * (size_t)n)) return SH_ERR_VERIFY;
            sh_spill_mask(s, wid[i + (int)j], r_out + (size_t)(i + (int)j) * (size_t)K, K);
        }
        i += (int)run;
    }
    return SH_OK;
}
