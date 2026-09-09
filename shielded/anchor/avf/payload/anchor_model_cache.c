#include "anchor_model_cache.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#define DIR_MAX 400                                                    /* leaves room for "/model.gguf.sha256" in a 512-byte path */
static int hex64(const char *s) { if (!s || strlen(s) != 64) return 0; for (int i = 0; i < 64; i++) { const char c = s[i]; if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0; } return 1; }
static int open_ro(const char *path) { int fd; do { fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | O_NOCTTY); } while (fd < 0 && errno == EINTR); return fd; }
/* the tag file: a regular file of 64 or 65 bytes whose content is exactly <64 hex>[\n]; anything else = no usable tag */
static int read_tag(const char *side, char out[65]) {
    const int fd = open_ro(side); if (fd < 0) return 0;
    struct stat st; int ok = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && (st.st_size == 64 || st.st_size == 65);
    char buf[66]; size_t got = 0;
    while (ok && got < (size_t)st.st_size) { ssize_t r = read(fd, buf + got, (size_t)st.st_size - got); if (r < 0 && errno == EINTR) continue; if (r <= 0) { ok = 0; break; } got += (size_t)r; }
    close(fd);
    if (!ok || got != (size_t)st.st_size) return 0;
    if (st.st_size == 65 && buf[64] != '\n') return 0;
    buf[64] = 0; if (!hex64(buf)) return 0;
    memcpy(out, buf, 65); return 1;
}
/* the verdict, holding the model descriptor on REUSE (closed on every miss) */
static int retained_fd(const char *dir, uint64_t bytes, const char *tag, const char **why, int *fd_out) {
    const char *w = ""; int v = ANCHOR_MODEL_MISS_ARGS, fd = -1;
    char path[512], side[520];
    if (!dir || strlen(dir) > DIR_MAX) { w = "store path missing or too long"; }
    else if (!tag || !hex64(tag)) { w = "no 64-hex cache tag offered"; v = ANCHOR_MODEL_MISS_NO_TAG; }
    else {
        snprintf(path, sizeof path, "%s/model.gguf", dir); snprintf(side, sizeof side, "%s/model.gguf.sha256", dir);   /* dir bounded above: no truncation possible */
        fd = open_ro(path);
        struct stat st;
        if (fd < 0) { v = errno == ENOENT ? ANCHOR_MODEL_MISS_ABSENT : ANCHOR_MODEL_MISS_UNREADABLE; w = errno == ENOENT ? "no model file in the store" : "model file not openable (link, device or permission)"; }
        else if (fstat(fd, &st) != 0) { v = ANCHOR_MODEL_MISS_UNREADABLE; w = "model file cannot be examined"; }
        else if (!S_ISREG(st.st_mode)) { v = ANCHOR_MODEL_MISS_NOT_REGULAR; w = "the model path is not a regular file"; }
        else if (st.st_size < 0 || (uint64_t)st.st_size != bytes) { v = ANCHOR_MODEL_MISS_SIZE; w = "model file size differs from the offered size"; }
        else { char have[65]; if (!read_tag(side, have)) { v = ANCHOR_MODEL_MISS_NO_TAG; w = "model file present but no exact cache tag"; }
               else if (strcmp(have, tag) != 0) { v = ANCHOR_MODEL_MISS_TAG; w = "cache tag differs from the offered digest"; }
               else { v = ANCHOR_MODEL_REUSE; w = "retained: size and tag match"; } }
    }
    if (v != ANCHOR_MODEL_REUSE && fd >= 0) { close(fd); fd = -1; }
    if (why) *why = w;
    if (fd_out) *fd_out = fd; else if (fd >= 0) close(fd);
    return v;
}
int anchor_model_retained(const char *dir, uint64_t bytes, const char *tag, const char **why) { return retained_fd(dir, bytes, tag, why, NULL); }
int anchor_model_open(const char *dir, uint64_t bytes, const char *tag, int cache_only, int *existing, int *verdict) {
    const char *why; int fd = -1; const int v = retained_fd(dir, bytes, tag, &why, &fd);
    if (existing) *existing = 0;
    if (verdict) *verdict = v;
    if (v == ANCHOR_MODEL_REUSE) { if (existing) *existing = 1; return fd; }   /* the same descriptor the verdict was taken on: regular, exact size, read-only */
    if (cache_only) return -2;                                                 /* the whole point: a miss changes nothing */
    if (v == ANCHOR_MODEL_MISS_ARGS) { errno = EINVAL; return -1; }
    char path[512], side[520]; snprintf(path, sizeof path, "%s/model.gguf", dir); snprintf(side, sizeof side, "%s/model.gguf.sha256", dir);
    unlink(side);                                                              /* today's path: whatever is there is not what the owner offers */
    int wfd; do { wfd = open(path, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0600); } while (wfd < 0 && errno == EINTR);
    if (wfd >= 0 && ftruncate(wfd, (off_t)bytes) == 0) return wfd;
    if (wfd >= 0) { const int e = errno; close(wfd); errno = e; }
    return -1;
}
int anchor_model_purge(const char *dir, int cache_only) {
    if (cache_only || !dir || strlen(dir) > DIR_MAX) return 0;             /* cache-only: a refused retained model is left exactly as it was */
    char path[512], side[520]; snprintf(path, sizeof path, "%s/model.gguf", dir); snprintf(side, sizeof side, "%s/model.gguf.sha256", dir);
    int n = 0; if (unlink(side) == 0) n++; if (unlink(path) == 0) n++;
    return n;
}
