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
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>
#include <stdio.h>
#ifdef __ANDROID__
#include <android/log.h>
#endif
static uint64_t prof_ns(clockid_t id) { struct timespec t={0}; clock_gettime(id,&t); return (uint64_t)t.tv_sec*1000000000+t.tv_nsec; }
static int prof_usage(uint64_t *user, uint64_t *system) {
    struct rusage r;
    if (getrusage(RUSAGE_THREAD, &r)) return 0;
    *user=(uint64_t)r.ru_utime.tv_sec*1000000000+(uint64_t)r.ru_utime.tv_usec*1000;
    *system=(uint64_t)r.ru_stime.tv_sec*1000000000+(uint64_t)r.ru_stime.tv_usec*1000;
    return 1;
}
static void prof_report(uint64_t *v) {
    char line[1400];
    snprintf(line,sizeof line,"BRIDGE_SP mono=%llu realtime=%llu dt=%llu cpu=%llu poll_empty=%llu poll_up=%llu poll_down=%llu poll_both=%llu read_guest=%llu read_host=%llu write_host=%llu write_guest=%llu up=%llu down=%llu queued_up=%llu queued_down=%llu cpu_read_guest=%llu cpu_read_host=%llu cpu_write_host=%llu cpu_write_guest=%llu cpu_poll=%llu cpu_user=%llu cpu_system=%llu usage_available=%llu",
        (unsigned long long)v[0],(unsigned long long)prof_ns(CLOCK_REALTIME),(unsigned long long)v[1],(unsigned long long)v[2],(unsigned long long)v[3],(unsigned long long)v[4],(unsigned long long)v[5],(unsigned long long)v[6],(unsigned long long)v[7],(unsigned long long)v[8],(unsigned long long)v[9],(unsigned long long)v[10],(unsigned long long)v[11],(unsigned long long)v[12],(unsigned long long)v[13],(unsigned long long)v[14],(unsigned long long)v[15],(unsigned long long)v[16],(unsigned long long)v[17],(unsigned long long)v[18],(unsigned long long)v[19],(unsigned long long)v[20],(unsigned long long)v[21],(unsigned long long)v[22]);
#ifdef __ANDROID__
    __android_log_print(ANDROID_LOG_INFO,"anchor-bridge","%s",line);
#else
    fprintf(stderr,"%s\n",line);
#endif
}

