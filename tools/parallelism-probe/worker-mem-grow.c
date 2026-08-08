/* enclave/SET: `-W max-memory-size` must bound a SHARED memory's growth, from
 * any thread.
 *
 * Upstream's `SharedMemory::grow` passes no `ResourceLimiter`, so shared-memory
 * growth escaped `-W max-memory-size` entirely -- measured: ~124 MB reached
 * under a 16 MiB cap. On this platform that flag IS the tenant's purchased RAM
 * ceiling, and the SET toolchain links every guest with
 * `--max-memory=1073741824`, so without this an ordinary SET tenant could grow
 * to 1 GiB whatever it paid for.
 *
 *   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local \
 *       worker-mem-grow.c -o worker-mem-grow.wasm
 *   wasmtime run -W threads,shared-everything-threads,component-model-threading,\
 *       shared-memory -W max-memory-size=16777216 -S cli worker-mem-grow.wasm
 *
 * Expected: growth stops at or below the cap, on BOTH threads.
 */
#include <pthread.h>
#include <stdio.h>

#define PAGE 65536

static long grow_until_refused(const char *who) {
    long pages = 0;
    for (;;) {
        if (__builtin_wasm_memory_grow(0, 1) == -1)
            break;
        pages++;
        if (pages > 40000) /* 2.5 GiB; a runaway means no bound at all */
            break;
    }
    long bytes = (long)__builtin_wasm_memory_size(0) * PAGE;
    printf("%s: memory is now %ld bytes after %ld successful grows\n", who, bytes,
           pages);
    fflush(stdout);
    return bytes;
}

static void *worker(void *arg) {
    (void)arg;
    grow_until_refused("worker");
    return 0;
}

int main(void) {
    pthread_t t;
    long before = (long)__builtin_wasm_memory_size(0) * PAGE;
    printf("main: memory starts at %ld bytes\n", before);
    if (pthread_create(&t, 0, worker, 0) != 0) {
        puts("spawn failed");
        return 1;
    }
    pthread_join(t, 0);
    long after = grow_until_refused("main");
    printf("RESULT: final=%ld bytes\n", after);
    return 0;
}
