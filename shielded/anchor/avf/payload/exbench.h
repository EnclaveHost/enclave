/* exbench.h -- the exchange-SHAPED transport benchmark: request/reply round trips over the real VM<->app vsock, sized
 * like the masked lane's exchanges, with no TPU, no mask, no pads.
 *
 * Why: speculation (several token rows per exchange) is the only structure that could amortise the lane's per-exchange
 * floor, and it measured no net gain because every extra row cost ~2.2 ms of link (results/draft1: 1 row 5.4-5.6 ms,
 * ~4 rows 11.6-12.4 ms). That is ~32 KB per row at ~14.5 MB/s, while a one-way bulk stream over the SAME boundary reached
 * 82-165 MB/s (TPU.md, "Does the protected-VM boundary scale per connection?"). Whether the per-row slope belongs to
 * the TRANSPORT or to the worker's and VM's per-row work decides whether rows can ever be cheap; this measures the
 * transport alone.
 *
 * Wire, on a BENCHMARK link (never the worker link, never a masked row): the VM sends a u32 (reply bytes | 1<<31), a
 * u32 (request bytes) and the request; the app reads the request whole, then writes the reply. One round trip each.
 * A failed round trip abandons the whole benchmark (a stream with bytes in flight cannot be resynchronised), and
 * every wait is bounded by poll() so a silent or departed peer returns an error instead of a hang.
 */
#ifndef ANCHOR_EXBENCH_H
#define ANCHOR_EXBENCH_H
#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#ifndef EXBENCH_WAIT_MS
#define EXBENCH_WAIT_MS 5000
#endif

typedef struct { int n; double min_ms, med_ms, p90_ms, mean_ms; } exbench_stat;

static double exb_now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }

static int exb_send_all(int fd, const unsigned char *p, size_t n) {
    size_t o = 0;
    while (o < n) {
        ssize_t w = send(fd, p + o, n - o, MSG_NOSIGNAL);
        if (w < 0 && errno == EINTR) continue;
        if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            struct pollfd q = { fd, POLLOUT, 0 }; if (poll(&q, 1, EXBENCH_WAIT_MS) <= 0 || (q.revents & (POLLERR | POLLHUP | POLLNVAL))) return -1;
            continue;
        }
        if (w <= 0) return -1;
        o += (size_t)w;
    }
    return 0;
}

/* waitall: one recv(MSG_WAITALL) per poll wake instead of read()s of whatever has arrived. *reads counts the calls. */
static int exb_recv_all(int fd, unsigned char *p, size_t n, int waitall, long *reads) {
    size_t o = 0;
    while (o < n) {
        struct pollfd q = { fd, POLLIN, 0 };
        int pr = poll(&q, 1, EXBENCH_WAIT_MS);
        if (pr < 0 && errno == EINTR) continue;
        if (pr <= 0) return -1;                                             /* silent peer: bounded */
        if (!(q.revents & POLLIN)) return -1;                               /* hung up with nothing to read */
        ssize_t r = recv(fd, p + o, n - o, waitall ? MSG_WAITALL : 0);
        if (reads) (*reads)++;
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) return -1;
        o += (size_t)r;
    }
    return 0;
}

static int exb_cmp(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : x > y; }

/* iters round trips of (req -> rep). gap_us of busy work before each (the lane's VM does ~0.6-0.9 ms of its own work
 * between exchanges, and whether the far side has gone idle by then is part of what is being measured). Returns 0 and
 * fills *st, or -1 (the benchmark must be abandoned). */
static int exbench_run(int fd, size_t req, size_t rep, int iters, int gap_us, int waitall, exbench_stat *st, long *reads) {
    if (iters <= 0 || iters > 10000 || req > (64u << 20) || rep > (64u << 20) || rep >= (1u << 31)) return -1;
    unsigned char *q = (unsigned char *)malloc(8 + req), *r = (unsigned char *)malloc(rep ? rep : 1);
    double *t = (double *)malloc(sizeof(double) * (size_t)iters);
    if (!q || !r || !t) { free(q); free(r); free(t); return -1; }
    const uint32_t h0 = (uint32_t)rep | 0x80000000u, h1 = (uint32_t)req;
    memcpy(q, &h0, 4); memcpy(q + 4, &h1, 4); memset(q + 8, 0x5a, req);
    int rc = 0;
    for (int i = 0; i < iters; i++) {
        if (gap_us > 0) { const double e = exb_now_ms() + gap_us / 1000.0; while (exb_now_ms() < e) { } }
        const double a = exb_now_ms();
        if (exb_send_all(fd, q, 8 + req) != 0 || exb_recv_all(fd, r, rep, waitall, reads) != 0) { rc = -1; break; }
        t[i] = exb_now_ms() - a;
    }
    if (rc == 0) {
        double s = 0; for (int i = 0; i < iters; i++) s += t[i];
        qsort(t, (size_t)iters, sizeof *t, exb_cmp);
        st->n = iters; st->min_ms = t[0]; st->med_ms = t[iters / 2]; st->p90_ms = t[(iters * 9) / 10]; st->mean_ms = s / iters;
    }
    free(q); free(r); free(t);
    return rc;
}
#endif
