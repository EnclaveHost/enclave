/* enclave/SET repro: TWO file I/O operations must not deadlock once a second
 * thread exists.
 *
 * `file_get_read_stream`/`file_get_write_stream` (and the TCP pair) take the
 * object's lock and the CALLER must release it. The p2 shape of `wasi_read_t`
 * had nowhere to carry that lock, so the release was deleted rather than
 * replaced. It is invisible single-threaded — `__lock()` returns immediately
 * while `libc.need_locks == 0` — and becomes a permanent hold the moment the
 * first `pthread_create` sets it. The SECOND read or write on any file or
 * socket then blocks forever.
 *
 * Every earlier probe missed it because stdio's `get_*_stream` takes no lock,
 * so `printf`-only workers were fine.
 *
 *   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local \
 *       worker-file-io.c -o worker-file-io.wasm
 *   timeout 15 wasmtime run <SET flags> -S cli --dir /tmp/d::/d worker-file-io.wasm
 *
 * Expected: "PASS: N writes, M reads". A hang (exit 124) is the old behaviour.
 */
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static void *idle(void *arg) {
    (void)arg;
    struct timespec ts = {3, 0};
    nanosleep(&ts, 0);
    return 0;
}

int main(void) {
    pthread_t t;
    /* A live sibling is all it takes: libc.need_locks becomes 1. */
    if (pthread_create(&t, 0, idle, 0) != 0) { puts("spawn failed"); return 1; }

    int fd = open("/d/io.txt", O_RDWR | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) { perror("open"); return 1; }
    int writes = 0, reads = 0;
    for (int i = 0; i < 4; i++) {
        if (write(fd, "hello\n", 6) == 6) writes++;   /* #2 used to hang */
        fflush(stdout);
    }
    lseek(fd, 0, SEEK_SET);
    char buf[8];
    for (int i = 0; i < 4; i++) {
        if (read(fd, buf, 6) == 6) reads++;           /* #2 used to hang */
    }
    close(fd);
    printf("PASS: %d writes, %d reads\n", writes, reads);
    fflush(stdout);
    pthread_join(t, 0);
    return (writes == 4 && reads == 4) ? 0 : 2;
}
