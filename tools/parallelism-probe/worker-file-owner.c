// enclave/SET probe: a `FILE` may only be RESOLVED by the thread whose
// descriptor namespace its `fd` names -- and everything that does not need to
// resolve it must keep behaving exactly as it does natively.
//
// THE CLASS. `FILE` objects and the `__ofl` open-file list live in SHARED
// linear memory; `f->fd` is a PER-THREAD name. Any operation that turns
// `f->fd` into a syscall on the wrong thread either misdelivers or destroys.
//
// WHAT NATIVE DOES, MEASURED, BECAUSE THIS IS WHERE THE CORPUS KEEPS GOING
// WRONG. Five probes in this tree have encoded a bug as the spec. The first
// draft of THIS one did too: it asserted that a cross-thread `fwrite` must
// write zero bytes. It must not. `fwrite` copies into the FILE's buffer --
// shared memory -- and only resolves `f->fd` when that buffer has to drain, so
// a small cross-thread `fwrite` followed by the OWNER's flush is correct
// end-to-end and native does exactly that. Built with gcc/glibc, the small
// case below writes 48 bytes and returns 28. So that is what this asserts.
//
// The divergence is real but narrower, and it is asserted rather than left
// implicit: when the buffer must drain on the WRONG thread, SET has no honest
// option -- the bytes would have to go through a descriptor that thread cannot
// name -- so the write is refused. Native writes 40000 and gets a 40005-byte
// file; SET returns 0 and leaves the owner's 5 bytes intact. Failing is the
// point. What must never happen is the third outcome, which is what shipped:
//
//   round-7/round-8 libc, large cross-thread fwrite:  returns 0, ferror SET,
//                                                     file 0 bytes
//                                                     -- the owner's bytes
//                                                     DESTROYED and the shared
//                                                     stream poisoned.
//
// `__stdio_write`'s failure path zeroes `wpos`/`wbase`, so reaching it on a
// foreign thread does not misdeliver the owner's buffer, it discards it. Same
// mechanism made a worker's `fflush(NULL)` take main's 19 buffered bytes with
// `F_ERR` set and exit status 0.
//
// A/B: fails against enclave-wasipsetc-build:r8 and :r9c, passes against the
// ownership build.
//
// Build/run:
//   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:<tag> \
//       worker-file-owner.c -O2 -o worker-file-owner.wasm
//   wasmtime run -W threads,shared-everything-threads,\
//   component-model-threading,shared-memory -S cli --dir d::/d \
//       worker-file-owner.wasm
//
// Exit codes: 0 pass, 1 the owner's buffered bytes were destroyed, 2 a
// buffered cross-thread write diverged from native, 3 an over-buffer
// cross-thread write was not refused cleanly, 4 the thread-exit flush did not
// run, 5 harness failure.

#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAIN_BYTES "MAIN-BUFFERED-BYTES\n"       // 20, deliberately unflushed
#define ALIEN_BYTES "BYTES-FROM-THE-WRONG-THREAD\n" // 28, fits in the buffer
#define WORKER_BYTES "worker-owns-this\n"           // 17, never fclosed
#define BIG_LEN 40000                               // far past BUFSIZ

static FILE *main_file;  // owned by main, left buffered
static FILE *big_file;   // owned by main, target of the over-buffer write
static char big[BIG_LEN];

static int worker_flush_null_ret;
static int worker_flush_explicit_ret;
static size_t worker_small_ret;
static size_t worker_big_ret;

static pthread_barrier_t barrier;

