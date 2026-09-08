/* Native worker bridge (opt-in, --ez nativebridge true): the app's Java pump copies every 64 KiB
 * chunk kernel -> temporary -> Java heap -> temporary -> kernel with two JNI transitions; this loop
 * is a single poll()-driven thread with one bounded buffer per direction and plain read/send.
 *
 * Contract:
 *  - never closes, dups or otherwise takes ownership of a, b or cancel_fd; O_NONBLOCK is set for the
 *    run and the original flags are restored on every exit path;
 *  - circular buffers reuse consumed space without compacting pending bytes;
 *  - backpressure: a side is only read when its direction's buffer has room, only written when it
 *    has data; the buffers never grow (buf_bytes each);
 *  - partial reads/writes are handled; EINTR and EAGAIN return to poll so
 *    cancellation and the no-progress deadline are checked between attempts;
 *  - EOF on a source, once everything buffered has reached the sink, half-closes the sink
 *    (shutdown SHUT_WR; a non-socket sink is left alone); the other direction keeps flowing;
 *    the run ends when both directions are drained and shut;
 *  - cancellation: cancel_fd readable or hung up ends the run with -ECANCELED after the current
 *    syscall; nothing is drained further (the caller is tearing down);
 *  - idle_ms > 0: no readiness for that long ends the run with -ETIMEDOUT;
 *  - a write error on a sink (EPIPE, ECONNRESET, ...) ends the run with -errno, like the Java
 *    pump's exception: the caller closes both and reconnects; SIGPIPE is never raised
 *    (MSG_NOSIGNAL; only stream sockets are accepted, anything else is -ENOTSOCK up front, so no
 *    write() path exists). The socket is only ever touched from this thread.
 *  - the idle timeout is a monotonic no-PROGRESS deadline: it advances only when bytes move, so a
 *    signal storm (EINTR) or a descriptor that stays "ready" without delivering anything cannot
 *    defer it. */
#define _GNU_SOURCE
#include "native-bridge.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

typedef struct { uint8_t *buf; size_t cap, head, used; int src_eof, dst_shut; } bridge_dir;

static int set_nonblock(int fd, int *saved) {
    const int fl = fcntl(fd, F_GETFL);
    if (fl < 0) return -errno;
    *saved = fl;
    if (!(fl & O_NONBLOCK) && fcntl(fd, F_SETFL, fl | O_NONBLOCK) < 0) return -errno;
    return 0;
}
static void restore_flags(int fd, int saved) { if (saved >= 0) (void)fcntl(fd, F_SETFL, saved); }

/* read from fd into d while there is room; 0 = fine (including nothing to do), -errno = failure */
static int pump_read(int fd, bridge_dir *d, short revents, anchor_bridge_stats *s) {
    if (d->src_eof || !(revents & (POLLIN | POLLHUP | POLLERR))) return 0;
    if (d->used == d->cap) return 0;
    const size_t tail = (d->head + d->used) % d->cap;
    const size_t room = d->cap - d->used < d->cap - tail ? d->cap - d->used : d->cap - tail;
    for (;;) {
        const ssize_t n = read(fd, d->buf + tail, room);
        if (n > 0) { d->used += (size_t)n; s->reads++; if ((uint64_t)n > s->max_chunk) s->max_chunk = (uint64_t)n; return 0; }
        if (n == 0) { d->src_eof = 1; return 0; }
        if (errno == EINTR) return 0;   /* outer loop checks cancel and the idle deadline */
        if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
        return -errno;
    }
}
/* write d's pending bytes to fd; partial writes advance head; 0 = fine, -errno = the sink is gone */
static int pump_write(int fd, bridge_dir *d, short revents, anchor_bridge_stats *s, uint64_t *delivered) {
    if (d->used == 0 || d->dst_shut || !(revents & (POLLOUT | POLLHUP | POLLERR))) return 0;
    const size_t span = d->used < d->cap - d->head ? d->used : d->cap - d->head;
    for (;;) {
        const ssize_t n = send(fd, d->buf + d->head, span, MSG_NOSIGNAL | MSG_DONTWAIT);
        if (n > 0) {
            d->head = (d->head + (size_t)n) % d->cap; d->used -= (size_t)n; s->writes++; *delivered += (uint64_t)n;
            if (d->used == 0) d->head = 0;
            return 0;
        }
        if (n == 0) return -EIO;
        if (errno == EINTR) return 0;   /* do not retry indefinitely inside the pump */
        if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
        return -errno;
    }
}
static void half_close(int fd) { (void)shutdown(fd, SHUT_WR); }   /* ENOTCONN: already gone, nothing to half-close */
static int is_stream_socket(int fd) { int t = 0; socklen_t l = sizeof t; return getsockopt(fd, SOL_SOCKET, SO_TYPE, &t, &l) == 0 && t == SOCK_STREAM; }
static int64_t mono_ms(void) { struct timespec ts; if (clock_gettime(CLOCK_MONOTONIC, &ts)) return 0; return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000; }

