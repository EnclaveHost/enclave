#include "anchor_copy.h"
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int anchor_fsync_retry(int fd) { int rc; do { rc = fsync(fd); } while (rc < 0 && errno == EINTR); return rc; }

int anchor_copy_exact(int src_fd, int dst_fd, uint64_t bytes, uint64_t *got, char *err, size_t errcap) {
    static _Thread_local char buf[1 << 16];
    uint64_t done = 0; if (got) *got = 0; if (errcap) err[0] = 0;
    while (done < bytes) {
        const size_t want = bytes - done < sizeof buf ? (size_t)(bytes - done) : sizeof buf;
        ssize_t r = read(src_fd, buf, want);
        if (r < 0) {
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) { struct pollfd p = { src_fd, POLLIN, 0 }; if (poll(&p, 1, 30000) <= 0) { snprintf(err, errcap, "stream stalled at %llu", (unsigned long long)done); return -1; } continue; }
            snprintf(err, errcap, "read error at %llu: %s", (unsigned long long)done, strerror(errno)); return -1;
        }
        if (r == 0) { snprintf(err, errcap, "stream ended at %llu of %llu", (unsigned long long)done, (unsigned long long)bytes); return -1; }
        size_t off = 0;
        while (off < (size_t)r) {
            ssize_t w = write(dst_fd, buf + off, (size_t)r - off);
            if (w < 0) { if (errno == EINTR) continue; snprintf(err, errcap, "write error at %llu: %s", (unsigned long long)(done + off), strerror(errno)); if (got) *got = done + off; return -1; }
            if (w == 0) { snprintf(err, errcap, "write made no progress at %llu", (unsigned long long)(done + off)); if (got) *got = done + off; return -1; }
            off += (size_t)w;
        }
        done += (uint64_t)r; if (got) *got = done;
    }
    return 0;
}