typedef struct { uint8_t *buf; size_t cap, head, used, write_max; int src_eof, dst_shut; } bridge_dir;

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
    size_t span = d->used < d->cap - d->head ? d->used : d->cap - d->head;
    if (d->write_max && span > d->write_max) span = d->write_max;
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
    return anchor_bridge_run_profile(a,b,cancel_fd,idle_ms,buf_bytes,st,0);
}
int anchor_bridge_run_profile(int a, int b, int cancel_fd, int idle_ms, size_t buf_bytes, anchor_bridge_stats *st, int profile) {
    return anchor_bridge_run_profile_limit(a,b,cancel_fd,idle_ms,buf_bytes,st,profile,0);
}
int anchor_bridge_run_profile_limit(int a, int b, int cancel_fd, int idle_ms, size_t buf_bytes, anchor_bridge_stats *st, int profile, size_t a_write_max) {
    uint64_t pv[23]={0}, pt=0, pc=0, pu=0, pd=0, user0=0, system0=0;
    int usage_ok=0;
    if (profile) { pt=prof_ns(CLOCK_MONOTONIC); pc=prof_ns(CLOCK_THREAD_CPUTIME_ID); usage_ok=prof_usage(&user0,&system0); }
    anchor_bridge_stats s; memset(&s, 0, sizeof s);
    if (a < 0 || b < 0 || a == b || cancel_fd == a || cancel_fd == b || (a_write_max != 0 && a_write_max != 4096)) { if (st) { s.status = -EINVAL; *st = s; } return -EINVAL; }
    if (!is_stream_socket(a) || !is_stream_socket(b)) { if (st) { s.status = -ENOTSOCK; *st = s; } return -ENOTSOCK; }
    if (buf_bytes < 4096) buf_bytes = 1u << 20;
    bridge_dir ab, ba; memset(&ab, 0, sizeof ab); memset(&ba, 0, sizeof ba);
    ab.buf = (uint8_t *)malloc(buf_bytes); ba.buf = (uint8_t *)malloc(buf_bytes);
    int fa = -1, fb = -1, rc;
    if (!ab.buf || !ba.buf) { rc = -ENOMEM; goto out; }
    ab.cap = ba.cap = buf_bytes;
    /* The phone's virtio-vsock send path kmallocs a contiguous packet buffer.
     * An opt-in 4 KiB cap tests the measured direct-compaction cost without
     * changing TCP packet sizing, stream contents, or queue capacity. */
    ba.write_max = a_write_max;
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
        uint64_t p0=profile?prof_ns(CLOCK_MONOTONIC):0;
        uint64_t c0=profile?prof_ns(CLOCK_THREAD_CPUTIME_ID):0;
        unsigned bucket=(ab.used?1:0)+(ba.used?2:0);
        const int r = poll(p, n, wait); s.polls++;
        if (profile) { pv[3+bucket]+=prof_ns(CLOCK_MONOTONIC)-p0; pv[19]+=prof_ns(CLOCK_THREAD_CPUTIME_ID)-c0; }
        if (r < 0) { if (errno == EINTR) continue; rc = -errno; break; }   /* EINTR: the deadline stands, not restarted */
        if (r == 0) { rc = -ETIMEDOUT; break; }
        if (ic >= 0 && p[ic].revents) { rc = -ECANCELED; break; }
        if ((ia >= 0 && (p[ia].revents & POLLNVAL)) || (ib >= 0 && (p[ib].revents & POLLNVAL))) { rc = -EBADF; break; }
        const short ra = ia >= 0 ? p[ia].revents : 0, rb = ib >= 0 ? p[ib].revents : 0;
        const uint64_t before = s.reads + s.writes;
        if(profile) { p0=prof_ns(CLOCK_MONOTONIC); c0=prof_ns(CLOCK_THREAD_CPUTIME_ID); }
        if ((rc = pump_read(a, &ab, ra, &s)) != 0) break;
        if(profile) { uint64_t p1=prof_ns(CLOCK_MONOTONIC),c1=prof_ns(CLOCK_THREAD_CPUTIME_ID);pv[7]+=p1-p0;pv[15]+=c1-c0;p0=p1;c0=c1; }
        if ((rc = pump_read(b, &ba, rb, &s)) != 0) break;
        if(profile) { uint64_t p1=prof_ns(CLOCK_MONOTONIC),c1=prof_ns(CLOCK_THREAD_CPUTIME_ID);pv[8]+=p1-p0;pv[16]+=c1-c0;p0=p1;c0=c1; }
        if ((rc = pump_write(b, &ab, rb | (ab.used > 0 ? POLLOUT : 0), &s, &s.a_to_b)) != 0) break;
        if(profile) { uint64_t p1=prof_ns(CLOCK_MONOTONIC),c1=prof_ns(CLOCK_THREAD_CPUTIME_ID);pv[9]+=p1-p0;pv[17]+=c1-c0;p0=p1;c0=c1; }
        if ((rc = pump_write(a, &ba, ra | (ba.used > 0 ? POLLOUT : 0), &s, &s.b_to_a)) != 0) break;
        if(profile) {
            uint64_t p1=prof_ns(CLOCK_MONOTONIC); pv[10]+=p1-p0;pv[18]+=prof_ns(CLOCK_THREAD_CPUTIME_ID)-c0;
            if (p1-pt>=250000000) {
                uint64_t c1=prof_ns(CLOCK_THREAD_CPUTIME_ID); pv[0]=p1;pv[1]=p1-pt;pv[2]=c1-pc;
                pv[11]=s.a_to_b-pu;pv[12]=s.b_to_a-pd;pv[13]=ab.used;pv[14]=ba.used;
                uint64_t u=0,k=0;int ok=prof_usage(&u,&k);pv[22]=usage_ok&&ok;
                if(pv[22]) { pv[20]=u-user0;pv[21]=k-system0; }
                prof_report(pv);memset(pv,0,sizeof pv);pt=p1;pc=c1;pu=s.a_to_b;pd=s.b_to_a;
                user0=u;system0=k;usage_ok=ok;
            }
        }
        if (ab.src_eof && ab.used == 0 && !ab.dst_shut) { half_close(b); ab.dst_shut = 1; }
        if (ba.src_eof && ba.used == 0 && !ba.dst_shut) { half_close(a); ba.dst_shut = 1; }
        if (idle_ms > 0 && s.reads + s.writes != before) deadline = mono_ms() + idle_ms;   /* progress, and only progress, extends it */
    }
out:
    if(profile) { /* Keep the final partial interval, including cancellation/EOF. */
        uint64_t p1=prof_ns(CLOCK_MONOTONIC),c1=prof_ns(CLOCK_THREAD_CPUTIME_ID),u=0,k=0;
        int ok=prof_usage(&u,&k);pv[0]=p1;pv[1]=p1-pt;pv[2]=c1-pc;
        pv[11]=s.a_to_b-pu;pv[12]=s.b_to_a-pd;pv[13]=ab.used;pv[14]=ba.used;pv[22]=usage_ok&&ok;
        if(pv[22]) { pv[20]=u-user0;pv[21]=k-system0; }
        prof_report(pv);
    }
    restore_flags(a, fa); restore_flags(b, fb);
    free(ab.buf); free(ba.buf);
    s.status = rc; if (st) *st = s;
    return rc;
}

#ifdef __ANDROID__
#include <jni.h>
JNIEXPORT jint JNICALL Java_host_enclave_anchor_avf_NativeBridge_run(JNIEnv *env, jclass klass, jint a, jint b, jint cancel, jint idleMs, jboolean profile, jint guestWriteMax, jlongArray stats) {
    (void)klass;
    anchor_bridge_stats s; const int rc = anchor_bridge_run_profile_limit(a, b, cancel, idleMs, 0, &s, profile, (size_t)guestWriteMax);
    if (stats && (*env)->GetArrayLength(env, stats) >= 6) {
        jlong v[6] = { (jlong)s.a_to_b, (jlong)s.b_to_a, (jlong)s.reads, (jlong)s.writes, (jlong)s.polls, (jlong)s.max_chunk };
        (*env)->SetLongArrayRegion(env, stats, 0, 6, v);
    }
    return rc;
}
#endif
