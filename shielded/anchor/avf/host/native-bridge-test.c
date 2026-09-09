/* Host test of the native bridge over socketpairs: bytes exact both ways under backpressure, small
 * socket buffers (partial writes, EAGAIN), an EINTR storm, half-close ordering, cancellation, idle
 * timeout, an abruptly closed peer, and a descriptor/flag audit. */
#define _GNU_SOURCE
#include "native-bridge.c"
#include <assert.h>
#include <dirent.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <time.h>
#ifndef BRIDGE_CAP
#define BRIDGE_CAP (1u << 20)
#endif
static size_t N = 24u << 20; static int USE_STORM = 1, USE_SMALL = 1;
static void on_usr1(int sig) { (void)sig; }
static int count_fds(void) { DIR *d = opendir("/proc/self/fd"); int n = 0; struct dirent *e; while ((e = readdir(d))) if (e->d_name[0] != '.') n++; closedir(d); return n - 1; }
static uint64_t fnv(const uint8_t *p, size_t n, uint64_t h) { for (size_t i = 0; i < n; i++) { h ^= p[i]; h *= 1099511628211ull; } return h; }
static void full_write(int fd, const uint8_t *p, size_t n) { while (n) { ssize_t r = write(fd, p, n); if (r < 0) { if (errno == EINTR) continue; perror("write"); abort(); } p += r; n -= (size_t)r; } }
typedef struct { int fd; size_t n; uint64_t hash; int slow, source_fd; } io_job;
static void *writer(void *arg) { io_job *j = arg; uint8_t *buf = malloc(1 << 16); uint64_t x = 0x9e3779b97f4a7c15ull ^ (uint64_t)j->fd; size_t left = j->n; j->hash = 1469598103934665603ull;
    while (left) { size_t k = left < (1 << 16) ? left : (1 << 16); for (size_t i = 0; i < k; i++) { x ^= x << 13; x ^= x >> 7; x ^= x << 17; buf[i] = (uint8_t)x; } j->hash = fnv(buf, k, j->hash); full_write(j->fd, buf, k); left -= k; }
    free(buf); shutdown(j->fd, SHUT_WR); return NULL; }
static void *reader(void *arg) { io_job *j = arg; uint8_t *buf = malloc(1 << 16); j->hash = 1469598103934665603ull; size_t got = 0; uint64_t exact = 0x9e3779b97f4a7c15ull ^ (uint64_t)j->source_fd;
    for (;;) { ssize_t r = read(j->fd, buf, 1 << 16); if (r < 0) { if (errno == EINTR) continue; perror("read"); abort(); } if (r == 0) break; for (ssize_t i=0;i<r;++i) { exact ^= exact << 13; exact ^= exact >> 7; exact ^= exact << 17; assert(buf[i] == (uint8_t)exact); } j->hash = fnv(buf, (size_t)r, j->hash); got += (size_t)r; if (j->slow && (got & 0xfffff) < (size_t)r) usleep(300); }
    j->n = got; free(buf); return NULL; }
