#ifndef ANCHOR_FRAME_LOOP_H
#define ANCHOR_FRAME_LOOP_H
/* Framed request/reply diagnostic over ONE stream socket, host-testable (the payload's bridgebench and a
 * socketpair fixture both include this). Wire: a 4-byte big-endian length then exactly that many payload
 * bytes, each direction; the peer must read the whole frame before replying. Every transfer is
 * NONBLOCKING under an absolute monotonic per-round-trip deadline (poll), so a stall in EITHER direction
 * (a blocked write as well as a blocked read) and an EINTR both fail instead of hanging. The payload is
 * filled deterministically BEFORE the timed transfer and compared in full AFTER it, so the timing covers
 * transfer only and every byte is verified (size 1 included). The bench stops at the FIRST failure and
 * returns nonzero; the caller must treat that as a failed run, never print success. */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

typedef struct { double p50_us, p90_us, min_us; int iters; } anchor_frame_stats;
enum { AFL_OK = 0, AFL_IO = -1, AFL_TIMEOUT = -2, AFL_LENGTH = -3, AFL_CONTENT = -4, AFL_SETUP = -5, AFL_RANGE = -6 };

static inline int64_t afl_now_ms(void) { struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t)) return -1; return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000; }
static inline int afl_set_nonblock(int fd, int *saved) { const int fl = fcntl(fd, F_GETFL); if (fl < 0) return AFL_SETUP; *saved = fl; if (!(fl & O_NONBLOCK) && fcntl(fd, F_SETFL, fl | O_NONBLOCK) < 0) return AFL_SETUP; return AFL_OK; }
static inline void afl_restore(int fd, int saved) { if (saved >= 0) (void)fcntl(fd, F_SETFL, saved); }

/* move exactly n bytes (writing!=0 to send, else receive) before the absolute monotonic `deadline` (ms);
 * partial transfers and EINTR loop, EAGAIN waits in poll with the remaining time, a passed deadline is
 * AFL_TIMEOUT, any other error AFL_IO. Bounds a blocked WRITE, not only a blocked read. */
static inline int afl_xfer(int fd, uint8_t *p, size_t n, int writing, int64_t deadline) {
    size_t off = 0;
    while (off < n) {
        const int64_t now = afl_now_ms(); if (now < 0) return AFL_IO;
        if (now >= deadline) return AFL_TIMEOUT;
        ssize_t r = writing ? send(fd, p + off, n - off, MSG_NOSIGNAL) : read(fd, p + off, n - off);   /* MSG_NOSIGNAL: a closed peer is EPIPE, never a signal */
        if (r > 0) { off += (size_t)r; continue; }
        if (r == 0) return writing ? AFL_IO : AFL_IO;   /* peer closed mid-frame */
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            struct pollfd pfd = { fd, (short)(writing ? POLLOUT : POLLIN), 0 };
            const int64_t left = deadline - afl_now_ms(); if (left <= 0) return AFL_TIMEOUT;
            const int pr = poll(&pfd, 1, left > 60000 ? 60000 : (int)left);
            if (pr < 0) { if (errno == EINTR) continue; return AFL_IO; }
            if (pr == 0) continue;   /* re-check the deadline at the top */
            if (pfd.revents & POLLNVAL) return AFL_IO;
            continue;
        }
        return AFL_IO;
    }
    return AFL_OK;
}

/* deterministic payload: xorshift32 seeded by (seed, size), so a corrupted or short echo is caught for
 * every byte and every size, with no first/last marker overlap at size 1. */
static inline void afl_fill(uint8_t *p, size_t n, uint32_t seed) {
    uint32_t x = seed ? seed : 0x9e3779b9u; x ^= (uint32_t)n * 2654435761u; if (!x) x = 1;
    for (size_t i = 0; i < n; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; p[i] = (uint8_t)x; }
}
static inline int afl_equal(const uint8_t *p, size_t n, uint32_t seed) {
    uint32_t x = seed ? seed : 0x9e3779b9u; x ^= (uint32_t)n * 2654435761u; if (!x) x = 1;
    for (size_t i = 0; i < n; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; if (p[i] != (uint8_t)x) return 0; }
    return 1;
}
static inline void afl_put_be32(uint8_t b[4], uint32_t v) { b[0] = (uint8_t)(v >> 24); b[1] = (uint8_t)(v >> 16); b[2] = (uint8_t)(v >> 8); b[3] = (uint8_t)v; }
static inline uint32_t afl_get_be32(const uint8_t b[4]) { return (uint32_t)b[0] << 24 | (uint32_t)b[1] << 16 | (uint32_t)b[2] << 8 | b[3]; }
static inline int afl_cmp_d(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : x > y ? 1 : 0; }

