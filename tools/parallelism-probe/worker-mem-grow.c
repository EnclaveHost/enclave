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
 *
 * ASSERTED, not printed. This probe guards the tenant's PURCHASED RAM CEILING
 * and used to `return 0` whatever it measured -- so it would have reported
 * success on the very build whose bug it exists to catch (growth escaping the
 * cap entirely), and a human had to read the number to notice. The cap is
 * passed in, because a probe that hardcodes it silently stops testing anything
 * the day the platform changes it.
 *
 * Exit codes: 0 pass, 1 growth escaped the cap, 2 the runaway guard tripped
 * (no bound at all), 3 harness failure.
 */
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PAGE 65536

static int runaway = 0;

static long grow_until_refused(const char *who) {
    long pages = 0;
    for (;;) {
        if (__builtin_wasm_memory_grow(0, 1) == -1)
            break;
        pages++;
        if (pages > 40000) { /* 2.5 GiB; a runaway means no bound at all */
            runaway = 1;
            break;
        }
    }
    long bytes = (long)__builtin_wasm_memory_size(0) * PAGE;
    printf("%s: memory is now %ld bytes after %ld successful grows\n", who, bytes,
           pages);
    fflush(stdout);
    return bytes;
}

static long worker_bytes = 0;

static void *worker(void *arg) {
    (void)arg;
    worker_bytes = grow_until_refused("worker");
    return 0;
}

int main(void) {
    pthread_t t;
    /* The cap under test, in bytes: pass the SAME value as
       `-W max-memory-size`. Default matches the documented invocation. */
    const char *e = getenv("MAX_MEMORY_SIZE");
    long cap = e ? strtol(e, NULL, 0) : 16777216;
    long before = (long)__builtin_wasm_memory_size(0) * PAGE;
    printf("main: memory starts at %ld bytes\n", before);
    if (pthread_create(&t, 0, worker, 0) != 0) {
        fprintf(stderr, "FAIL(harness): spawn failed\n");
        return 3;
    }
    pthread_join(t, 0);
    long after = grow_until_refused("main");
    printf("RESULT: final=%ld bytes (cap %ld)\n", after, cap);

    if (runaway) {
        fprintf(stderr,
                "FAIL: grew past the runaway guard -- shared-memory growth is "
                "not bounded at all\n");
        return 2;
    }
    /* BOTH threads, because the bug was that a WORKER's growth escaped while
       main's was bounded. */
    if (worker_bytes > cap || after > cap) {
        fprintf(stderr,
                "FAIL: growth escaped the tenant's RAM ceiling -- worker "
                "reached %ld, main reached %ld, cap is %ld\n",
                worker_bytes, after, cap);
        return 1;
    }
    fprintf(stderr, "PASS: bounded at %ld bytes on both threads (cap %ld)\n",
            after, cap);
    return 0;
}
