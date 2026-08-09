// enclave/SET probe: an ALLOCATION FAILURE while a thread builds its preopen
// table, and the thread exit that follows it, must not wedge the component.
//
// WHY THIS EXISTS WHEN `worker-preopen-retry.c` ALREADY CLAIMED TO COVER IT.
// It did not. That probe induces failure by NAMESPACE EXHAUSTION, which fails
// at preopen index 0 — so `num_preopens` is 0, the cleanup loop that held the
// round-8 CRITICAL is empty, and it never runs. It passes IDENTICALLY against
// the round-7 libc it is cited as regression-testing, and it costs 262,200
// thread creations to prove nothing. Reaching the bug needs an allocation
// failure at preopen index >= 1 with a live sibling thread, which is what the
// heap-hole shape below produces.
//
// TWO DISTINCT DEFECTS LIVE AT THESE HOLE SIZES, and the probe separates them
// because each build hangs at a different one:
//
//   HOLE=8,  round-7/round-8 libc: the preopen failure path re-entered
//            `__wasilibc_populate_preopens` through `close()` and self-
//            deadlocked on musl's non-recursive lock. Fixed in round 9.
//
//   HOLE=9..11, round-9 libc: `__wasilibc_set_release_path_bufs` — added in
//            round 9 to fix a MEDIUM leak — called `free()` on a pointer it
//            did not own. `__wasilibc_find_relpath_alloc` is a WEAK symbol
//            defined only by `chdir.c`; a guest that never calls `chdir` does
//            not link it, and `__wasilibc_find_relpath` then delegates to
//            `__wasilibc_find_abspath`, which documents that `relative_path`
//            "may be an interior pointer to the `abspath` string". So the
//            cached pointer is BORROWED from the guest's own path argument.
//            Freeing it put `dlfree` on a chunk header made of string bytes:
//
//                0: dlfree
//                1: free
//                2: __wasilibc_set_release_path_bufs
//                3: __wasilibc_set_release_thread_state
//                4: __wasi_thread_start_C
//                memory fault at wasm address 0x2f326451 in a 0x800000 memory
//
//            That is `__pthread_exit`, so the worker died mid-teardown and
//            never woke its joiner: main blocked in `pthread_join` forever.
//            Silent heap corruption whenever those bytes happened to look like
//            a plausible chunk, an out-of-bounds trap when they did not.
//
// The second one is the more important lesson: a MEDIUM leak fix, reviewed and
// shipped, became a CRITICAL on the NORMAL exit path of every worker that ever
// opened a file in a guest without `chdir`. Nothing in the corpus could see it
// because a bogus `free()` only traps when the heap is dense enough for the
// bad address to land outside linear memory — which is exactly what the hole
// tuning here arranges.
//
// THE HOLE IS BUILD-SPECIFIC. It is a byte count into dlmalloc's layout, so
// adding a field to a libc struct moves it. Sweep, do not assume: a build that
// passes at one hole size may hang two sizes over.
//
// A/B: :r8 hangs at HOLE=8; :r9c hangs at HOLE=9,10,11; the fixed build passes
// at every hole size.
//
// Build/run (note the TWO preopens and the tenant-sized memory cap):
//   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:<tag> \
//       worker-preopen-oom.c -O2 -o worker-preopen-oom.wasm
//   for h in 0 2 4 6 8 9 10 11 12 14 16; do
//     wasmtime run -W threads,shared-everything-threads,\
//   component-model-threading,shared-memory -W max-memory-size=8388608 \
//       -S cli --dir d1::/d --dir d2::/d1 --env HOLE=$h worker-preopen-oom.wasm
//   done
//
// A hang (timeout) is the failure. Exit codes: 0 pass, 2 the worker could not
// be spawned, 3 the worker never reported.

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

struct blk {
  struct blk *next;
  char pad[40];
};

static struct blk *head;
static long blocks;
static int hole;
static atomic_int worker_reported = 0;

static void *worker(void *a) {
  (void)a;
  // Eat what is left of the tenant's memory, then hand back a tuned hole: big
  // enough for preopen 0, short of what preopen 1's longer prefix needs.
  for (;;) {
    struct blk *b = malloc(sizeof *b);
    if (!b)
      break;
    b->next = head;
    head = b;
    blocks++;
  }
  for (int i = 0; i < hole && head; i++) {
    struct blk *b = head;
    head = b->next;
    free(b);
    blocks--;
  }

  int fd = open("/d/f.txt", O_WRONLY | O_CREAT, 0644);
  fprintf(stderr, "worker: blocks=%ld hole=%d open=%d (%s)\n", blocks, hole, fd,
          fd < 0 ? strerror(errno) : "ok");
  if (fd >= 0)
    close(fd);

  // Second call: the sticky failure flag must make this cheap and must not
  // re-mint the preopen list (that was the unbounded host-handle leak).
  fd = open("/d1/g.txt", O_WRONLY | O_CREAT, 0644);
  fprintf(stderr, "worker: second open=%d\n", fd);
  if (fd >= 0)
    close(fd);

  atomic_store(&worker_reported, 1);
  // Returning is the other half of the test: thread exit runs
  // `__wasilibc_set_release_thread_state`, and it must not free anything it
  // does not own.
  return NULL;
}

int main(void) {
  const char *e = getenv("HOLE");
  hole = e ? atoi(e) : 0;

  // Warm main's own preopen table first, so the worker's failure is the only
  // one under test.
  int fd = open("/d/warm.txt", O_WRONLY | O_CREAT, 0644);
  if (fd >= 0)
    close(fd);

  pthread_t t;
  if (pthread_create(&t, NULL, worker, NULL) != 0) {
    fprintf(stderr, "FAIL(harness): could not spawn the worker\n");
    return 2;
  }
  // A hang HERE is the finding: the worker trapped inside its own teardown and
  // will never arrive.
  pthread_join(t, NULL);
  fprintf(stderr, "main: joined, component alive\n");

  if (!atomic_load(&worker_reported)) {
    fprintf(stderr, "FAIL: worker never reported\n");
    return 3;
  }
  fprintf(stderr, "PASS: OOM at preopen >= 1 failed the call, not the component\n");
  return 0;
}
