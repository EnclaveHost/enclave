// enclave/SET probe: when ANY thread redirects one of its own standard
// descriptors, the other threads must stop being able to resolve that stream —
// not keep writing it to wherever their own 0/1/2 happens to point.
//
// THE BUG THIS REGRESSION-TESTS, and why the worker-only rule was not enough.
// Round 10 stopped a WORKER acquiring or freeing indices 0/1/2 and concluded
// that `__WASILIBC_FILE_SHARED` was therefore sound, because "0/1/2 name the
// same three streams on every thread for the life of the component". That is
// false for the MAIN thread, which keeps stock behaviour on purpose — and
// under `wasmtime serve` the request HANDLER runs on the main thread. So the
// ordinary two-line idiom
//
//     close(1); open("/d/private.txt", ...);      /* returns bare fd 1 */
//
// left the shared `stdout` FILE (still SHARED, so every thread was waved
// through) with `f->fd == 1` naming the handler's private file on the handler
// and the SERVER'S REAL STDOUT on every worker. A worker's `printf` then went
// to the operator's container log — the same observable round 10 was written
// to close, reached without any worker touching a standard descriptor.
//
// Measured, this probe, worker writes then flushes:
//
//     native gcc/glibc : operator stdout   0 B, guest file 49 B
//     r8 / r9c / r10c  : operator stdout  39 B INCLUDING THE SECRET, file 10 B
//     fixed            : operator stdout   0 B, guest file 49 B  (native-identical)
//
// THE SECOND ASSERTION IS NOT PADDING. The first cut of the fix refused the
// non-owning thread's WRITE, which meant the line-buffered path called
// `f->write` on the newline, `__stdio_write` refused it, and `__fwritex`
// returned early — silently DISCARDING the whole line. `printf("AAAA\n")`
// vanished while `printf("BBBB")` survived, so the guest lost exactly the data
// it had terminated properly. The rule is that a non-owning thread BUFFERS
// (which needs no descriptor) and the owner drains; only draining is refused.
// So this probe also checks that the worker's bytes ARRIVE in the guest's file.
//
// Build/run:
//   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:<tag> \
//       worker-std-redirect.c -O2 -o worker-std-redirect.wasm
//   wasmtime run -W threads,shared-everything-threads,\
//   component-model-threading,shared-memory -S cli --dir d::/d \
//       worker-std-redirect.wasm
//
// Exit codes: 0 pass, 1 guest bytes reached the operator's stream, 2 the
// worker's bytes were lost instead of buffered, 3 harness failure.

#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define SECRET "TENANT-SECRET-MUST-STAY-IN-THE-SANDBOX"
#define MAIN_LINE "MAIN-line\n"

static int worker_printf_ret;
static int worker_flush_ret;

static void *worker(void *arg) {
  (void)arg;
  // Terminated with a newline on purpose: `stdout` starts line-buffered, so
  // this is the write that used to be flushed through the WORKER's fd 1.
  worker_printf_ret = printf("%s\n", SECRET);
  // An ordinary thing for a worker to do, and the call that leaked.
  worker_flush_ret = fflush(stdout);
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
  // The redirect, on the MAIN thread — which is the request handler under
  // `wasmtime serve`.
  if (close(1) != 0) {
    fprintf(stderr, "FAIL(harness): main could not close fd 1\n");
    return 3;
  }
  int fd = open("/d/redirected.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    fprintf(stderr, "FAIL(harness): open after close(1) failed\n");
    return 3;
  }
  fprintf(stderr, "main: open after close(1) returned fd %d\n", fd);

  pthread_t t;
  if (pthread_create(&t, NULL, worker, NULL) != 0) {
    fprintf(stderr, "FAIL(harness): pthread_create\n");
    return 3;
  }
  pthread_join(t, NULL);

  printf("%s", MAIN_LINE);
  fflush(stdout);

  long want = (long)(strlen(SECRET) + 1 + strlen(MAIN_LINE));
  long got = file_size("/d/redirected.txt");

  // The decisive check is what a human sees in the operator's log, and this
  // probe cannot read that stream — so it asserts the complement: EVERY byte
  // the guest wrote is accounted for in the guest's own file. If any of it went
  // to the real stdout instead, this comes up short.
  if (got < want) {
    fprintf(stderr,
            "FAIL: the guest's file holds %ld of %ld bytes — the rest went to "
            "whatever fd 1 names on the OTHER thread, i.e. the operator's "
            "stream (worker printf=%d fflush=%d)\n",
            got, want, worker_printf_ret, worker_flush_ret);
    return 1;
  }
  if (worker_printf_ret != (int)(strlen(SECRET) + 1)) {
    fprintf(stderr,
            "FAIL: the worker's line-buffered write was discarded rather than "
            "buffered (printf returned %d, expected %zu)\n",
            worker_printf_ret, strlen(SECRET) + 1);
    return 2;
  }
  fprintf(stderr,
          "PASS: all %ld bytes landed in the guest's file, worker's write "
          "buffered not dropped\n",
          got);
  return 0;
}
