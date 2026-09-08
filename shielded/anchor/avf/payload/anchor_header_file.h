#ifndef ANCHOR_HEADER_FILE_H
#define ANCHOR_HEADER_FILE_H

/* A read-only stdio stream over an ALREADY AUTHENTICATED PRIVATE GGUF header.
 * It reports the model's full logical size to metadata parsers, but serves no
 * tensor bytes. No filesystem, memfd, mmap or host-backed storage is involved.
 * Use llama_model_load_from_file_ptr with no_alloc=true and load_mode=NONE;
 * an attempted weight read hits EOF. The header must outlive the FILE. fclose
 * frees only the stream's cursor, not the borrowed header. On glibc compile with
 * _GNU_SOURCE for fopencookie; Android uses its public funopen64 API. */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <limits.h>
#include <sys/types.h>

typedef struct {
    const uint8_t *bytes;
    size_t length;
    int64_t logical_size, position;
} anchor_header_cursor;

static inline ssize_t anchor_header_read(void *opaque, char *dst, size_t n) {
    anchor_header_cursor *c = (anchor_header_cursor *)opaque;
    if ((uint64_t)c->position >= c->length) return 0;
    size_t left = c->length - (size_t)c->position;
    if (n > left) n = left;
    if (n > (size_t)SSIZE_MAX) n = (size_t)SSIZE_MAX;
    memcpy(dst, c->bytes + (size_t)c->position, n);
    c->position += (int64_t)n;
    return (ssize_t)n;
}
static inline int64_t anchor_header_seek(void *opaque, int64_t offset, int whence) {
    anchor_header_cursor *c = (anchor_header_cursor *)opaque;
    int64_t base;
    if (whence == SEEK_SET) base = 0;
    else if (whence == SEEK_CUR) base = c->position;
    else if (whence == SEEK_END) base = c->logical_size;
    else { errno = EINVAL; return -1; }
    const __int128 next = (__int128)base + offset;
    if (next < 0 || next > c->logical_size) { errno = EINVAL; return -1; }
    c->position = (int64_t)next;
    return c->position;
}
static inline int anchor_header_close(void *opaque) { free(opaque); return 0; }

#if defined(__ANDROID__)
static inline int anchor_header_read_android(void *opaque, char *dst, int n) {
    if (n < 0) { errno = EINVAL; return -1; }
    return (int)anchor_header_read(opaque, dst, (size_t)n);
}
static inline off64_t anchor_header_seek_android(void *opaque, off64_t offset, int whence) {
    return (off64_t)anchor_header_seek(opaque, (int64_t)offset, whence);
}
#else
static inline int anchor_header_seek_glibc(void *opaque, off64_t *offset, int whence) {
    const int64_t next = anchor_header_seek(opaque, *offset, whence);
    if (next < 0) return -1;
    *offset = (off64_t)next;
    return 0;
}
#endif

static inline FILE *anchor_header_file_open(const uint8_t *header, size_t header_len, uint64_t file_size) {
    if (!header || !header_len || file_size < header_len || file_size > INT64_MAX) { errno = EINVAL; return NULL; }
    anchor_header_cursor *c = (anchor_header_cursor *)calloc(1, sizeof *c);
    if (!c) return NULL;
    c->bytes = header; c->length = header_len; c->logical_size = (int64_t)file_size;
#if defined(__ANDROID__)
    FILE *f = funopen64(c, anchor_header_read_android, NULL, anchor_header_seek_android, anchor_header_close);
#else
    cookie_io_functions_t ops = {anchor_header_read, NULL, anchor_header_seek_glibc, anchor_header_close};
    FILE *f = fopencookie(c, "r", ops);
#endif
    if (!f) free(c);
    return f;
}
#endif
