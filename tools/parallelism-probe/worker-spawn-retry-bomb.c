/* enclave/SET repro: a guest that RETRIES a refused spawn must not cost the
 * node more than one that succeeds.
 *
 * `worker-spawn-churn.c` stops its chain at the first refusal, so it measures
 * how fast a guest gives up — not a bound. A chain that retries is the real
 * adversary, and against it a REFUSING rate limiter was actively harmful: a
 * refusal is far cheaper for the guest than a real spawn, so its threads spun
 * on the host call instead of exiting. Measured with the refusing limiter:
 * 50.3 CPU-seconds per 2 wall seconds (22.6 cores) versus 13.8 (6.2 cores)
 * with the limiter off — 3.6x WORSE than no limiter at all.
 *
 * Waiting for a token instead of refusing was tried and withdrawn: it moved
 * the cost from CPU to the EXECUTOR, blocking the tokio worker that polls the
 * guest's fiber, so under `wasmtime serve` the whole HTTP server stalled at
 * 0.00 CPU seconds -- invisible to `cpu.weight`, `cpu.max` and any CPU-based
 * watchdog. The limiter is now OFF by default and REFUSES when an operator
 * turns it on, so this probe measures what that opt-in costs rather than a
 * default. Run it with `ENCLAVE_MAX_SET_SPAWN_RATE=4096` to see the refusing
 * behaviour; with the default (0) it measures the unlimited baseline.
 *
 *   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local \
 *       worker-spawn-retry-bomb.c -o worker-spawn-retry-bomb.wasm
 *   time wasmtime run <SET flags> -S cli worker-spawn-retry-bomb.wasm
 *   time ENCLAVE_MAX_SET_SPAWN_RATE=0 wasmtime run ... (the unlimited control)
 *
 * Compare total CPU (user+sys), not just the creation count: the limiter must
 * not cost the node more than its absence.
 */
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <time.h>

static atomic_int made = 0;
static atomic_int stop = 0;

static void *chain(void *arg) {
    (void)arg;
    /* RETRY rather than give up: the shape that refutes a refusing limiter. */
    while (!atomic_load(&stop)) {
        pthread_t t;
        if (pthread_create(&t, 0, chain, 0) == 0) {
            pthread_detach(t);
            atomic_fetch_add(&made, 1);
            return 0;
        }
    }
    return 0;
}

int main(void) {
    for (int i = 0; i < 64; i++) {
        pthread_t t;
        if (pthread_create(&t, 0, chain, 0) == 0) pthread_detach(t);
    }
    struct timespec ts = {2, 0};
    nanosleep(&ts, 0);
    atomic_store(&stop, 1);
    printf("created %d threads in 2s\n", atomic_load(&made));
    fflush(stdout);
    return 0;
}
