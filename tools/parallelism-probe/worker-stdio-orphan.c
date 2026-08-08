/* enclave/SET repro: a worker that traps while holding a FILE lock must not
 * wedge stdio for every other thread.
 *
 * musl registers a FILE on the thread's `stdio_locks` list only from the
 * EXPLICIT locking API (`flockfile`/`ftrylockfile`). The internal `FLOCK` path
 * that every `printf` takes did not, so `__do_orphaned_stdio_locks` walked a
 * list the FILE was never on, `f->lock` kept the dead thread's tid, and every
 * later `printf` on any thread -- stderr included -- blocked in `__futexwait`
 * for good.
 *
 * This trips it the way an ordinary program would: the worker traps between
 * `flockfile` and `funlockfile`, i.e. holding the lock the whole time.
 *
 *   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local \
 *       worker-stdio-orphan.c -o worker-stdio-orphan.wasm
 *   timeout 15 wasmtime run -W threads,shared-everything-threads,\
 *       component-model-threading,shared-memory -S cli worker-stdio-orphan.wasm
 *
 * Expected: "main: stdout still works after the orphan". A hang is the old
 * behaviour.
 */
#include <pthread.h>
#include <stdio.h>
#include <time.h>

static void *worker(void *arg) {
    (void)arg;
    flockfile(stdout);           /* hold it, then die without releasing */
    fputs("worker: holding stdout's lock, about to trap\n", stdout);
    fflush(stdout);
    __builtin_trap();
    funlockfile(stdout);
    return 0;
}

int main(void) {
    pthread_t t;
    if (pthread_create(&t, 0, worker, 0) != 0) return 1;
    pthread_join(t, 0);
    printf("main: stdout still works after the orphan\n");
    fflush(stdout);
    return 0;
}
