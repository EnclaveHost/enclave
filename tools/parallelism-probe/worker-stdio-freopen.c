// enclave/SET probe: a failed `freopen` on a worker must not wedge the shared
// stdout for every other thread.
//
// THE BUG THIS REGRESSION-TESTS. `freopen(path, "w", stdout)` on a worker
// cannot do what POSIX says: it has to renumber the new descriptor onto fd 1,
// and under per-thread descriptor namespaces a worker may not redirect the
// shared standard streams. So the renumber fails -- correctly. What was NOT
// correct is `freopen`'s failure path, which is `fclose(f)`: it closed the
// SHARED `stdout` out from under every thread, leaving a dead `FILE` on
// `__ofl` with `F_ERR` stuck for the life of the component.
//
// Measured on the round-7/round-8 libc:
//
//     freopen ret=NULL   <- correct
//     worker printf      -> -1, ferror(stdout) == 1
//     main printf        -> 26, ferror(stdout) STILL 1
//     the worker's line is lost entirely
//
// `F_ERR` on a stream in shared memory is visible to every thread and never
// clears, so one worker's failed `freopen` silently degraded stdout for the
// whole guest -- while `printf` on main kept returning a byte count, which is
// why nothing noticed.
//
// The fix is not in `freopen`. It is that a worker may not CLOSE 0/1/2 either
// (`descriptor_table_remove`), so `freopen`'s `fclose` cannot take the shared
// stream down. Both halves of the same rule as `table_allocate`'s floor: the
// standard streams are shared objects reached through a per-thread handle, and
// a worker may neither acquire nor destroy them.
//
// A/B: fails against enclave-wasipsetc-build:r8 and :r9c, passes against the
// ownership build.
//
// Build/run:
//   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:<tag> \
//       worker-stdio-freopen.c -O2 -o worker-stdio-freopen.wasm
//   wasmtime run -W threads,shared-everything-threads,\
//   component-model-threading,shared-memory -S cli --dir d::/d \
//       worker-stdio-freopen.wasm
//
// Exit codes: 0 pass, 1 stdout carries a sticky error after the failed
// freopen, 2 the worker lost stdout, 3 main lost stdout, 4 the redirect
// SUCCEEDED (which would mean a worker can point the shared stdout at its own
// file -- the leak this whole rule exists to stop), 5 harness failure.

#include <pthread.h>
#include <stdio.h>
#include <string.h>

static FILE *freopen_ret;
static int worker_printf_ret;
static int worker_ferror;

static void *worker(void *arg) {
  (void)arg;
  // Must fail: a worker cannot redirect a shared standard stream.
  freopen_ret = freopen("/d/reopened.txt", "w", stdout);
  // ...and stdout must still work afterwards, here and everywhere else.
  worker_printf_ret = printf("worker-after-freopen\n");
  worker_ferror = ferror(stdout);
  return NULL;
}

int main(void) {
  pthread_t t;
  if (pthread_create(&t, NULL, worker, NULL) != 0) {
    fprintf(stderr, "FAIL(harness): pthread_create\n");
    return 5;
  }
  pthread_join(t, NULL);

  int main_printf_ret = printf("main-after-worker-freopen\n");
  fflush(stdout);
  int main_ferror = ferror(stdout);

  int rc = 0;
  if (freopen_ret != NULL) {
    fprintf(stderr,
            "FAIL: freopen on a worker SUCCEEDED -- the shared stdout now "
            "points at a worker-chosen file, which is the redirect that leaks "
            "guest bytes through main's flush\n");
    rc = 4;
  } else if (worker_ferror || main_ferror) {
    fprintf(stderr,
            "FAIL: stdout carries a sticky error after the failed freopen "
            "(worker ferror=%d, main ferror=%d) -- the failure path closed a "
            "stream shared with every other thread\n",
            worker_ferror, main_ferror);
    rc = 1;
  } else if (worker_printf_ret <= 0) {
    fprintf(stderr, "FAIL: worker lost stdout (printf returned %d)\n",
            worker_printf_ret);
    rc = 2;
  } else if (main_printf_ret <= 0) {
    fprintf(stderr, "FAIL: main lost stdout (printf returned %d)\n",
            main_printf_ret);
    rc = 3;
  }

  if (rc == 0)
    fprintf(stderr,
            "PASS: freopen refused, stdout intact for both threads "
            "(worker=%d main=%d, no sticky error)\n",
            worker_printf_ret, main_printf_ret);
  return rc;
}
