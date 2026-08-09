/* enclave/SET repro: a read refused on the WRONG THREAD must not poison the
 * stream for its OWNER, must not silence it, and must not spin.
 *
 * This is the probe the F_XERR work shipped without. Three revisions got the
 * flag wrong in three different ways, each fixing the last:
 *
 *   no flag  -- `while (!feof(f) && !ferror(f)) fread(...)` never terminates
 *               (measured 2,000,000 zero-progress iterations at full CPU).
 *   F_ERR    -- sticky in the SHARED FILE, so the OWNER's `ferror` reads 1
 *               where native reads 0. The owner's own stream, poisoned by a
 *               sibling.
 *   F_EOF    -- musl's `__toread` ends `return (f->flags & F_EOF) ? EOF : 0;`,
 *               so it SUPPRESSES EVERY LATER READ on that stream for every
 *               thread. Main's own `fgets(stdin)` returned NULL with data still
 *               in the file; under `serve` the handler got zero input, silently.
 *
 * F_XERR (bit 256) is the resolution: a refusal bit the owner DISCARDS in
 * `ferror()`. The refusing thread sees it and terminates; the owner never reads
 * an error it does not have.
 *
 * Asserts only what is TRUE OF NATIVE TOO, so the same source is a valid
 * control:
 *   1. the owner's `ferror` is 0 after a sibling's refused read;
 *   2. the owner can still READ its own stream afterwards;
 *   3. the sibling's textbook drain loop TERMINATES.
 * What the sibling's read RETURNS is deliberately not asserted -- native
 * succeeds (one shared fd table), SET refuses (per-thread tables), and both are
 * correct for their model.
 *
 *   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:local \
 *       worker-xerr-owner.c -O2 -o worker-xerr-owner.wasm
 *   W="-W threads,shared-everything-threads,component-model-threading,shared-memory"
 *   wasmtime run $W -S cli --dir d::/d worker-xerr-owner.wasm; echo $?
 *
 * Expected: exit 0. A/B: `:r13a` fails arm 1 (owner ferror stuck at 1),
 * `:r13b` fails arm 2 (owner's own fgets returns NULL with data still there).
 * Native control: build with
 *   sed 's|"/d/|"d/|g' worker-xerr-owner.c > n.c && gcc -O2 -pthread n.c
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define LINES 64
static const char *PATH_STDIN = "/d/xerr-stdin.txt";
static const char *PATH_PRIV = "/d/xerr-priv.txt";

static int failures;
#define CHECK(cond, ...)                                                       \
  do {                                                                         \
    if (!(cond)) {                                                             \
      fprintf(stderr, "FAIL: ");                                               \
      fprintf(stderr, __VA_ARGS__);                                            \
      fprintf(stderr, "\n");                                                   \
      failures++;                                                              \
    }                                                                          \
  } while (0)

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int phase; /* 0: main claiming, 1: worker may read, 2: worker done */

static void set_phase(int p) {
  pthread_mutex_lock(&mu);
  phase = p;
  pthread_cond_broadcast(&cv);
  pthread_mutex_unlock(&mu);
}

static void await_phase(int p) {
  pthread_mutex_lock(&mu);
  while (phase < p)
    pthread_cond_wait(&cv, &mu);
  pthread_mutex_unlock(&mu);
}

/* The textbook drain loop. Returns the number of iterations; the point of the
   probe is that it RETURNS AT ALL. */
static long drain(FILE *f) {
  char buf[64];
  long iters = 0;
  while (!feof(f) && !ferror(f)) {
    size_t n = fread(buf, 1, sizeof buf, f);
    if (++iters > 2000000L)
      return -1; /* the flagless-refusal spin */
    if (n == 0 && (feof(f) || ferror(f)))
      break;
  }
  return iters;
}

static FILE *priv_file;