int anchor_bridge_run(int a, int b, int cancel_fd, int idle_ms, size_t buf_bytes, anchor_bridge_stats *st) {
    anchor_bridge_stats s; memset(&s, 0, sizeof s);
    if (a < 0 || b < 0 || a == b || cancel_fd == a || cancel_fd == b) { if (st) { s.status = -EINVAL; *st = s; } return -EINVAL; }
    if (!is_stream_socket(a) || !is_stream_socket(b)) { if (st) { s.status = -ENOTSOCK; *st = s; } return -ENOTSOCK; }
    if (buf_bytes < 4096) buf_bytes = 1u << 20;
    bridge_dir ab, ba; memset(&ab, 0, sizeof ab); memset(&ba, 0, sizeof ba);
    ab.buf = (uint8_t *)malloc(buf_bytes); ba.buf = (uint8_t *)malloc(buf_bytes);
    int fa = -1, fb = -1, rc;
    if (!ab.buf || !ba.buf) { rc = -ENOMEM; goto out; }
    ab.cap = ba.cap = buf_bytes;
    if ((rc = set_nonblock(a, &fa)) != 0 || (rc = set_nonblock(b, &fb)) != 0) goto out;
    int64_t deadline = idle_ms > 0 ? mono_ms() + idle_ms : 0;
    for (;;) {
        struct pollfd p[3]; int n = 0, ia = -1, ib = -1, ic = -1; short ea = 0, eb = 0;
        if (!ab.src_eof && ab.used < ab.cap) ea |= POLLIN;       /* a is readable into ab only with room */
        if (ba.used > 0 && !ba.dst_shut) ea |= POLLOUT;   /* a is written only with pending ba */
        if (!ba.src_eof && ba.used < ba.cap) eb |= POLLIN;
        if (ab.used > 0 && !ab.dst_shut) eb |= POLLOUT;
        if (ea) { p[n].fd = a; p[n].events = ea; p[n].revents = 0; ia = n++; }
        if (eb) { p[n].fd = b; p[n].events = eb; p[n].revents = 0; ib = n++; }
        if (cancel_fd >= 0) { p[n].fd = cancel_fd; p[n].events = POLLIN; p[n].revents = 0; ic = n++; }
        if (ia < 0 && ib < 0) { rc = 0; break; }   /* both directions drained and shut: done */
        int wait = -1;
        if (idle_ms > 0) { const int64_t left = deadline - mono_ms(); if (left <= 0) { rc = -ETIMEDOUT; break; } wait = left > INT32_MAX ? INT32_MAX : (int)left; }
        const int r = poll(p, n, wait); s.polls++;
        if (r < 0) { if (errno == EINTR) continue; rc = -errno; break; }   /* EINTR: the deadline stands, not restarted */
        if (r == 0) { rc = -ETIMEDOUT; break; }
        if (ic >= 0 && p[ic].revents) { rc = -ECANCELED; break; }
        if ((ia >= 0 && (p[ia].revents & POLLNVAL)) || (ib >= 0 && (p[ib].revents & POLLNVAL))) { rc = -EBADF; break; }
        const short ra = ia >= 0 ? p[ia].revents : 0, rb = ib >= 0 ? p[ib].revents : 0;
        const uint64_t before = s.reads + s.writes;
        if ((rc = pump_read(a, &ab, ra, &s)) != 0) break;
        if ((rc = pump_read(b, &ba, rb, &s)) != 0) break;
        if ((rc = pump_write(b, &ab, rb | (ab.used > 0 ? POLLOUT : 0), &s, &s.a_to_b)) != 0) break;
        if ((rc = pump_write(a, &ba, ra | (ba.used > 0 ? POLLOUT : 0), &s, &s.b_to_a)) != 0) break;
        if (ab.src_eof && ab.used == 0 && !ab.dst_shut) { half_close(b); ab.dst_shut = 1; }
        if (ba.src_eof && ba.used == 0 && !ba.dst_shut) { half_close(a); ba.dst_shut = 1; }
        if (idle_ms > 0 && s.reads + s.writes != before) deadline = mono_ms() + idle_ms;   /* progress, and only progress, extends it */
    }
out:
    restore_flags(a, fa); restore_flags(b, fb);
    free(ab.buf); free(ba.buf);
    s.status = rc; if (st) *st = s;
    return rc;
}

#ifdef __ANDROID__
#include <jni.h>
JNIEXPORT jint JNICALL Java_host_enclave_anchor_avf_NativeBridge_run(JNIEnv *env, jclass klass, jint a, jint b, jint cancel, jint idleMs, jlongArray stats) {
    (void)klass;
    anchor_bridge_stats s; const int rc = anchor_bridge_run(a, b, cancel, idleMs, 0, &s);
    if (stats && (*env)->GetArrayLength(env, stats) >= 6) {
        jlong v[6] = { (jlong)s.a_to_b, (jlong)s.b_to_a, (jlong)s.reads, (jlong)s.writes, (jlong)s.polls, (jlong)s.max_chunk };
        (*env)->SetLongArrayRegion(env, stats, 0, 6, v);
    }
    return rc;
}
#endif
