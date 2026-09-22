/* linkbench.h -- the timed half of the link-scaling benchmark, kept separate so it can be TESTED.
 *
 * bench_ms announces a byte count on each participating link and reads exactly that many back, driving
 * all of them from one poll loop so the phases are comparable by makespan. It is pure with respect to the
 * lane: it never sees a masked row, draws no pad, and touches no engine state.
 *
 * It lives in a header because two of its failure modes were found by review rather than by running it,
 * and both are the kind that look like a hang rather than an error:
 *   - polling for POLLIN alone spins forever on a peer that hung up, since POLLHUP makes poll return
 *     immediately with no data and no error;
 *   - a peer that stays connected and sends nothing would wait out any single timeout;
 *   - and announcing with write() to a peer that had gone raised SIGPIPE, killing the payload outright
 *     rather than returning a failure. The announcement uses send(MSG_NOSIGNAL).
 * tpu/test/linkbench-test.c drives this exact code against both, plus a dead descriptor.
 */
#ifndef ANCHOR_LINKBENCH_H
#define ANCHOR_LINKBENCH_H
#include <errno.h>
#include <poll.h>
#include <stddef.h>
#include <time.h>
#include <sys/socket.h>
#include <unistd.h>

#ifndef LINKBENCH_OVERALL_MS
#define LINKBENCH_OVERALL_MS 120000.0
#endif
#ifndef LINKBENCH_PROGRESS_MS
#define LINKBENCH_PROGRESS_MS 20000.0
#endif

static double bench_ms(int *fd, int have, int k, size_t total) {
    const size_t per = total / (size_t)k;
    for (int i = 0; i < have; i++) {   /* the non-participating links are told zero so they do not block */
        const size_t want = (i < k) ? per : 0;
        unsigned char hdr[4] = { (unsigned char)(want & 255), (unsigned char)((want >> 8) & 255),
                                 (unsigned char)((want >> 16) & 255), (unsigned char)((want >> 24) & 255) };
        /* send(..., MSG_NOSIGNAL) rather than write(): announcing to a peer that has already gone must be
         * an error return, not a SIGPIPE that takes the whole payload down. */
        size_t o = 0;
        while (o < 4) {
            ssize_t w = send(fd[i], hdr + o, 4 - o, MSG_NOSIGNAL);
            if (w < 0 && errno == EINTR) continue;
            if (w <= 0) return -1;
            o += (size_t)w;
        }
    }
    /* the clock starts after the announcements, which are 4 bytes each: the senders start within microseconds */
    struct timespec t0, t1; clock_gettime(CLOCK_MONOTONIC, &t0);
    double last_progress = 0.0;
    size_t got[4] = { 0, 0, 0, 0 };
    static unsigned char buf[262144];
    for (;;) {
        struct pollfd pf[4]; int idx[4], n = 0;
        for (int i = 0; i < k; i++) if (got[i] < per) { pf[n].fd = fd[i]; pf[n].events = POLLIN; pf[n].revents = 0; idx[n] = i; n++; }
        if (!n) break;
        /* POLLIN alone is not enough: a peer that hangs up sets POLLHUP and poll then returns IMMEDIATELY,
         * forever, with no data and no error, which is an infinite spin rather than a failure. Terminal
         * events are handled, and two deadlines bound the whole thing -- one overall, one on PROGRESS, so
         * a peer that stays connected and sends nothing also ends the run. */
        const int pr = poll(pf, (nfds_t)n, 5000);
        if (pr < 0) { if (errno == EINTR) continue; return -1; }
        for (int j = 0; j < n; j++)
            if (pf[j].revents & (POLLERR | POLLNVAL)) return -1;
        int moved = 0;
        for (int j = 0; j < n; j++) {
            if (!(pf[j].revents & (POLLIN | POLLHUP))) continue;
            size_t want = per - got[idx[j]]; if (want > sizeof buf) want = sizeof buf;
            ssize_t r = read(pf[j].fd, buf, want);
            if (r == 0) return -1;                       /* the peer hung up before sending its share */
            if (r < 0) { if (errno == EINTR || errno == EAGAIN) continue; return -1; }
            got[idx[j]] += (size_t)r; moved = 1;
        }
        struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);
        const double since_start = (double)(now.tv_sec - t0.tv_sec) * 1000.0 + (double)(now.tv_nsec - t0.tv_nsec) / 1e6;
        if (since_start > LINKBENCH_OVERALL_MS) return -1;           /* overall deadline */
        if (moved) last_progress = since_start;
        else if (since_start - last_progress > LINKBENCH_PROGRESS_MS) return -1;   /* no progress deadline */
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    return (double)(t1.tv_sec - t0.tv_sec) * 1000.0 + (double)(t1.tv_nsec - t0.tv_nsec) / 1e6;
}


#endif
