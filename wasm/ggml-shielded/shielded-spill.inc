/* shielded-spill.inc -- the disk tier behind the pad rings. See shielded-spill.h.
 * Included by shielded-tee.c (which defines _GNU_SOURCE), its only user, so
 * every build of the trusted half carries it without another source to list. */
#include "shielded-spill.h"
#include "shielded-field.h"
#include "shielded-pads.h"
#include "shielded-tee.h"

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
    uint64_t  fingerprint;
    uint64_t  base, bytes, row_bytes;
    uint32_t  slots;
    int64_t  *K, *u_len;
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
    free(s->K); free(s->u_len); free(s->slot_bytes); free(s->region);
    free(s);
}

sh_spill *sh_spill_attach(const int64_t *K, const int64_t *u_len, size_t n, uint64_t fingerprint,
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
    if (!n || n > 65536 || !K || !u_len) REFUSE("no groups to lay out");
    s->n = n; s->fingerprint = fingerprint; s->stream = stream;
    s->K = (int64_t *)malloc(n * sizeof *s->K);
    s->u_len = (int64_t *)malloc(n * sizeof *s->u_len);
    s->slot_bytes = (uint64_t *)malloc(n * sizeof *s->slot_bytes);
    s->region = (uint64_t *)malloc(n * sizeof *s->region);
    if (!s->K || !s->u_len || !s->slot_bytes || !s->region) REFUSE("out of memory");
    uint64_t row = 0, widest = 0;
    for (size_t g = 0; g < n; g++) {
        if (K[g] < 1 || K[g] > (INT64_C(1) << 24) || u_len[g] < 1 || u_len[g] > (INT64_C(1) << 26)) REFUSE("group %zu has an unsupported shape", g);
        s->K[g] = K[g]; s->u_len[g] = u_len[g];
        s->slot_bytes[g] = sp_round_up(SPILL_TAG + 3 * (uint64_t)u_len[g], align);
        if (s->slot_bytes[g] > widest) widest = s->slot_bytes[g];
        row += s->slot_bytes[g];
    }
    s->row_bytes = row;
    uint64_t slots = part_bytes / row;
    if (slots > SPILL_MAX_SLOTS) slots = SPILL_MAX_SLOTS;
    if (slots < 2) REFUSE("%.1f GiB per partition holds fewer than two pads per group (%.1f MiB a row)",
                          part_bytes / 1073741824.0, row / 1048576.0);
    s->slots = (uint32_t)slots;
    s->base = (uint64_t)part * part_bytes;
    s->bytes = part_bytes;
    uint64_t at = s->base;
    for (size_t g = 0; g < n; g++) { s->region[g] = at; at += (uint64_t)s->slots * s->slot_bytes[g]; }
    s->io_bytes = sp_round_up(widest > SPILL_IO_TARGET ? widest : SPILL_IO_TARGET, 4096);
    if (!sp_random(s->aead_key, sizeof s->aead_key) || !sp_random(s->mask_key, sizeof s->mask_key))
        REFUSE("no entropy for the spill keys");
    return s;
fail:
    sh_spill_detach(s);
    return NULL;
#undef REFUSE
}

bool     sh_spill_fits(const sh_spill *s, size_t n, uint64_t fingerprint) { return s && s->n == n && s->fingerprint == fingerprint; }
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
            sh_aead_seal(s->aead_key, nonce, box + SPILL_TAG, body, box);
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
            if (sh_aead_open(s->aead_key, nonce, box, body, box + SPILL_TAG) != SH_OK) return SH_ERR_VERIFY;
            if (!sp_unpack24(box + SPILL_TAG, n, u_out + (size_t)(i + (int)j) * (size_t)n)) return SH_ERR_VERIFY;
            sh_spill_mask(s, wid[i + (int)j], r_out + (size_t)(i + (int)j) * (size_t)K, K);
        }
        i += (int)run;
    }
    return SH_OK;
}
