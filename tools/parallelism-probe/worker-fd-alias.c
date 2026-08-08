/* enclave/SET repro: an fd from one thread must not ALIAS a different file on
 * another thread.
 *
 * Under SET the descriptor table is thread-local (component resource handles
 * are per-instance). Every thread used to allocate the lowest free index, so a
 * worker's fd 4 and the main thread's fd 4 were different files with the same
 * number -- while musl's `FILE` objects live in the SHARED linear memory and
 * stayed common. Passing an fd across threads therefore did not fail, it
 * silently wrote one thread's data into another thread's file, with every call
 * returning success.
 *
 *   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local \
 *       worker-fd-alias.c -o worker-fd-alias.wasm
 *   mkdir -p /tmp/fdalias && timeout 15 wasmtime run -W threads,\
 *       shared-everything-threads,component-model-threading,shared-memory \
 *       -S cli --dir /tmp/fdalias::/d worker-fd-alias.wasm
 *
 * Expected: "PASS: cross-thread fd rejected". "FAIL: ... aliased" means a
 * worker's descriptor was reachable from main under the same number.
 */
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>

static int worker_fd = -1;

static void *worker(void *arg) {
    (void)arg;
    worker_fd = open("/d/worker.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (worker_fd < 0) {
        perror("worker open");
        return 0;
    }
    printf("worker: opened /d/worker.txt as fd %d\n", worker_fd);
    fflush(stdout);
    return 0;
}

int main(void) {
    pthread_t t;
    if (pthread_create(&t, 0, worker, 0) != 0) {
        puts("spawn failed");
        return 1;
    }
    pthread_join(t, 0);
    if (worker_fd < 0)
        return 1;

    /* main opens its own file; without per-thread namespaces this lands on the
     * same small index the worker used. */
    int mine = open("/d/main.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    printf("main: opened /d/main.txt as fd %d\n", mine);

    ssize_t rc = write(worker_fd, "SECRET\n", 7);
    if (rc < 0) {
        printf("PASS: cross-thread fd rejected (write -> %s)\n", strerror(errno));
        return 0;
    }
    printf("FAIL: cross-thread fd %d aliased; wrote %zd bytes through it\n",
           worker_fd, rc);
    return 2;
}