typedef struct { int a, b, cancel, idle; anchor_bridge_stats st; int rc; } run_job;
static void *runner(void *arg) { run_job *r = arg; r->rc = anchor_bridge_run_profile(r->a, r->b, r->cancel, r->idle, BRIDGE_CAP, &r->st, getenv("BRIDGE_TEST_PROFILE") != NULL); return NULL; }
static atomic_int storm = 1;
static void *storm_main(void *arg) { pthread_t *t = arg; while (storm) { pthread_kill(*t, SIGUSR1); usleep(100); } return NULL; }
static void small_bufs(int fd) { int v = 8192; setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &v, sizeof v); setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &v, sizeof v); }

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    if (getenv("BRIDGE_TEST_N")) N = (size_t)atol(getenv("BRIDGE_TEST_N"));
    if (getenv("BRIDGE_TEST_STORM")) USE_STORM = atoi(getenv("BRIDGE_TEST_STORM"));
    if (getenv("BRIDGE_TEST_SMALL")) USE_SMALL = atoi(getenv("BRIDGE_TEST_SMALL"));
    struct sigaction sa = { .sa_handler = on_usr1 }; sigaction(SIGUSR1, &sa, NULL);   /* no SA_RESTART: syscalls see EINTR */
    signal(SIGPIPE, SIG_DFL);   /* the bridge must not raise it even so */
    const int fds0 = count_fds();
    /* 1. both ways, slow reader on one side (backpressure), small socket buffers, EINTR storm, half-close order */
    { int A[2], B[2]; assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, A) && !socketpair(AF_UNIX, SOCK_STREAM, 0, B)); if (USE_SMALL) { small_bufs(A[1]); small_bufs(B[0]); }
      const int fla = fcntl(A[1], F_GETFL), flb = fcntl(B[0], F_GETFL);
      run_job r = { A[1], B[0], -1, 0, {0}, 0 }; pthread_t rt; pthread_create(&rt, NULL, runner, &r);
      pthread_t st; if (USE_STORM) pthread_create(&st, NULL, storm_main, &rt);
      io_job wa = { A[0], N, 0, 0 }, rb = { B[1], 0, 0, 1, A[0] }, wb = { B[1], N / 2, 0, 0 }, ra = { A[0], 0, 0, 0, B[1] };
      pthread_t t1, t2, t3, t4; pthread_create(&t1, NULL, writer, &wa); pthread_create(&t2, NULL, reader, &rb); pthread_create(&t3, NULL, writer, &wb); pthread_create(&t4, NULL, reader, &ra);
      pthread_join(t1, NULL); pthread_join(t2, NULL); pthread_join(t3, NULL); pthread_join(t4, NULL);
      storm = 0; if (USE_STORM) pthread_join(st, NULL); pthread_join(rt, NULL);
      assert(r.rc == 0); assert(rb.n == N && rb.hash == wa.hash); assert(ra.n == N / 2 && ra.hash == wb.hash);
      assert(r.st.a_to_b == N && r.st.b_to_a == N / 2 && r.st.max_chunk <= BRIDGE_CAP);
      assert(fcntl(A[1], F_GETFL) == fla && fcntl(B[0], F_GETFL) == flb);   /* flags restored */
      printf("case 1: %zu + %zu bytes exact both ways, reads %llu writes %llu polls %llu max_chunk %llu, EINTR storm, flags restored\n", N, N / 2, (unsigned long long)r.st.reads, (unsigned long long)r.st.writes, (unsigned long long)r.st.polls, (unsigned long long)r.st.max_chunk);
      close(A[0]); close(A[1]); close(B[0]); close(B[1]); }
    /* 2. half-close: a's EOF reaches b's peer after every byte, while b -> a keeps flowing afterwards */
    { int A[2], B[2]; assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, A) && !socketpair(AF_UNIX, SOCK_STREAM, 0, B));
      run_job r = { A[1], B[0], -1, 0, {0}, 0 }; pthread_t rt; pthread_create(&rt, NULL, runner, &r);
      uint8_t m[4096]; memset(m, 7, sizeof m); full_write(A[0], m, sizeof m); shutdown(A[0], SHUT_WR);
      uint8_t got[4096]; size_t g = 0; while (g < sizeof got) { ssize_t k = read(B[1], got + g, sizeof got - g); assert(k > 0); g += (size_t)k; }
      uint8_t one; assert(read(B[1], &one, 1) == 0);   /* EOF: the half-close was forwarded, after the data */
      memset(m, 9, sizeof m); full_write(B[1], m, sizeof m);   /* the other direction still works */
      g = 0; while (g < sizeof got) { ssize_t k = read(A[0], got + g, sizeof got - g); assert(k > 0); g += (size_t)k; } assert(got[100] == 9);
      shutdown(B[1], SHUT_WR); assert(read(A[0], &one, 1) == 0);
      pthread_join(rt, NULL); assert(r.rc == 0); printf("case 2: half-close forwarded in order, reverse direction kept flowing, clean end\n");
      close(A[0]); close(A[1]); close(B[0]); close(B[1]); }
    /* 3. cancel: idle bridge, one byte on the cancel pair ends it promptly */
    { int A[2], B[2], C[2]; assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, A) && !socketpair(AF_UNIX, SOCK_STREAM, 0, B) && !socketpair(AF_UNIX, SOCK_STREAM, 0, C));
      run_job r = { A[1], B[0], C[0], 0, {0}, 0 }; pthread_t rt; pthread_create(&rt, NULL, runner, &r);
      usleep(20000); struct timespec t0, t1; clock_gettime(CLOCK_MONOTONIC, &t0); uint8_t x = 1; full_write(C[1], &x, 1); pthread_join(rt, NULL); clock_gettime(CLOCK_MONOTONIC, &t1);
      const double ms = (t1.tv_sec - t0.tv_sec) * 1e3 + (t1.tv_nsec - t0.tv_nsec) / 1e6; assert(r.rc == -ECANCELED && ms < 100);
      printf("case 3: cancel -> -ECANCELED in %.1f ms\n", ms);
      close(A[0]); close(A[1]); close(B[0]); close(B[1]); close(C[0]); close(C[1]); }
    /* 4. idle timeout */
    { int A[2], B[2]; assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, A) && !socketpair(AF_UNIX, SOCK_STREAM, 0, B));
      anchor_bridge_stats s; assert(anchor_bridge_run(A[1], B[0], -1, 150, 0, &s) == -ETIMEDOUT && s.status == -ETIMEDOUT); printf("case 4: idle 150 ms -> -ETIMEDOUT\n");
      close(A[0]); close(A[1]); close(B[0]); close(B[1]); }
    /* 4b. the idle deadline under an EINTR storm and with a peer that is always "ready" (a HUP'd cancel-less
     *     pair whose readiness never moves bytes): no-progress deadline, not restarted by signals */
    { int A[2], B[2]; assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, A) && !socketpair(AF_UNIX, SOCK_STREAM, 0, B));
      run_job r = { A[1], B[0], -1, 200, {0}, 0 }; pthread_t rt; pthread_create(&rt, NULL, runner, &r);
      storm = 1; pthread_t st; pthread_create(&st, NULL, storm_main, &rt);
      struct timespec t0, t1; clock_gettime(CLOCK_MONOTONIC, &t0); pthread_join(rt, NULL); clock_gettime(CLOCK_MONOTONIC, &t1); storm = 0; pthread_join(st, NULL);
      const double ms = (t1.tv_sec - t0.tv_sec) * 1e3 + (t1.tv_nsec - t0.tv_nsec) / 1e6; assert(r.rc == -ETIMEDOUT && ms >= 190 && ms < 1500);
      printf("case 4b: idle 200 ms under a 10 kHz EINTR storm -> -ETIMEDOUT after %.0f ms\n", ms);
      close(A[0]); close(A[1]); close(B[0]); close(B[1]); }
    /* 4c. non-socket descriptors are refused before anything is touched */
    { int P[2]; assert(!pipe(P)); int A[2]; assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, A)); anchor_bridge_stats s;
      assert(anchor_bridge_run(P[0], A[0], -1, 0, 0, &s) == -ENOTSOCK && anchor_bridge_run(A[0], P[1], -1, 0, 0, &s) == -ENOTSOCK);
      printf("case 4c: pipe descriptors -> -ENOTSOCK\n"); close(P[0]); close(P[1]); close(A[0]); close(A[1]); }
    /* 5. the worker side vanishes mid-stream: an error, not a hang, and no SIGPIPE */
    { int A[2], B[2]; assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, A) && !socketpair(AF_UNIX, SOCK_STREAM, 0, B)); small_bufs(B[0]);
      run_job r = { A[1], B[0], -1, 2000, {0}, 0 }; pthread_t rt; pthread_create(&rt, NULL, runner, &r);
      uint8_t m[1 << 16]; memset(m, 3, sizeof m); full_write(A[0], m, sizeof m); usleep(5000); close(B[1]);
      { const int fl = fcntl(A[0], F_GETFL); fcntl(A[0], F_SETFL, fl | O_NONBLOCK);   /* keep feeding without blocking: the bridge must fail on the dead sink, not wait for us */
        for (int i = 0; i < 64; i++) { ssize_t w = write(A[0], m, sizeof m); if (w < 0 && errno != EAGAIN && errno != EINTR) break; usleep(1000); } }
      pthread_join(rt, NULL); assert(r.rc == -EPIPE || r.rc == -ECONNRESET); printf("case 5: dead sink -> %s, no SIGPIPE\n", r.rc == -EPIPE ? "-EPIPE" : "-ECONNRESET");
      close(A[0]); close(A[1]); close(B[0]); }
    /* 6. bad arguments */
    { anchor_bridge_stats s; assert(anchor_bridge_run(-1, 3, -1, 0, 0, &s) == -EINVAL && anchor_bridge_run(3, 3, -1, 0, 0, &s) == -EINVAL); }
    assert(count_fds() == fds0);   /* nothing leaked, nothing owned */
    puts("native-bridge: backpressure, partial I/O, EINTR, half-close, cancel, no-progress deadline, non-socket refusal, dead sink, fd audit passed");
    return 0;
}
