/* enclave/SET repro: a FAILED `get_read_stream`/`get_write_stream` must not
 * leave the object's lock held.
 *
 * The round-5 fix gave the wasip2 stream metadata a `lock` field so the CALLER
 * could release what the producer took — but `file_get_read_stream` and
 * `file_get_write_stream` also `return -1` on their own error path, six lines
 * ABOVE where the field is set, with the lock still held and no handle for the
 * caller to release it with. (`tcp_get_read_stream` already unlocked on its
 * failure path; these two did not.)
 *
 * Reached by the most ordinary spelling there is: opening a DIRECTORY and
 * reading it. `read-via-stream` fails with `bad-descriptor` before any stream
 * exists, and from then on every read/write/poll/lseek/close on that fd blocks
 * forever — as does the thread's own exit, which re-locks in `file_free`.
 * Invisible single-threaded (`__lock()` is a no-op while `libc.need_locks` is
 * 0) and permanent from the first `pthread_create`.
 *
 *   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local \
 *       worker-dir-io-lock.c -o worker-dir-io-lock.wasm
 *   timeout 15 wasmtime run <SET flags> -S cli --dir /tmp/d::/d worker-dir-io-lock.wasm
 *
 * Expected: "PASS". A hang (exit 124) is the old behaviour.
 */
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <unistd.h>

static void *idle(void *a) { (void)a; struct timespec t={3,0}; nanosleep(&t,0); return 0; }

int main(void) {
    pthread_t t;
    if (pthread_create(&t, 0, idle, 0) != 0) { puts("spawn failed"); return 1; }

    char buf[16];
    int fd = open("/d", O_RDONLY);
    if (fd < 0) { puts("could not open the directory"); return 1; }
    (void)read(fd, buf, sizeof buf);      /* fails; used to leak the lock */
    (void)write(fd, buf, 1);              /* same on the write side */
    (void)lseek(fd, 0, SEEK_SET);         /* used to block */
    close(fd);                            /* used to block */

    /* And through stdio, which is how a program actually meets this. */
    FILE *f = fopen("/d", "r");
    if (f) { (void)fread(buf, 1, sizeof buf, f); fclose(f); }

    puts("PASS: a failed stream lookup released the object lock");
    fflush(stdout);
    pthread_join(t, 0);
    return 0;
}
