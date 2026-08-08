/* enclave/SET repro: a DEAD thread's fd must not become a LIVE thread's fd.
 *
 * An earlier fix tagged each fd with the owning thread's namespace but drew
 * that namespace from a recycled slot bitmap. Recycling is deterministic, so
 * the next worker inherited the dead one's tag and its stale fds became valid
 * again, naming different objects at the same index — the exact silent
 * cross-thread aliasing the tagging exists to prevent, just one thread-exit
 * later. Namespaces are now monotonic.
 *
 *   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local \
 *       worker-fd-recycle.c -o worker-fd-recycle.wasm
 *   wasmtime run <SET flags> -S cli --dir /tmp/d::/d worker-fd-recycle.wasm
 *
 * Expected: "PASS". "FAIL" means the dead thread's fd wrote into the live
 * thread's file.
 */
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int dead_fd = -1;

static void *first(void *arg) {
    (void)arg;
    dead_fd = open("/d/first.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    printf("thread1: /d/first.txt is fd %d (then this thread exits)\n", dead_fd);
    fflush(stdout);
    return 0;
}

static int result = 0;

static void *second(void *arg) {
    (void)arg;
    int mine = open("/d/second.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    printf("thread2: /d/second.txt is fd %d\n", mine);
    fflush(stdout);
    ssize_t rc = write(dead_fd, "SECRET\n", 7);
    if (rc < 0) {
        printf("PASS: thread1's fd %d is not valid here (%s)\n", dead_fd,
               strerror(errno));
        result = 0;
    } else {
        printf("FAIL: thread1's fd %d aliased thread2's namespace (wrote %zd)\n",
               dead_fd, rc);
        result = 2;
    }
    return 0;
}

int main(void) {
    pthread_t t;
    if (pthread_create(&t, 0, first, 0) != 0) return 1;
    pthread_join(t, 0);
    if (dead_fd < 0) return 1;
    if (pthread_create(&t, 0, second, 0) != 0) return 1;
    pthread_join(t, 0);
    return result;
}
