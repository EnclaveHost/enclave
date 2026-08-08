/* enclave/SET repro: a compute-bound worker wedges host teardown forever and
 * pins a core, and `--wasm timeout` does NOT stop it.
 *
 * Nothing here is adversarial. It is an ordinary program that detaches a
 * compute thread and returns from main without joining it — which is exactly
 * what a worker pool, a background encoder, or a progress spinner does.
 *
 *   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local \
 *       worker-spin-teardown.c -o worker-spin-teardown.wasm
 *   timeout 15 wasmtime run -W threads,shared-everything-threads,\
 *       component-model-threading,shared-memory -S cli worker-spin-teardown.wasm
 *
 * Observed: main prints and returns, then the process hangs until SIGKILL
 * (exit 124). The main thread sits in `futex_do_wait` inside `Store::drop`'s
 * unconditional join while `set-thread-1` stays in state R, burning a core.
 *
 * Why the existing escape hatches miss it:
 *   - the teardown cancel flag is only read by the futex parking spot, and a
 *     busy loop never parks;
 *   - the worker epoch deadline is ENCLAVE_SET_EPOCH_TICKS (default 600)
 *     INCREMENTS, but `--wasm timeout` bumps the engine epoch exactly ONCE.
 *     That trips the main thread (deadline 1) and never a worker.
 *
 * Proof of the root cause, both with `-W timeout=2s`:
 *   ENCLAVE_SET_EPOCH_TICKS=1 ... -> exits at 2.0s, worker traps `interrupt`
 *   (default 600)            ... -> hangs, exit 124
 *
 * Under `wasmtime serve` a Store is created per request on a tokio worker, so
 * each occurrence permanently consumes a tokio worker and a core; the
 * process-global cap (4x cores) bounds it at 128 such workers per node.
 */
#include <pthread.h>
#include <stdio.h>
#include <time.h>

static void *spin(void *arg) {
    (void)arg;
    volatile unsigned long x = 0;
    for (;;) {
        x++;
    }
    return 0;
}

int main(void) {
    pthread_t t;
    if (pthread_create(&t, 0, spin, 0) != 0) {
        puts("spawn failed");
        return 1;
    }
    struct timespec ts = {0, 150 * 1000 * 1000};
    nanosleep(&ts, 0);
    printf("main returning WITHOUT join; worker still spinning\n");
    fflush(stdout);
    return 0; /* the engine joins at Store teardown -- and never returns */
}
