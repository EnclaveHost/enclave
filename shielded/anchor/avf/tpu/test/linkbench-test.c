/* linkbench-test.c -- the link-scaling benchmark's failure and ordering behaviour, on socketpairs.
 *
 * The benchmark exists to answer whether the protected-VM boundary serialises or scales per connection.
 * Before any number it produces can be believed, it has to fail correctly, because two ways it could
 * fail silently were found by review rather than by running it:
 *
 *   1. It polled for POLLIN only. A peer that hangs up sets POLLHUP, and poll then returns IMMEDIATELY,
 *      forever, with no data and no error -- an infinite spin that looks like a hang, not a failure.
 *   2. Its links were opened on the WORKER port, alongside the real TPU worker. The app starts both sets
 *      of threads at once and the real worker loads 35 graphs before it dials, so accept ORDER could not
 *      tell the roles apart: a benchmark link could have been handed to the lane as the worker. That is
 *      fixed by giving the benchmark its own port, which is what this test's ordering case pins.
 *
 * bench_ms is compiled from the payload here by including it behind a guard, so this tests the shipped
 * function and not a copy of it.
 *
 *   cc -std=c11 -O1 -fsanitize=address,undefined tpu/test/linkbench-test.c -o /tmp/linkbench-test && /tmp/linkbench-test
 */
#include <errno.h>
#include <signal.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define LINKBENCH_TEST 1
#include "../../payload/linkbench.h"

static int fails = 0;
static void ck(const char *what, int ok, const char *detail) {
    printf("%-46s %s%s%s\n", what, ok ? "ok" : "FAIL", detail && *detail ? "  -- " : "", detail ? detail : "");
    if (!ok) fails++;
}

/* a peer that answers announcements honestly */
static void *good_peer(void *arg) {
    int fd = *(int *)arg;
    unsigned char hdr[4]; static unsigned char buf[65536];
    for (;;) {
        size_t o = 0;
        while (o < 4) { ssize_t r = read(fd, hdr + o, 4 - o); if (r <= 0) return NULL; o += (size_t)r; }
        size_t n = (size_t)hdr[0] | ((size_t)hdr[1] << 8) | ((size_t)hdr[2] << 16) | ((size_t)hdr[3] << 24);
        while (n) { size_t w = n > sizeof buf ? sizeof buf : n; ssize_t r = write(fd, buf, w); if (r <= 0) return NULL; n -= (size_t)r; }
    }
}
/* a peer that reads its announcement and then hangs up: the POLLHUP spin */
static void *hangup_peer(void *arg) {
    int fd = *(int *)arg; unsigned char hdr[4]; size_t o = 0;
    while (o < 4) { ssize_t r = read(fd, hdr + o, 4 - o); if (r <= 0) break; o += (size_t)r; }
    close(fd); return NULL;
}
/* a peer that stays connected and never sends: the progress deadline */
static void *silent_peer(void *arg) {
    int fd = *(int *)arg; unsigned char hdr[4]; size_t o = 0;
    while (o < 4) { ssize_t r = read(fd, hdr + o, 4 - o); if (r <= 0) break; o += (size_t)r; }
    struct timespec ts = { 40, 0 }; nanosleep(&ts, NULL); (void)fd; return NULL;
}

int main(void) {
    signal(SIGPIPE, SIG_IGN);   /* the hostile peers close mid-write on purpose */
    const size_t SMALL = 1u << 20;

    {   /* both peers honest: the transfer completes and reports a positive time */
        int a[2], b[2]; socketpair(AF_UNIX, SOCK_STREAM, 0, a); socketpair(AF_UNIX, SOCK_STREAM, 0, b);
        pthread_t ta, tb; pthread_create(&ta, NULL, good_peer, &a[1]); pthread_create(&tb, NULL, good_peer, &b[1]);
        int fd[2] = { a[0], b[0] };
        double one = bench_ms(fd, 2, 1, SMALL), two = bench_ms(fd, 2, 2, SMALL);
        ck("honest peers: one link completes", one >= 0, NULL);
        ck("honest peers: two links complete", two >= 0, NULL);
        close(a[0]); close(b[0]); pthread_join(ta, NULL); pthread_join(tb, NULL); close(a[1]); close(b[1]);
    }
    {   /* one peer hangs up: must RETURN a failure, not spin on POLLHUP */
        int a[2], b[2]; socketpair(AF_UNIX, SOCK_STREAM, 0, a); socketpair(AF_UNIX, SOCK_STREAM, 0, b);
        pthread_t ta, tb; pthread_create(&ta, NULL, good_peer, &a[1]); pthread_create(&tb, NULL, hangup_peer, &b[1]);
        int fd[2] = { a[0], b[0] };
        struct timespec s, e; clock_gettime(CLOCK_MONOTONIC, &s);
        double r = bench_ms(fd, 2, 2, SMALL);
        clock_gettime(CLOCK_MONOTONIC, &e);
        double ms = (double)(e.tv_sec - s.tv_sec) * 1000.0 + (double)(e.tv_nsec - s.tv_nsec) / 1e6;
        char d[80]; snprintf(d, sizeof d, "returned %.0f after %.0f ms", r, ms);
        ck("a peer that hangs up fails rather than spins", r < 0 && ms < 30000.0, d);
        close(a[0]); close(b[0]); pthread_join(ta, NULL); pthread_join(tb, NULL); close(a[1]);
    }
    {   /* a peer that never sends: the progress deadline must end it */
        int a[2], b[2]; socketpair(AF_UNIX, SOCK_STREAM, 0, a); socketpair(AF_UNIX, SOCK_STREAM, 0, b);
        pthread_t ta, tb; pthread_create(&ta, NULL, good_peer, &a[1]); pthread_create(&tb, NULL, silent_peer, &b[1]);
        int fd[2] = { a[0], b[0] };
        struct timespec s, e; clock_gettime(CLOCK_MONOTONIC, &s);
        double r = bench_ms(fd, 2, 2, SMALL);
        clock_gettime(CLOCK_MONOTONIC, &e);
        double ms = (double)(e.tv_sec - s.tv_sec) * 1000.0 + (double)(e.tv_nsec - s.tv_nsec) / 1e6;
        char d[80]; snprintf(d, sizeof d, "returned %.0f after %.0f ms", r, ms);
        ck("a silent peer hits the progress deadline", r < 0 && ms < 35000.0, d);
        close(a[0]); close(b[0]); pthread_join(ta, NULL); pthread_join(tb, NULL); close(a[1]); close(b[1]);
    }
    {   /* a closed descriptor: POLLNVAL/POLLERR must be a failure, not a spin */
        int a[2]; socketpair(AF_UNIX, SOCK_STREAM, 0, a);
        pthread_t ta; pthread_create(&ta, NULL, good_peer, &a[1]);
        int dead[2]; socketpair(AF_UNIX, SOCK_STREAM, 0, dead); close(dead[0]); close(dead[1]);
        int fd[2] = { a[0], dead[0] };
        double r = bench_ms(fd, 2, 2, SMALL);
        ck("a dead descriptor fails", r < 0, NULL);
        close(a[0]); pthread_join(ta, NULL); close(a[1]);
    }
    printf("\n%d failure(s)\n", fails);
    return fails ? 1 : 0;
}
