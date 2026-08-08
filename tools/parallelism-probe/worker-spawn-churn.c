/* enclave/SET repro: the live-thread cap does not bound thread CREATION.
 *
 * `ENCLAVE_MAX_SET_THREADS` is a CONCURRENCY bound: increment on spawn,
 * decrement on exit. A worker that spawns its successor and then returns keeps
 * the live count at 1-2 forever, so the cap is never reached and no spawn is
 * ever refused — while the process creates and destroys OS threads at the
 * kernel's maximum rate. Thread creation is a NODE-WIDE cost, so that is a
 * noisy-neighbour denial of service against every other tenant on the box.
 *
 * Measured before the fix: ~35,900 create+exit pairs in 1.5s, ~0.9 of a core
 * burnt in clone/exit, and `ENCLAVE_MAX_SET_THREADS=4` made no difference.
 *
 *   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local \
 *       worker-spawn-churn.c -o worker-spawn-churn.wasm
 *   time timeout 10 wasmtime run <SET flags> -S cli worker-spawn-churn.wasm
 *
 * Expected now: the chain stops at the creation-rate limit
 * (`ENCLAVE_MAX_SET_SPAWN_RATE`), the guest sees pthread_create fail with
 * EAGAIN, and it reports how many it got.
 */
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <time.h>

static atomic_int spawned = 0;
static atomic_int done = 0;

static void *chain(void *arg) {
    (void)arg;
    pthread_t t;
    /* spawn a successor, then RETURN: live count never rises. */
    if (pthread_create(&t, 0, chain, 0) == 0) {
        pthread_detach(t);
        atomic_fetch_add(&spawned, 1);
    } else {
        atomic_store(&done, 1);
    }
    return 0;
}

int main(void) {
    pthread_t t;
    if (pthread_create(&t, 0, chain, 0) != 0) return 1;
    pthread_detach(t);
    struct timespec ts = {2, 0};
    nanosleep(&ts, 0);
    printf("spawned %d threads in 2s (chain stopped: %d)\n",
           atomic_load(&spawned), atomic_load(&done));
    fflush(stdout);
    return 0;
}
