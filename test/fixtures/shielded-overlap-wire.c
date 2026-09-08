/* Exercise the real framing with a peer that cannot answer before the work
 * callback releases it. A misplaced callback therefore times out in the runner. */
static int zero_write;
#define writev test_writev
#include "../../wasm/ggml-shielded/shielded-wire.c"
#undef writev
ssize_t writev(int fd, const struct iovec *iov, int count);
ssize_t test_writev(int fd, const struct iovec *iov, int count) {
    if (zero_write) { zero_write = 0; return 0; }
    return writev(fd, iov, count);
}
#include <assert.h>
#include <pthread.h>
#include <signal.h>
#include <math.h>

typedef struct { int fd, ready, release, count, mode, cmd; } peer;
typedef struct { int ready, release, calls; pthread_t caller; int delay; } work;

static void send_bytes(int fd, const void *data, size_t size) {
    struct iovec iov = { (void *)data, size };
    assert(write_all(fd, &iov, 1) == SH_OK);
}

static void *serve(void *arg) {
    peer *p = arg;
    for (int i = 0; i < p->count; i++) {
        uint8_t h[9], payload[5];
        assert(read_all(p->fd, h, sizeof h) == SH_OK);
        assert(h[0] == p->cmd && get_u64(h + 1) == sizeof payload);
        assert(read_all(p->fd, payload, sizeof payload) == SH_OK);
        assert(!memcmp(payload, "hello", 5));
    }
    send_bytes(p->ready, "r", 1);
    char release;
    assert(read_all(p->release, &release, 1) == SH_OK && release == 'w');
    if (p->mode == 4) usleep(15000);
    for (int i = 0; i < p->count; i++) {
        uint8_t h[9] = {0};
        h[0] = p->mode == 1;
        put_u64(h + 1, p->mode == 2 ? SH_MAX_FRAME + 1 : 5);
        send_bytes(p->fd, h, p->mode == 3 ? 4 : sizeof h);
        if (p->mode == 2 || p->mode == 3) break;
        if (p->mode == 4) usleep(125000);
        send_bytes(p->fd, "reply", 5);
        if (p->mode) break;
    }
    close(p->fd);
    return NULL;
}

static void do_work(void *arg) {
    work *w = arg;
    assert(pthread_equal(pthread_self(), w->caller));
    w->calls++;
    char ready;
    assert(read_all(w->ready, &ready, 1) == SH_OK && ready == 'r');
    if (w->delay) usleep(10000);
    send_bytes(w->release, "w", 1);
}

static void run_case(int count, int mode) {
    int sockets[2], ready[2], release[2];
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    assert(pipe(ready) == 0 && pipe(release) == 0);
    sh_pipe *p = calloc(1, sizeof *p); assert(p); p->fd = sockets[0];
    const int cmd = mode == 4 ? SH_CMD_FIELD_GEMM24 : 42;
    if (mode == 4) setenv("SHIELDED_PROFILE", "1", 1);
    peer server = { sockets[1], ready[1], release[0], count, mode, cmd };
    work w = { ready[0], release[1], 0, pthread_self(), mode == 4 };
    pthread_t thread; assert(pthread_create(&thread, NULL, serve, &server) == 0);
    sh_frame frames[20]; sh_reply replies[20];
    for (int i = 0; i < count; i++) frames[i] = (sh_frame){cmd, "hel", 3, "lo", 2};
    int rc = sh_pipe_exchange_work(p, frames, count, replies, do_work, &w);
    assert(w.calls == 1);
    assert(rc == (mode == 0 || mode == 4 ? SH_OK : mode == 1 ? SH_ERR_VIOLATION : mode == 2 ? SH_ERR_PROTO : SH_ERR_IO));
    for (int i = 0; i < count; i++) {
        if (!mode || mode == 4) assert(replies[i].len == 5 && !memcmp(replies[i].data, "reply", 5));
        else assert(replies[i].data == NULL && replies[i].len == 0);
    }
    pthread_join(thread, NULL);
    sh_wire_timing timing; sh_pipe_wire_timing(p, &timing);
    if (mode == 4) {
        assert(timing.calls == 1 && timing.request_bytes == 14 && timing.reply_bytes == 14);
        assert(timing.work_ms >= 8 && timing.header_ms >= 10 && timing.body_ms >= 100);
        assert(timing.max_ms >= 130 && timing.over_100ms == 1);
        assert(fabs(timing.max_ms - (timing.write_ms + timing.work_ms + timing.header_ms + timing.body_ms)) < 0.01);
        unsetenv("SHIELDED_PROFILE");
    } else assert(timing.calls == 0);
    sh_pipe_close(p);
    close(ready[0]); close(ready[1]); close(release[0]); close(release[1]);
}

int main(void) {
    signal(SIGPIPE, SIG_IGN);
    for (int mode = 0; mode < 4; mode++) { run_case(1, mode); run_case(20, mode); }
    run_case(1, 4);
    int sockets[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    sh_pipe *p = calloc(1, sizeof *p); assert(p); p->fd = sockets[0];
    work w = { -1, -1, 0, pthread_self(), 0 };
    sh_frame f = {42, "hello", 5, NULL, 0}; sh_reply r;
    assert(sh_pipe_exchange_work(p, &f, 0, &r, do_work, &w) == SH_OK && w.calls == 0);
    zero_write = 1;
    assert(sh_pipe_exchange_work(p, &f, 1, &r, do_work, &w) == SH_ERR_IO && w.calls == 0 && zero_write == 0);
    struct iovec empty = { NULL, 0 }; assert(write_all(p->fd, &empty, 1) == SH_OK);
    close(sockets[1]);
    assert(sh_pipe_exchange_work(p, &f, 1, &r, do_work, &w) == SH_ERR_IO && w.calls == 0);
    assert(sh_pipe_exchange_work(NULL, &f, 1, &r, do_work, &w) == SH_ERR_IO && w.calls == 0);
    sh_pipe_close(p);
}
