#include "anchor_artifacts.h"
#include "anchor_names.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define BLOCK (UINT64_C(1) << 20)
#define CHUNK ((size_t)1 << 16)
#define TMP_LEN (1 + ANCHOR_ARTIFACT_NAME_LEN + 4)      /* ".<name>.tmp" */

void anchor_artifact_name(const uint8_t sha256[32], char out[ANCHOR_ARTIFACT_NAME_LEN + 1]) {
    static const char hex[] = "0123456789abcdef";
    for (int i = 0; i < 32; i++) { out[2 * i] = hex[sha256[i] >> 4]; out[2 * i + 1] = hex[sha256[i] & 15]; }
    memcpy(out + 64, ".i8", 4);
}
static int name_digest(const char *name, uint8_t out[32]) {      /* only after classification: 64 lowercase hex are guaranteed */
    for (int i = 0; i < 32; i++) {
        unsigned v = 0;
        for (int j = 0; j < 2; j++) { const char c = name[2 * i + j]; v = (v << 4) | (unsigned)(c <= '9' ? c - '0' : c - 'a' + 10); }
        out[i] = (uint8_t)v;
    }
    return 1;
}
const anchor_encoded_entry *anchor_artifact_entry(const anchor_encoded_catalog *cat, const uint8_t sha256[32]) {
    if (!cat || !cat->authenticated || !cat->entries || !sha256) return NULL;
    for (size_t i = 0; i < cat->count; i++) if (!memcmp(cat->entries[i].encoded_sha256, sha256, 32)) return &cat->entries[i];
    return NULL;
}
const anchor_encoded_entry *anchor_artifact_admit(const anchor_encoded_catalog *cat, const char *name, uint64_t bytes, const char **why) {
    const char *w = "";
    const anchor_encoded_entry *e = NULL;
    if (anchor_name_classify(name, NULL, NULL, NULL) != ANCHOR_NAME_ARTIFACT) w = "not an artifact name";
    else if (!cat || !cat->authenticated) w = "no encoded catalog admitted yet";
    else {
        uint8_t d[32]; name_digest(name, d);
        e = anchor_artifact_entry(cat, d);
        if (!e) w = "not in the encoded catalog";
        else if (bytes != e->bytes) { w = "size differs from the catalog"; e = NULL; }
    }
    if (why) *why = w;
    return e;
}
/* Never follows a link, never blocks: a FIFO or a device under an artifact name opens at once and fstat rejects it.
 * (The O_NONBLOCK flag is harmless on the regular file that is the only accepted outcome.) */