/* one size: warm-up then iters timed framed round trips; sbuf/rbuf each hold sz bytes; per_rt_timeout_ms
 * bounds each round trip. Returns AFL_OK with stats, or the first failure's negative code (stats unset).
 * fill is BEFORE and compare AFTER the timed section. */
/* Diagnostic START/END handshake, OUTSIDE the timed frames: send a zero-length frame and await the
 * peer's zero-length ack, nonblocking under a deadline. The echo server holds the established socket
 * across this so the link watchdog can bracket the measured window on a LIVE socket. */
static inline int anchor_frame_control(int fd, int timeout_ms) {
    int saved = -1, rc = afl_set_nonblock(fd, &saved); if (rc != AFL_OK) return rc;
    const int64_t deadline = afl_now_ms() + timeout_ms;
    uint8_t z[4] = {0, 0, 0, 0};
    rc = afl_xfer(fd, z, 4, 1, deadline);
    if (rc == AFL_OK) rc = afl_xfer(fd, z, 4, 0, deadline);
    if (rc == AFL_OK && afl_get_be32(z) != 0) rc = AFL_LENGTH;   /* the ack must be a zero-length frame */
    afl_restore(fd, saved);
    return rc;
}

static inline int anchor_frame_bench(int fd, size_t sz, int warm, int iters, int per_rt_timeout_ms,
                                     uint8_t *sbuf, uint8_t *rbuf, anchor_frame_stats *st) {
    if (fd < 0 || sz < 1 || sz > 0xFFFFFFFFull || !sbuf || !rbuf || !st || iters < 1 || warm < 0 || per_rt_timeout_ms < 1) return AFL_RANGE;
    if ((long long)warm + (long long)iters > 1000000 || (size_t)iters > SIZE_MAX / sizeof(double)) return AFL_RANGE;
    int saved = -1, rc = afl_set_nonblock(fd, &saved); if (rc != AFL_OK) return rc;
    double *us = (double *)malloc((size_t)iters * sizeof *us); if (!us) { afl_restore(fd, saved); return AFL_SETUP; }
    for (int i = 0; i < warm + iters; i++) {
        afl_fill(sbuf, sz, (uint32_t)(i + 1));
        uint8_t lp[4]; afl_put_be32(lp, (uint32_t)sz);
        const int64_t t0 = afl_now_ms(), deadline = t0 + per_rt_timeout_ms;
        double us0; { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); us0 = ts.tv_sec * 1e6 + ts.tv_nsec / 1e3; }
        if ((rc = afl_xfer(fd, lp, 4, 1, deadline)) != AFL_OK) goto fail;
        if ((rc = afl_xfer(fd, sbuf, sz, 1, deadline)) != AFL_OK) goto fail;
        uint8_t back[4];
        if ((rc = afl_xfer(fd, back, 4, 0, deadline)) != AFL_OK) goto fail;
        if (afl_get_be32(back) != (uint32_t)sz) { rc = AFL_LENGTH; goto fail; }
        if ((rc = afl_xfer(fd, rbuf, sz, 0, deadline)) != AFL_OK) goto fail;
        double us1; { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); us1 = ts.tv_sec * 1e6 + ts.tv_nsec / 1e3; }
        if (!afl_equal(rbuf, sz, (uint32_t)(i + 1))) { rc = AFL_CONTENT; goto fail; }   /* full compare, outside timing */
        if (i >= warm) us[i - warm] = us1 - us0;
        (void)t0;
    }
    qsort(us, iters, sizeof *us, afl_cmp_d);
    st->p50_us = us[iters / 2]; st->p90_us = us[(iters * 9) / 10]; st->min_us = us[0]; st->iters = iters;
    free(us); afl_restore(fd, saved); return AFL_OK;
fail:
    free(us); afl_restore(fd, saved); return rc;
}
static inline const char *afl_strerror(int rc) {
    switch (rc) { case AFL_OK: return "ok"; case AFL_IO: return "io error / peer closed"; case AFL_TIMEOUT: return "timeout";
        case AFL_LENGTH: return "echoed length mismatch"; case AFL_CONTENT: return "content mismatch"; case AFL_SETUP: return "setup"; default: return "range"; }
}
#endif
