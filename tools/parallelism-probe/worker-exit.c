/* enclave/SET repro: `exit()` on a WORKER must end the component, not wedge it.
 *
 * POSIX says `exit()` on any thread ends the process, and a component instance
 * IS the process here. Before the fix a worker's `exit()` ran the guest's
 * atexit handlers (whose `__stdio_exit` poisons every FILE lock), surfaced to
 * the host as a per-thread trap on the worker's own store, and left the main
 * thread parked in `pthread_join` forever -- the process then had to be killed.
 *
 *   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local \
 *       worker-exit.c -o worker-exit.wasm
 *   timeout 15 wasmtime run -W threads,shared-everything-threads,\
 *       component-model-threading,shared-memory -S cli worker-exit.wasm; echo $?
 *
 * Expected: exits promptly with status 7. A hang (124) is the old behaviour.
 */
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static void *worker(void *arg) {
    (void)arg;
    printf("worker: calling exit(7)\n");
    fflush(stdout);
    exit(7);
    return 0;
}

int main(void) {
    pthread_t t;
    if (pthread_create(&t, 0, worker, 0) != 0) {
        puts("spawn failed");
        return 1;
    }
    /* The joiner the old behaviour stranded. */
    pthread_join(t, 0);
    printf("main: joined -- exit() did NOT end the component\n");
    fflush(stdout);
    return 0;
}
