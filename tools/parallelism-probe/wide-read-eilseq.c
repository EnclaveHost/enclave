/* enclave/SET round-15 REVIEW probe: fgetwc.c's SECOND F_XERR site is not an
 * ownership refusal at all -- it is a genuine ENCODING error (EILSEQ), reached
 * entirely out of the SHARED BUFFER with getc_unlocked SUCCEEDING.  Round 15
 * applied the "refusal is the caller's error" rule to it anyway
 * (`/ * enclave/SET: see above. * /`), so a malformed multibyte sequence found
 * by a non-owner is now reported as F_XERR -- which `ferror()` DISCARDS for the
 * owner.  The owner therefore reads ferror == 0 for a real, sticky stream error
 * that native reports as 1.
 *
 *   fgetwc.c:29  c < 0        -> a refusal CAN land here (round 15 correct)
 *   fgetwc.c:37  l == (size_t)-1 -> mbrtowc rejected a byte getc_unlocked
 *                                already RETURNED; no descriptor was touched
 */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <locale.h>

static const char *PATH = "/d/wide-eilseq.txt";
static int failures;
#define CHECK(cond, ...)                                                       \
  do { if (!(cond)) { fprintf(stderr, "FAIL: "); fprintf(stderr, __VA_ARGS__); \
       fprintf(stderr, "\n"); failures++; } } while (0)

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int phase;
static void set_phase(int p){pthread_mutex_lock(&mu);phase=p;pthread_cond_broadcast(&cv);pthread_mutex_unlock(&mu);}
static void await_phase(int p){pthread_mutex_lock(&mu);while(phase<p)pthread_cond_wait(&cv,&mu);pthread_mutex_unlock(&mu);}

static FILE *rf;
static int worker_reads, worker_weof, worker_ferror, worker_errno;

static void *worker(void *a) {
  (void)a;
  await_phase(1);
  errno = 0;
  for (int i = 0; i < 200; i++) {
    wint_t c = fgetwc(rf);
    if (c == WEOF) { worker_weof++; break; }
    worker_reads++;
  }
  worker_errno = errno;
  worker_ferror = ferror(rf);
  set_phase(2);
  return NULL;
}

int main(void) {
  setlocale(LC_ALL, "C.UTF-8");
  FILE *w = fopen(PATH, "w");
  if (!w) { fprintf(stderr, "FAIL(harness): fopen w: %s\n", strerror(errno)); return 3; }
  /* 4 valid U+20AC, then E2 41 -- a valid 3-byte LEAD followed by an invalid
     continuation, so mbrtowc returns -2 (first := 0) and then -1. */
  for (int i = 0; i < 4; i++) fwrite("\xe2\x82\xac", 1, 3, w);
  fwrite("\xe2\x41", 1, 2, w);
  fwrite("ZZZZ", 1, 4, w);
  fclose(w);

  rf = fopen(PATH, "r");
  if (!rf) { fprintf(stderr, "FAIL(harness): fopen r: %s\n", strerror(errno)); return 3; }
  fwide(rf, 1);
  wint_t first = fgetwc(rf);           /* OWNER primes the shared buffer */
  if (first == WEOF) { fprintf(stderr, "FAIL(harness): owner's first fgetwc failed\n"); return 3; }
  CHECK(ferror(rf) == 0, "precondition: owner ferror is %d", ferror(rf));

  pthread_t t;
  if (pthread_create(&t, NULL, worker, NULL)) { fprintf(stderr, "FAIL(harness): pthread_create\n"); return 3; }
  set_phase(1); await_phase(2); pthread_join(t, NULL);

  fprintf(stderr, "info: worker reads=%d weof=%d worker_ferror=%d worker_errno=%d(%s)\n",
          worker_reads, worker_weof, worker_ferror, worker_errno, strerror(worker_errno));
  fprintf(stderr, "info: OWNER ferror after the sibling hit the bad sequence = %d\n", ferror(rf));

  CHECK(worker_weof == 1, "worker never hit the malformed sequence (weof=%d reads=%d)",
        worker_weof, worker_reads);
  CHECK(ferror(rf) != 0,
        "owner's ferror is 0 after a sibling's fgetwc hit a REAL encoding error "
        "in the SHARED buffer; native is 1 -- fgetwc.c:37 is not an ownership "
        "refusal (getc_unlocked SUCCEEDED) and must not be downgraded to F_XERR, "
        "which ferror() then discards for the owner and erases entirely");

  fclose(rf);
  if (failures) { fprintf(stderr, "FAILURES: %d\n", failures); return 1; }
  printf("PASS: a real encoding error found by a sibling is visible to the owner\n");
  return 0;
}
