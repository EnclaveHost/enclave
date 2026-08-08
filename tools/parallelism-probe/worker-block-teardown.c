/* enclave/SET repro: a worker BLOCKED IN A HOST CALL must not hold teardown.
 *
 * The third stop path, and the one the other two miss: a worker asleep inside
 * a host call reaches no epoch check and is not parked in the engine's futex
 * spot, so neither the epoch nor the parking-spot poll touches it. Measured
 * before the fix: 12 s of guest-controlled host block against a 1 s embedder
 * timeout, at essentially zero CPU. Under `wasmtime serve` each occurrence
 * permanently consumes a tokio worker.
 *
 *   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local \
 *       worker-block-teardown.c -o worker-block-teardown.wasm
 *   time timeout 20 wasmtime run -W threads,shared-everything-threads,\
 *       component-model-threading,shared-memory -S cli worker-block-teardown.wasm
 *
 * Expected: exits in well under 12 s. The worker's guest future is dropped,
 * which is wasmtime's own cancellation path.
 */
#include <pthread.h>
#include <stdio.h>
#include <time.h>

static void *sleeper(void *arg) {
    (void)arg;
    struct timespec ts = {12, 0};
    nanosleep(&ts, 0);
    puts("worker: slept the full 12s (teardown waited for me)");
    fflush(stdout);
    return 0;
}

int main(void) {
    pthread_t t;
    if (pthread_create(&t, 0, sleeper, 0) != 0) return 1;
    struct timespec ts = {0, 100 * 1000 * 1000};
    nanosleep(&ts, 0);
    puts("main: returning without join; worker is asleep in a host call");
    fflush(stdout);
    return 0;
}
