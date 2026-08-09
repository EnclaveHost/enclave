// enclave/SET probe: `fclose` on a `FILE` this thread cannot name must be
// refused, not performed — because performing it is a use-after-free that the
// OWNER then walks into.
//
// THE BUG THIS REGRESSION-TESTS. Round 10 gave every `FILE` an owner and
// checked it in `fflush`, `fflush(NULL)`, `__stdio_exit` and the
// `__stdio_write`/`read`/`seek` vtable — but not in `fclose`, which is the
// destructive member of the family. On a FILE belonging to another thread
// musl's `fclose` does all of this anyway:
//
//   * `fflush(f)` correctly refuses, so the owner's buffered bytes are never
//     written;
//   * `f->close(f)` resolves `f->fd` in THIS thread's namespace and fails;
//   * and then the FILE is unlisted from `__ofl` and `free()`d regardless.
//
// So the owner loses its data AND is left holding a dangling `FILE *`. This is
// not merely the "owner's buffered bytes destroyed" condition
// `worker-file-owner.c` exists to catch — it is memory-unsafe, and the trap it
// produces crosses the host boundary. Measured, main buffers 21 bytes and a
// worker `fclose`s the FILE:
//
//   native gcc/glibc : file 21 B, worker's fclose returns 0 — legal in POSIX,
//                      because there is ONE fd table and the close genuinely
//                      works. This is a REAL divergence, and the probe is
//                      written around it: it only touches the FILE afterwards
//                      when the foreign close was REFUSED. An earlier draft
//                      used the stream unconditionally and the native arm
//                      aborted with "double free or corruption" — the probe,
//                      not the libc, was wrong. Seventh instance of that
//                      pattern in this corpus; the native control caught it.
//   r8 / r9c         : file  4 B, then MAIN TRAPS in `fclose`
//                      -> `wasm trap: uninitialized element`
//   r10c             : file  0 B, then MAIN TRAPS in `fflush` inside a HOST
//                      call -> `list pointer/length out of bounds of memory`
//                      (a freed FILE's buffer pointer/length handed to the
//                      host; the engine's bounds check is what stops it)
//   fixed            : file 21 B, worker's fclose returns -1/EBADF, and the
//                      owner closes its own stream cleanly
//
// The refusal loses the close rather than the data, which is the same trade
// made for the over-buffer cross-thread `fwrite`: under per-thread descriptor
// tables the underlying descriptor is not reachable from here, so there is no
// correct way to honour the call. The owner can still flush and close.
//
// A/B: fails against :r8, :r9c and :r10c (all three trap the component), passes
// against the fixed build.
//
// Build/run:
//   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:<tag> \
//       worker-fclose-owner.c -O2 -o worker-fclose-owner.wasm
//   wasmtime run -W threads,shared-everything-threads,\
//   component-model-threading,shared-memory -S cli --dir d::/d \
//       worker-fclose-owner.wasm
//
// Exit codes: 0 pass, 1 the owner's buffered bytes were destroyed, 2 the owner
// could not use its own stream afterwards, 3 harness failure. A TRAP (non-zero
// exit with a wasm backtrace) is the pre-fix failure and the reason this probe
// exists.

#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>

#define OWNER_BYTES "OWNER-BUFFERED-BYTES\n" // 21, deliberately unflushed

static FILE *victim;
static int worker_fclose_ret;
static int worker_errno;

static void *worker(void *arg) {
  (void)arg;
  errno = 0;
  worker_fclose_ret = fclose(victim);
  worker_errno = errno;
  return NULL;
}

static long file_size(const char *path) {
  FILE *f = fopen(path, "r");
  if (!f)
    return -1;
  if (fseek(f, 0, SEEK_END) != 0) {
    fclose(f);
    return -1;
  }
  long n = ftell(f);
  fclose(f);
  return n;
}

int main(void) {
  victim = fopen("/d/fclose-victim.txt", "w");
  if (!victim) {
    fprintf(stderr, "FAIL(harness): fopen\n");
    return 3;
  }
  fprintf(victim, "%s", OWNER_BYTES); // buffered, NOT flushed

  pthread_t t;
  if (pthread_create(&t, NULL, worker, NULL) != 0) {
    fprintf(stderr, "FAIL(harness): pthread_create\n");
    return 3;
  }
  pthread_join(t, NULL);

  fprintf(stderr, "worker: fclose returned %d (errno %d)\n", worker_fclose_ret,
          worker_errno);

  // Only touch the stream again if the foreign close was REFUSED. If it
  // succeeded (native), the FILE is legitimately gone and using it would be
  // undefined behaviour in the probe rather than a finding in the libc.
  //
  // When it was refused, this is the line that used to trap: the FILE had been
  // freed underneath its owner anyway — in `fclose` on r8/r9c, and inside a
  // HOST call on r10c.
  int flushed = 0, closed = 0;
  if (worker_fclose_ret != 0) {
    flushed = fflush(victim);
    closed = fclose(victim);
  }

  long got = file_size("/d/fclose-victim.txt");
  long want = (long)strlen(OWNER_BYTES);

  if (got != want) {
    fprintf(stderr,
            "FAIL: the owner's file holds %ld bytes, expected %ld — a foreign "
            "fclose destroyed data the owner had buffered\n",
            got, want);
    return 1;
  }
  if (flushed != 0 || closed != 0) {
    fprintf(stderr,
            "FAIL: the owner could not use its own stream after a foreign "
            "fclose (fflush=%d fclose=%d)\n",
            flushed, closed);
    return 2;
  }
  fprintf(stderr,
          "PASS: foreign fclose refused, owner kept its %ld bytes and closed "
          "cleanly\n",
          got);
  return 0;
}
