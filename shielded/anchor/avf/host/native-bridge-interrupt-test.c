/* Deterministic syscall interruptions: retrying inside read/send must not
 * prevent the bridge from observing cancellation or its idle deadline. */
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>

static int fault_fd, fault_send, cancel_writer, fault_calls;
static ssize_t interrupted_read(int fd, void *buf, size_t n);
static ssize_t interrupted_send(int fd, const void *buf, size_t n, int flags);
#define read interrupted_read
#define send interrupted_send
#include "native-bridge.c"
#undef read
#undef send

static ssize_t interrupt_call(void) {
    if (++fault_calls == 1 && cancel_writer >= 0)
        assert(shutdown(cancel_writer, SHUT_WR) == 0);
    errno = EINTR;
    return -1;
}
static ssize_t interrupted_read(int fd, void *buf, size_t n) {
    if (fd == fault_fd && !fault_send) return interrupt_call();
    return read(fd, buf, n);
}
static ssize_t interrupted_send(int fd, const void *buf, size_t n, int flags) {
    if (fd == fault_fd && fault_send) return interrupt_call();
    return send(fd, buf, n, flags);
}

static void check(int on_send, int cancel) {
    int a[2], b[2], c[2];
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, a) == 0);
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, b) == 0);
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, c) == 0);
    const int fa = fcntl(a[1], F_GETFL), fb = fcntl(b[0], F_GETFL);
    assert(fa >= 0 && fb >= 0);
    /* Keep the source readable, or queue a byte for the interrupted send. */
    const unsigned char byte = 42;
    assert(write(a[0], &byte, 1) == 1);
    fault_fd = on_send ? b[0] : a[1];
    fault_send = on_send;
    cancel_writer = cancel ? c[1] : -1;
    fault_calls = 0;
    const int64_t start = mono_ms();
    anchor_bridge_stats stats;
    const int rc = anchor_bridge_run(a[1], b[0], cancel ? c[0] : -1,
                                    cancel ? 0 : 50, 4096, &stats);
    const int64_t elapsed = mono_ms() - start;
    assert(rc == (cancel ? -ECANCELED : -ETIMEDOUT));
    assert(stats.status == rc && fault_calls > 0);
    assert(elapsed < 1000 && (cancel || elapsed >= 50));
    assert(stats.a_to_b == 0 && stats.b_to_a == 0);
    assert(fcntl(a[1], F_GETFL) == fa && fcntl(b[0], F_GETFL) == fb);
    for (int i = 0; i < 2; ++i) { close(a[i]); close(b[i]); close(c[i]); }
    printf("%s EINTR: %s observed in %lld ms\n", on_send ? "send" : "read",
           cancel ? "cancel" : "idle deadline", (long long)elapsed);
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    /* A regression in the inner retry loops must fail, not hang the suite. */
    alarm(3);
    for (int on_send = 0; on_send < 2; ++on_send)
        for (int cancel = 0; cancel < 2; ++cancel) check(on_send, cancel);
    alarm(0);
    puts("native-bridge: interrupted read/send preserve deadline and cancellation PASS");
    return 0;
}
