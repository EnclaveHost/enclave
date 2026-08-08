/* enclave/SET repro: a thread whose preopen table cannot be built must not
 * leak HOST resources on every retry.
 *
 * `__wasilibc_populate_preopens` used to `_Exit(EX_SOFTWARE)` on failure. Making
 * it RETURN (so one thread's exhaustion stops killing the component) turned a
 * fail-fast into an unbounded host leak: `filesystem_preopens_get_directories`
 * mints one host resource handle PER PREOPEN every call, the failure path
 * dropped none of them, and `preopens_populated` stayed false so every later
 * path call re-entered. N-1 host table slots per call, invisible to the tenant
 * RAM gate, until wasmtime's resource table filled at 1e6 and the guest trapped
 * inside `get_directories` — silently, with exit status 0. Measured 179 MB of
 * host RSS for 140,000 failed opens.
 *
 * Needs N >= 2 preopens and a LONG-LIVED thread that keeps retrying, which is
 * why the short-lived `worker-ns-exhaust.c` could not see it.
 *
 *   wasmtime run <SET flags> -S cli --dir /tmp/a::/d --dir /tmp/b::/d1 ... \
 *     worker-preopen-retry.wasm
 *
 * Expected: the worker reports its failures and main joins it. Watch the host's
 * VmHWM: it must stay flat.
 */
#include <fcntl.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <unistd.h>

static atomic_int burned = 0;

static void *burn(void *a) { (void)a; int fd = open("/d", O_RDONLY);
  if (fd < 0) atomic_fetch_add(&burned, 1); else close(fd); return 0; }

static void *longlived(void *a) {
    (void)a;
    int ok = 0, bad = 0;
    for (int i = 0; i < 200000; i++) {
        int fd = open("/d/f.txt", O_WRONLY | O_CREAT, 0644);
        if (fd < 0) bad++; else { ok++; close(fd); }
    }
    fprintf(stderr, "worker: ok=%d bad=%d (survived %d retries)\n", ok, bad, ok + bad);
    return 0;
}

int main(void) {
    /* burn the namespaces */
    for (int i = 0; i < 262200; i++) {
        pthread_t t;
        if (pthread_create(&t, 0, burn, 0) == 0) pthread_join(t, 0);
    }
    pthread_t w;
    if (pthread_create(&w, 0, longlived, 0) != 0) return 1;
    pthread_join(w, 0);
    fprintf(stderr, "PASS: component survived a retrying thread with no preopens\n");
    return 0;
}
