/* enclave/SET round-14 review probe: the wide READ twin of worker-wide-poison.c.
 *
 * Round 14 fixed `__fputwc_unlocked`'s `f->flags |= F_ERR`. The identical
 * pattern is 40 lines away in `fgetwc.c`, on the same wide path, in the same
 * shared FILE:
 *
 *   libc-top-half/musl/src/stdio/fgetwc.c:29   if (!first) { f->flags |= F_ERR; ... }
 *   libc-top-half/musl/src/stdio/fgetwc.c:37   if (!first) { f->flags |= F_ERR; ... }
 *
 * `__toread`'s refusal correctly sets only F_XERR, but a non-owner that has
 * already consumed >=1 byte of a multibyte character OUT OF THE SHARED BUFFER
 * (which needs no descriptor) and then hits the refusal arrives here with
 * `first == 0`, and `fgetwc` writes F_ERR into the shared FILE -- poisoning the
 * OWNER exactly as `fputwc` did before round 14.
 *
 * Reaching it only needs the buffer boundary to split a multibyte character, so
 * the file is 3-byte UTF-8 throughout.
 *
 * Native control is exact and asserts the same thing worker-wide-poison.c does:
 * native has one fd table, the sibling's read succeeds, no F_ERR, owner
 * ferror == 0.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <locale.h>

static const char *PATH = "/d/wide-read.txt";

static int failures;
#define CHECK(cond, ...)                                                       \
  do { if (!(cond)) { fprintf(stderr, "FAIL: "); fprintf(stderr, __VA_ARGS__); \
       fprintf(stderr, "\n"); failures++; } } while (0)

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int phase;
static void set_phase(int p) { pthread_mutex_lock(&mu); phase = p; pthread_cond_broadcast(&cv); pthread_mutex_unlock(&mu); }
static void await_phase(int p) { pthread_mutex_lock(&mu); while (phase < p) pthread_cond_wait(&cv, &mu); pthread_mutex_unlock(&mu); }

static FILE *rf;                /* owned by MAIN, wide, read mode */
static int worker_reads, worker_weof, worker_ferror;

static void *worker(void *arg) {
  (void)arg;
  await_phase(1);
  for (int i = 0; i < 20000; i++) {
    wint_t c = fgetwc(rf);
    if (c == WEOF) { worker_weof++; break; }
    worker_reads++;
  }
  worker_ferror = ferror(rf);
  set_phase(2);
  return NULL;
}

int main(void) {
  setlocale(LC_ALL, "C.UTF-8");            /* glibc needs this to be wide-capable */
  /* 4000 x U+20AC (E2 82 AC): every 1024-byte buffer boundary splits one. */
  FILE *w = fopen(PATH, "w");
  if (!w) { fprintf(stderr, "FAIL(harness): fopen w: %s\n", strerror(errno)); return 3; }
  for (int i = 0; i < 4000; i++) fwrite("\xe2\x82\xac", 1, 3, w);
  fclose(w);

  rf = fopen(PATH, "r");
  if (!rf) { fprintf(stderr, "FAIL(harness): fopen r: %s\n", strerror(errno)); return 3; }
  fwide(rf, 1);
  wint_t first = fgetwc(rf);               /* OWNER primes the shared buffer */
  if (first == WEOF) { fprintf(stderr, "FAIL(harness): owner's first fgetwc failed\n"); return 3; }
  CHECK(ferror(rf) == 0, "precondition: owner ferror is %d", ferror(rf));

  pthread_t t;
  if (pthread_create(&t, NULL, worker, NULL)) { fprintf(stderr, "FAIL(harness): pthread_create\n"); return 3; }
  set_phase(1); await_phase(2); pthread_join(t, NULL);

  fprintf(stderr, "info: worker reads=%d weof=%d worker_ferror=%d\n",
          worker_reads, worker_weof, worker_ferror);

  CHECK(ferror(rf) == 0,
        "owner's ferror(wide READ FILE) is %d after a sibling's fgetwc loop; "
        "native is 0 -- fgetwc.c:29/37 writes F_ERR into the SHARED FILE when a "
        "non-owner's refusal lands mid-multibyte-character, the same defect "
        "round 14 fixed in fputwc.c and did not fix here",
        ferror(rf));

  fclose(rf);
  if (failures) { fprintf(stderr, "FAILURES: %d\n", failures); return 1; }
  printf("PASS: a sibling's wide-char read does not poison the owner's ferror\n");
  return 0;
}