static int open_ro(int dirfd, const char *name) {
    int fd; do { fd = openat(dirfd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | O_NOCTTY); } while (fd < 0 && errno == EINTR);
    return fd;
}
static uint64_t mono_ms(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u; }
int anchor_artifact_have(int dirfd, const char *name, uint64_t bytes) {
    if (dirfd < 0 || anchor_name_classify(name, NULL, NULL, NULL) != ANCHOR_NAME_ARTIFACT) return -1;
    const int fd = open_ro(dirfd, name);
    if (fd < 0) return errno == ENOENT ? 0 : -1;
    struct stat st; const int rc = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_size >= 0 && (uint64_t)st.st_size == bytes ? 1 : -1;
    close(fd);
    return rc;
}
static int write_all(int fd, const uint8_t *p, size_t n) {
    while (n) { const ssize_t w = write(fd, p, n); if (w < 0) { if (errno == EINTR) continue; return -1; } if (w == 0) { errno = EIO; return -1; } p += w; n -= (size_t)w; }
    return 0;
}
static int fsync_retry(int fd) { int rc; do { rc = fsync(fd); } while (rc < 0 && errno == EINTR); return rc; }
#define EINTR_LIMIT 10000                                /* consecutive interrupted reads before the reception is refused */
static uint64_t profile_now(anchor_artifact_profile *p) {
    const int saved = errno; struct timespec ts;
    const int rc = clock_gettime(CLOCK_MONOTONIC, &ts); errno = saved;
    if (rc != 0) { p->clock_errors++; return 0; }
    return (uint64_t)ts.tv_sec * 1000000000u + (uint64_t)ts.tv_nsec;
}
static void profile_add(anchor_artifact_profile *p, uint64_t *field, uint64_t start) {
    const uint64_t end = profile_now(p);
    if (start && end >= start) *field += end - start;
    else if (start && end) p->clock_errors++;
}
int anchor_artifact_receive(int dirfd, const char *name, const anchor_encoded_entry *e, const anchor_hash_ops *h,
                            anchor_artifact_reader rd, void *ctx, unsigned max_ms, anchor_artifact_receipt *r) {
    return anchor_artifact_receive_profiled(dirfd, name, e, h, rd, ctx, max_ms, r, NULL);
}
int anchor_artifact_receive_profiled(int dirfd, const char *name, const anchor_encoded_entry *e, const anchor_hash_ops *h,
                            anchor_artifact_reader rd, void *ctx, unsigned max_ms, anchor_artifact_receipt *r,
                            anchor_artifact_profile *p) {
    anchor_artifact_receipt local; if (!r) r = &local;
    memset(r, 0, sizeof *r);
    if (p) memset(p, 0, sizeof *p);
    if (dirfd < 0 || !e || !h || !h->init || !h->update || !h->final || !rd) return ANCHOR_ARTIFACT_E_ARGS;
    if (anchor_name_classify(name, NULL, NULL, NULL) != ANCHOR_NAME_ARTIFACT) return ANCHOR_ARTIFACT_E_ARGS;
    if (!e->bytes || !e->block_sha256 || e->blocks != (e->bytes - 1) / BLOCK + 1) return ANCHOR_ARTIFACT_E_ARGS;
    { uint8_t d[32]; name_digest(name, d); if (memcmp(d, e->encoded_sha256, 32) != 0) return ANCHOR_ARTIFACT_E_ARGS; }   /* the name IS the entry's digest: bound here, not only at admission */
    char tmp[TMP_LEN + 1]; snprintf(tmp, sizeof tmp, ".%s.tmp", name);
    if (unlinkat(dirfd, tmp, 0) != 0 && errno != ENOENT) { r->err_no = errno; return ANCHOR_ARTIFACT_E_OPEN; }
    int fd; do { fd = openat(dirfd, tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC | O_NOCTTY, 0600); } while (fd < 0 && errno == EINTR);
    if (fd < 0) { r->err_no = errno; return ANCHOR_ARTIFACT_E_OPEN; }
    uint8_t *buf = malloc(CHUNK);
    if (!buf) { r->err_no = ENOMEM; close(fd); unlinkat(dirfd, tmp, 0); return ANCHOR_ARTIFACT_E_WRITE; }
    const uint64_t body_start = p ? profile_now(p) : 0;
    uint64_t phase_start = p ? profile_now(p) : 0;
    uint64_t hctx[64]; h->init(hctx);                       /* opaque hash state: at least 256 bytes, aligned */
    if (p) profile_add(p, &p->hash_ns, phase_start);
    uint64_t block = 0, in_block = 0; int rc = ANCHOR_ARTIFACT_OK; unsigned eintr = 0; const uint64_t t0 = mono_ms();
    while (r->got < e->bytes) {
        if (max_ms && mono_ms() - t0 > max_ms) { r->err_no = ETIMEDOUT; rc = ANCHOR_ARTIFACT_E_READ; break; }   /* the whole reception is bounded */
        const size_t want = e->bytes - r->got < CHUNK ? (size_t)(e->bytes - r->got) : CHUNK;
        phase_start = p ? profile_now(p) : 0;
        const ssize_t n = rd(ctx, buf, want);
        if (p) { profile_add(p, &p->read_ns, phase_start); p->read_calls++; if (n > 0 && (size_t)n <= want) p->read_bytes += (uint64_t)n; }
        if (n < 0 && errno == EINTR) { if (++eintr < EINTR_LIMIT) continue; r->err_no = EINTR; rc = ANCHOR_ARTIFACT_E_READ; break; }
        if (n < 0) { r->err_no = errno; rc = ANCHOR_ARTIFACT_E_READ; break; }   /* EAGAIN = the socket's receive timeout: a stalled sender is refused, not waited for */
        eintr = 0;
        if (max_ms && mono_ms() - t0 > max_ms) { r->err_no = ETIMEDOUT; rc = ANCHOR_ARTIFACT_E_READ; break; }   /* a chunk that ARRIVED late counts too */
        if (n == 0) { rc = ANCHOR_ARTIFACT_E_SHORT; break; }
        if ((size_t)n > want) { r->err_no = EOVERFLOW; rc = ANCHOR_ARTIFACT_E_READ; break; }   /* an over-delivering reader is a broken reader */
        phase_start = p ? profile_now(p) : 0;
        const int write_rc = write_all(fd, buf, (size_t)n);
        if (p) { profile_add(p, &p->write_ns, phase_start); p->write_batches++; }
        if (write_rc != 0) { r->err_no = errno; rc = ANCHOR_ARTIFACT_E_WRITE; break; }
        phase_start = p ? profile_now(p) : 0;
        size_t off = 0;
        while (off < (size_t)n) {                            /* hash by catalog block, compare the moment a block completes */
            const uint64_t room = BLOCK - in_block; const size_t take = (size_t)n - off < room ? (size_t)n - off : (size_t)room;
            h->update(hctx, buf + off, take); in_block += take; off += take; r->got += take;
            if (in_block == BLOCK || r->got == e->bytes) {
                uint8_t d[32]; h->final(hctx, d);
                if (memcmp(d, e->block_sha256 + 32 * block, 32) != 0) { r->bad_block = block; rc = ANCHOR_ARTIFACT_E_BLOCK; break; }
                block++; in_block = 0;
                if (r->got < e->bytes) h->init(hctx);
            }
        }
        if (p) profile_add(p, &p->hash_ns, phase_start);
        if (rc != ANCHOR_ARTIFACT_OK) break;
    }
    free(buf);
    if (rc == ANCHOR_ARTIFACT_OK && block != e->blocks) rc = ANCHOR_ARTIFACT_E_BLOCK;   /* unreachable by construction; refuse rather than publish */
    if (rc == ANCHOR_ARTIFACT_OK && max_ms && mono_ms() - t0 > max_ms) { r->err_no = ETIMEDOUT; rc = ANCHOR_ARTIFACT_E_READ; }   /* the deadline holds up to the publish itself */
    if (rc == ANCHOR_ARTIFACT_OK) {
        phase_start = p ? profile_now(p) : 0;
        const int sync_rc = fsync_retry(fd);
        if (p) profile_add(p, &p->file_sync_ns, phase_start);
        if (sync_rc != 0) { r->err_no = errno; rc = ANCHOR_ARTIFACT_E_WRITE; }
    }
    if (rc == ANCHOR_ARTIFACT_OK) {
        phase_start = p ? profile_now(p) : 0;
        close(fd); fd = -1;
        if (renameat(dirfd, tmp, dirfd, name) != 0) { r->err_no = errno; rc = ANCHOR_ARTIFACT_E_PUBLISH; }
        else if (fsync_retry(dirfd) != 0) { r->err_no = errno; unlinkat(dirfd, name, 0); rc = ANCHOR_ARTIFACT_E_PUBLISH; }
        if (p) profile_add(p, &p->publish_ns, phase_start);
    }
    if (rc != ANCHOR_ARTIFACT_OK) { if (fd >= 0) close(fd); unlinkat(dirfd, tmp, 0); }
    if (p) profile_add(p, &p->body_total_ns, body_start);
    return rc;
}
int anchor_artifact_sweep(int dirfd, const anchor_encoded_catalog *cat) {
    if (dirfd < 0 || !cat || !cat->authenticated) return -1;
    int d; do { d = openat(dirfd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); } while (d < 0 && errno == EINTR);
    if (d < 0) return -1;
    DIR *dp = fdopendir(d); if (!dp) { close(d); return -1; }
    int removed = 0; struct dirent *de;
    while ((de = readdir(dp))) {
        const char *nm = de->d_name; const size_t len = strlen(nm);
        if (len == TMP_LEN && nm[0] == '.' && !strcmp(nm + len - 4, ".tmp")) {          /* ".<artifact>.tmp": a reception nobody finished */
            char inner[ANCHOR_ARTIFACT_NAME_LEN + 1]; memcpy(inner, nm + 1, ANCHOR_ARTIFACT_NAME_LEN); inner[ANCHOR_ARTIFACT_NAME_LEN] = 0;
            if (anchor_name_classify(inner, NULL, NULL, NULL) == ANCHOR_NAME_ARTIFACT && unlinkat(dirfd, nm, 0) == 0) removed++;
            continue;
        }
        if (anchor_name_classify(nm, NULL, NULL, NULL) != ANCHOR_NAME_ARTIFACT) continue;   /* every other name is not ours to touch */
        uint8_t sha[32]; name_digest(nm, sha);
        const anchor_encoded_entry *e = anchor_artifact_entry(cat, sha);
        int drop = e == NULL;
        if (!drop) { struct stat st; drop = fstatat(dirfd, nm, &st, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISREG(st.st_mode) || st.st_size < 0 || (uint64_t)st.st_size != e->bytes; }
        if (drop && unlinkat(dirfd, nm, 0) == 0) removed++;
    }
    closedir(dp);
    return removed;
}
int anchor_artifact_open(int dirfd, const uint8_t sha256[32], uint64_t bytes, int *state, int *err_no) {
    int st_dummy, en_dummy; if (!state) state = &st_dummy; if (!err_no) err_no = &en_dummy;
    *err_no = 0;
    if (dirfd < 0 || !sha256) { *state = ANCHOR_ARTIFACT_INVALID; *err_no = EINVAL; return -1; }
    char name[ANCHOR_ARTIFACT_NAME_LEN + 1]; anchor_artifact_name(sha256, name);
    const int fd = open_ro(dirfd, name);
    if (fd < 0) { *err_no = errno; *state = errno == ENOENT ? ANCHOR_ARTIFACT_ABSENT : ANCHOR_ARTIFACT_INVALID; return -1; }
    struct stat st;
    if (fstat(fd, &st) != 0) { *err_no = errno; close(fd); *state = ANCHOR_ARTIFACT_INVALID; return -1; }
    if (!S_ISREG(st.st_mode) || st.st_size < 0 || (uint64_t)st.st_size != bytes) { close(fd); *state = ANCHOR_ARTIFACT_INVALID; return -1; }
    *state = ANCHOR_ARTIFACT_PRESENT;
    return fd;
}
int anchor_artifact_open_wait(int dirfd, const uint8_t sha256[32], uint64_t bytes, unsigned wait_ms, unsigned poll_ms, int *state, int *err_no) {
    const uint64_t t0 = mono_ms(); int st = ANCHOR_ARTIFACT_INVALID, en = 0;
    if (poll_ms == 0) poll_ms = 1;
    for (;;) {
        const int fd = anchor_artifact_open(dirfd, sha256, bytes, &st, &en);
        const uint64_t spent = mono_ms() - t0;
        if (fd >= 0 || st != ANCHOR_ARTIFACT_ABSENT || spent >= wait_ms) { if (state) *state = st; if (err_no) *err_no = en; return fd; }
        const uint64_t left = wait_ms - spent, nap_ms = poll_ms < left ? poll_ms : left;      /* never sleep past the deadline */
        struct timespec nap = { (time_t)(nap_ms / 1000u), (long)(nap_ms % 1000u) * 1000000L }; nanosleep(&nap, NULL);
    }
}