static void *worker(void *arg) {
  (void)arg;

  FILE *mine = fopen("/d/owner-worker.txt", "w");
  if (mine)
    fprintf(mine, "%s", WORKER_BYTES); // never fclosed, never fflushed

  // Door 1: the global walk. Must skip FILEs this thread cannot name rather
  // than write them through its own table.
  worker_flush_null_ret = fflush(NULL);

  // Door 2: named explicitly. Must refuse BEFORE touching the buffer --
  // falling through to the generic failure path is what loses the bytes.
  errno = 0;
  worker_flush_explicit_ret = fflush(main_file);

  // Door 3: buffered cross-thread write. Legal, and must stay legal: no
  // descriptor is resolved, so this is native behaviour.
  errno = 0;
  worker_small_ret = fwrite(ALIEN_BYTES, 1, strlen(ALIEN_BYTES), main_file);

  // Door 4: over-buffer cross-thread write. The buffer must drain, which needs
  // a descriptor this thread cannot name, so it must be refused -- WITHOUT
  // taking the owner's bytes with it.
  errno = 0;
  worker_big_ret = fwrite(big, 1, BIG_LEN, big_file);

  pthread_barrier_wait(&barrier);
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
  memset(big, 'X', sizeof big);

  if (pthread_barrier_init(&barrier, NULL, 2) != 0) {
    fprintf(stderr, "FAIL(harness): barrier_init\n");
    return 5;
  }
  main_file = fopen("/d/owner-main.txt", "w");
  big_file = fopen("/d/owner-big.txt", "w");
  if (!main_file || !big_file) {
    fprintf(stderr, "FAIL(harness): fopen\n");
    return 5;
  }
  // Buffered and NOT flushed: the payload a foreign thread must not destroy.
  fprintf(main_file, "%s", MAIN_BYTES);
  fprintf(big_file, "MAIN\n");

  pthread_t t;
  if (pthread_create(&t, NULL, worker, NULL) != 0) {
    fprintf(stderr, "FAIL(harness): pthread_create\n");
    return 5;
  }
  pthread_barrier_wait(&barrier);
  pthread_join(t, NULL);

  int rc = 0;
  int main_err = ferror(main_file);
  int big_err = ferror(big_file);
  fclose(main_file);
  fclose(big_file);

  long main_sz = file_size("/d/owner-main.txt");
  long big_sz = file_size("/d/owner-big.txt");
  long worker_sz = file_size("/d/owner-worker.txt");

  // 1. The owner's own bytes survive, on both streams. This is the finding.
  if (main_err || big_err || main_sz < (long)strlen(MAIN_BYTES) || big_sz < 5) {
    fprintf(stderr,
            "FAIL: a foreign thread destroyed the owner's buffered bytes "
            "(ferror main=%d big=%d, sizes %ld/%ld, fflush(NULL)=%d "
            "fflush(f)=%d)\n",
            main_err, big_err, main_sz, big_sz, worker_flush_null_ret,
            worker_flush_explicit_ret);
    rc = 1;
  }

  // 2. The buffered cross-thread write behaves as it does natively: it lands.
  if (rc == 0) {
    long want = (long)(strlen(MAIN_BYTES) + strlen(ALIEN_BYTES));
    if (worker_small_ret != strlen(ALIEN_BYTES) || main_sz != want) {
      fprintf(stderr,
              "FAIL: buffered cross-thread fwrite returned %zu and left %ld "
              "bytes; native returns %zu and leaves %ld (no descriptor is "
              "resolved, so this path must not diverge)\n",
              worker_small_ret, main_sz, strlen(ALIEN_BYTES), want);
      rc = 2;
    }
  }

  // 3. The over-buffer write is refused, cleanly. Short return, owner's bytes
  //    intact, and no F_ERR poisoning of a stream shared with other threads.
  if (rc == 0 && (worker_big_ret != 0 || big_sz != 5)) {
    fprintf(stderr,
            "FAIL: over-buffer cross-thread fwrite returned %zu leaving %ld "
            "bytes; it must be refused (0) with the owner's 5 intact -- "
            "letting it drain resolves the owner's fd on the wrong thread\n",
            worker_big_ret, big_sz);
    rc = 3;
  }

  // 4. The worker's own FILE was never fclosed; the thread-exit flush owes it.
  if (rc == 0 && worker_sz != (long)strlen(WORKER_BYTES)) {
    fprintf(stderr,
            "FAIL: worker-owned FILE holds %ld bytes, expected %zu -- the "
            "thread-exit flush did not run\n",
            worker_sz, strlen(WORKER_BYTES));
    rc = 4;
  }

  if (rc == 0)
    fprintf(stderr,
            "PASS: owner kept its bytes (%ld/%ld), buffered cross-thread write "
            "landed as it does natively, over-buffer write refused, worker's "
            "unflushed FILE kept its %ld\n",
            main_sz, big_sz, worker_sz);
  return rc;
}