static void *worker(void *arg) {
  (void)arg;
  await_phase(1);

  /* ARM 3 (loop termination) goes on the PRIVATE file, because a drain runs to
     EOF and that is not a native-comparable end state for the stream we later
     assert the owner can still read from. */
  long i2 = drain(priv_file);
  CHECK(i2 >= 0, "worker's drain of main's private FILE did not terminate "
                 "(a refusal that sets no flag spins forever)");

  /* ARM 2's setup goes on the CLAIMED SHARED stream, and it is deliberately a
     SHORT read rather than a drain. This is the arm that catches F_EOF, and it
     only works if the stream is left far from end-of-input on BOTH models:
     natively this consumes 64 bytes of a much larger file (the sibling really
     can read -- one shared fd table), under SET it is refused and consumes
     nothing. Either way the owner must still be able to read. A drain here
     would leave native at EOF and make the arm fail on the control. */
  char buf[64];
  (void)fread(buf, 1, sizeof buf, stdin);

  set_phase(2);
  return NULL;
}

int main(void) {
  /* Build the two inputs. */
  FILE *w = fopen(PATH_STDIN, "w");
  if (!w) { fprintf(stderr, "FAIL(harness): fopen %s: %s\n", PATH_STDIN, strerror(errno)); return 3; }
  for (int i = 0; i < LINES; i++) fprintf(w, "stdin-line-%03d\n", i);
  fclose(w);

  w = fopen(PATH_PRIV, "w");
  if (!w) { fprintf(stderr, "FAIL(harness): fopen %s: %s\n", PATH_PRIV, strerror(errno)); return 3; }
  for (int i = 0; i < LINES; i++) fprintf(w, "priv-line-%03d\n", i);
  fclose(w);

  /* MAIN rebinds its own fd 0. Under SET this CLAIMS the shared `stdin` FILE
     for main's namespace, which is the state in which a sibling's read is
     refused -- and the state the F_ERR revision poisoned. */
  close(0);
  int fd0 = open(PATH_STDIN, O_RDONLY);
  if (fd0 != 0) {
    fprintf(stderr, "FAIL(harness): open after close(0) returned %d, want 0\n", fd0);
    return 3;
  }

  priv_file = fopen(PATH_PRIV, "r");
  if (!priv_file) { fprintf(stderr, "FAIL(harness): fopen priv for read\n"); return 3; }

  pthread_t t;
  if (pthread_create(&t, NULL, worker, NULL) != 0) {
    fprintf(stderr, "FAIL(harness): pthread_create\n");
    return 3;
  }

  set_phase(1);
  await_phase(2);
  pthread_join(t, NULL);

  /* Arm 1: the OWNER's error indicator is not poisoned by the sibling. */
  CHECK(ferror(stdin) == 0,
        "owner's ferror(stdin) is %d after a sibling's refused read; native is 0 "
        "-- a per-caller refusal was written into the shared FILE (F_ERR)",
        ferror(stdin));
  CHECK(ferror(priv_file) == 0,
        "owner's ferror(private FILE) is %d after a sibling's refused read; "
        "native is 0", ferror(priv_file));

  /* Arm 2: the owner can still READ its own stream. F_EOF suppressed every
     later read for every thread -- silent truncation, the worst of the three,
     and the one that gave a `serve` handler zero input.
     NO `clearerr` FIRST: clearing would wipe the very F_EOF this detects. The
     stream is far from EOF on both models (see the worker's short read), so a
     correct build -- and native -- must hand back a line here. */
  CHECK(feof(stdin) == 0,
        "owner's feof(stdin) is set after a sibling's refused short read; the "
        "refusal marked end-of-input on a stream that has data (F_EOF)");
  char line[128];
  char *got = fgets(line, sizeof line, stdin);
  CHECK(got != NULL,
        "owner's own fgets(stdin) returned NULL with data still in the file "
        "-- the refusal suppressed the owner's reads (F_EOF)");

  fclose(priv_file);

  if (failures) {
    fprintf(stderr, "FAILURES: %d\n", failures);
    return 1;
  }
  printf("PASS: refusal is caller-scoped -- owner's ferror clean, owner's reads "
         "still work, sibling's drain loop terminated\n");
  return 0;
}
