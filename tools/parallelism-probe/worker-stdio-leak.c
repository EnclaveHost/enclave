// enclave/SET probe: a WORKER must not be able to acquire one of the shared
// standard descriptors, and must not lose its own stderr to the rule that
// stops it.
//
// THE BUG THIS REGRESSION-TESTS. The fd table is per-thread but musl's `FILE`
// objects live in shared linear memory, and `f->fd` is a per-thread NAME.
// `table_allocate` hands out the lowest free index and `index_to_fd` returns
// 0/1/2 bare, so a worker that did
//
//     close(1); fd = open("/d/private.txt", ...);   /* returns 1 */
//     printf("%s", SECRET);                          /* no newline: buffered */
//
// got bare fd 1 back, and its bytes sat in the SHARED stdout buffer until
// main's exit-time flush delivered them through MAIN's fd 1 -- the
// operator-collected process stdout -- while the guest's own file stayed
// empty. Byte for byte inverted from the same source built natively. Round 8
// refused a worker's `dup2(f, 1)`; this reaches the identical observable with
// no `dup2` anywhere, which is why the fix had to be an ownership rule rather
// than a fifth per-call refusal.
//
// THE SECOND ASSERTION IS NOT PADDING. The first attempt at the fix floored a
// worker's allocations at index 3 unconditionally -- and a worker's OWN
// stdin/stdout/stderr are handed out by that same allocator, so they landed at
// indices 3/4/5, the shared `stderr` FILE's `f->fd == 2` named nothing on that
// thread, and every `fprintf(stderr, ...)` from a worker silently wrote zero
// bytes. Nothing else in the corpus would have noticed: a probe that only
// checks "the secret did not leak" passes brilliantly on a build where workers
// cannot print at all. So this probe checks that the worker's diagnostics
// ARRIVE, and it is the reason the floor now excepts the stdio-population
// window.
//
// A/B: fails against enclave-wasipsetc-build:r8 and :r9c (worker receives fd
// 1; CHECK 1 fails), passes against the ownership build.
//
// Build/run:
//   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:<tag> \
//       worker-stdio-leak.c -O2 -o worker-stdio-leak.wasm
//   wasmtime run -W threads,shared-everything-threads,\
//   component-model-threading,shared-memory -S cli --dir d::/d \
//       worker-stdio-leak.wasm
//
// Exit codes: 0 pass, 1 worker acquired a standard descriptor, 2 worker lost
// its stderr, 3 worker-owned bytes were discarded at exit, 4 harness failure.

#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define SECRET "SET-PROBE-SECRET-MUST-NOT-REACH-OPERATOR-STDOUT"
#define STDERR_CANARY "SET-PROBE-WORKER-STDERR-CANARY"

// The worker records its findings here rather than exiting: the point is what
// MAIN's exit flush does afterwards, so the process has to survive to it.
static int worker_untagged_fd = -1; // a standard descriptor handed to a worker
static int worker_open_fd = -1;
static int worker_stderr_ret = -1;
static int worker_owned_bytes = -1; // fprintf into a worker-owned FILE

static void *worker(void *arg) {
  (void)arg;

  // Ask for fd 1 the way the original leak did. `close` is expected to be
  // refused on a worker; what matters is the fd the subsequent `open` returns.
  (void)close(1);
  worker_open_fd = open("/d/private.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (worker_open_fd >= 0 && worker_open_fd < 3)
    worker_untagged_fd = worker_open_fd;

  // Same question through the other doors that reach `table_allocate`.
  int d = dup(2);
  if (d >= 0) {
    if (d < 3)
      worker_untagged_fd = d;
    close(d);
  }
  int lo = fcntl(2, F_DUPFD, 0);
  if (lo >= 0) {
    if (lo < 3)
      worker_untagged_fd = lo;
    close(lo);
  }

  // Buffered, unterminated, into the SHARED stdout: this is the payload that
  // used to be flushed to the operator's log by main.
  printf("%s", SECRET);

  // The worker's diagnostics must still arrive. A build where the worker's own
  // standard descriptors moved out from under the shared FILEs fails here.
  worker_stderr_ret = fprintf(stderr, "%s\n", STDERR_CANARY);

  // A FILE this worker owns, left buffered and never fclosed. POSIX flushes it
  // at exit; before the thread-exit flush existed these bytes were discarded in
  // silence with status 0.
  if (worker_open_fd >= 0) {
    FILE *f = fdopen(worker_open_fd, "w");
    if (f)
      worker_owned_bytes = fprintf(f, "worker-owned-bytes\n");
  }
  return NULL;
}

int main(void) {
  pthread_t t;
  if (pthread_create(&t, NULL, worker, NULL) != 0) {
    fprintf(stderr, "FAIL(harness): pthread_create\n");
    return 4;
  }
  pthread_join(t, NULL);

  int rc = 0;

  if (worker_untagged_fd >= 0) {
    fprintf(stderr,
            "FAIL: worker was handed standard descriptor %d; its writes alias "
            "the shared stdio FILEs and main's exit flush delivers them to the "
            "operator's log\n",
            worker_untagged_fd);
    rc = 1;
  }

  if (worker_stderr_ret <= 0) {
    fprintf(stderr,
            "FAIL: worker's fprintf(stderr) wrote %d bytes; a worker that "
            "cannot reach its own stderr is not a fix, it is a silenced bug\n",
            worker_stderr_ret);
    rc = rc ? rc : 2;
  }

  if (worker_open_fd >= 0 && worker_owned_bytes <= 0) {
    fprintf(stderr, "FAIL(harness): worker could not write its own file (%d)\n",
            worker_owned_bytes);
    rc = rc ? rc : 4;
  }

  // Main's own line, so the ordering of the exit flush is visible in the log.
  printf("main-line\n");

  if (rc == 0)
    fprintf(stderr, "PASS: worker got fd %d (tagged), stderr reached, %d owned "
                    "bytes buffered\n",
            worker_open_fd, worker_owned_bytes);
  return rc;
}
