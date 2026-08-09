/* enclave/SET repro: a WIDE-character write refused on the WRONG THREAD sets
 * F_ERR on the SHARED FILE and poisons the OWNER's ferror -- exactly the defect
 * F_XERR was introduced to stop on the byte/read side, still live on the wide
 * write path because `__fputwc_unlocked` sets `f->flags |= F_ERR` ITSELF,
 * ABOVE the `__stdio_write` layer whose refusal deliberately sets no flag.
 *
 *   fputwc -> putc_unlocked -> __overflow -> f->write == __stdio_write
 *   non-owner: __stdio_write refuses, returns 0 (NO flag, by design)
 *   __overflow returns EOF -> putc_unlocked returns EOF -> c == WEOF
 *   __fputwc_unlocked: `if (c==WEOF) f->flags |= F_ERR;`   <-- POISON
 *
 * The byte path (fputc/fputs/fwrite) never sets F_ERR itself, so it is clean;
 * only the wide path poisons. worker-xerr-owner.c covers the READ side and the
 * BYTE side; this is the hole it left.
 *
 * Asserts only what is TRUE OF NATIVE TOO (shared fd table -> the worker's
 * cross-thread write SUCCEEDS -> no WEOF -> no F_ERR -> owner ferror == 0), so
 * the same source built with gcc is a valid control:
 *   Arm A: owner's ferror(private wide FILE) is 0 after a sibling's wide writes;
 *   Arm B: control -- the byte path leaves the owner's ferror 0 (shows the bug
 *          is wide-specific, not a generic cross-thread artifact);
 *   Arm C: the owner can still write and flush its own stream afterwards.
 *
 *   docker run --rm -v "$PWD":/src enclave-wasipsetc-build:r13c \
 *       worker-wide-poison.c -O2 -o worker-wide-poison.wasm
 *   W="-W threads,shared-everything-threads,component-model-threading,shared-memory"
 *   wasmtime run $W -S cli --dir .::/d worker-wide-poison.wasm; echo $?
 *
 * Expected on a FIXED image: exit 0.
 * Expected on :r13c (current): FAIL arm A -- owner's ferror is 1, poisoned by
 * the worker's wide-char overflow refusal.
 * Native control:
 *   sed 's|/d/|d/|g' worker-wide-poison.c > n.c && gcc -O2 -pthread n.c && ./a.out
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wchar.h>

static const char *PATH_WIDE = "/d/wide-poison.txt";
static const char *PATH_BYTE = "/d/byte-control.txt";

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
static int phase; /* 0: setup, 1: worker may write, 2: worker done */

static void set_phase(int p) {
  pthread_mutex_lock(&mu);
  phase = p;
  pthread_cond_broadcast(&cv);
  pthread_mutex_unlock(&mu);
}
static void await_phase(int p) {
  pthread_mutex_lock(&mu);
  while (phase < p) pthread_cond_wait(&cv, &mu);
  pthread_mutex_unlock(&mu);
}

static FILE *wide_file; /* owned by MAIN, wide-oriented "w" */
static FILE *byte_file; /* owned by MAIN, byte "w" */

/* Enough ASCII wide chars to fill BUFSIZ and force the overflow that drains. */
#define N 8192

static void *worker(void *arg) {
  (void)arg;
  await_phase(1);

  /* The sibling floods the OWNER's wide stream. Small writes buffer into the
     shared buffer with no descriptor; once it fills, __overflow calls
     __stdio_write, which refuses for this non-owning thread, and fputwc turns
     that EOF into F_ERR on the SHARED FILE. */
  for (int i = 0; i < N; i++) fputwc(L'x', wide_file);

  /* Byte control: identical shape, but fputc never sets F_ERR itself. */
  for (int i = 0; i < N; i++) fputc('y', byte_file);

  set_phase(2);
  return NULL;
}

int main(void) {
  wide_file = fopen(PATH_WIDE, "w");
  if (!wide_file) { fprintf(stderr, "FAIL(harness): fopen %s: %s\n", PATH_WIDE, strerror(errno)); return 3; }
  fwide(wide_file, 1); /* wide orientation, established by the OWNER */

  byte_file = fopen(PATH_BYTE, "w");
  if (!byte_file) { fprintf(stderr, "FAIL(harness): fopen %s: %s\n", PATH_BYTE, strerror(errno)); return 3; }

  pthread_t t;
  if (pthread_create(&t, NULL, worker, NULL) != 0) {
    fprintf(stderr, "FAIL(harness): pthread_create\n");
    return 3;
  }
  set_phase(1);
  await_phase(2);
  pthread_join(t, NULL);

  /* Arm A: the OWNER's error indicator is not poisoned by the sibling's wide
     writes. Native: 0 (the cross-thread write succeeds, no WEOF). */
  CHECK(ferror(wide_file) == 0,
        "owner's ferror(wide FILE) is %d after a sibling's wide-char writes; "
        "native is 0 -- __fputwc_unlocked wrote F_ERR into the SHARED FILE on a "
        "non-owner's overflow refusal (the wide analog of the F_XERR bug)",
        ferror(wide_file));

  /* Arm B: byte control -- proves the poison is wide-specific. */
  CHECK(ferror(byte_file) == 0,
        "owner's ferror(byte FILE) is %d after a sibling's byte writes; native "
        "is 0 (this should already pass -- the byte path sets no flag)",
        ferror(byte_file));

  /* Arm C: the owner can still use its own stream. */
  clearerr(wide_file);
  int wrc = fputws(L"owner-can-still-write\n", wide_file);
  CHECK(wrc >= 0, "owner's own fputws failed after the sibling poisoned the stream");
  CHECK(fflush(wide_file) == 0, "owner's own fflush failed");

  fclose(wide_file);
  fclose(byte_file);

  if (failures) { fprintf(stderr, "FAILURES: %d\n", failures); return 1; }
  printf("PASS: a sibling's wide-char write does not poison the owner's ferror\n");
  return 0;
}
