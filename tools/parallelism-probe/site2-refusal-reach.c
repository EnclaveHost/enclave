/* ROUND-16 ADVERSARIAL PROBE.
 *
 * Round 16 reverted fgetwc.c site 2 (`mbrtowc == -1`) to an UNCONDITIONAL
 * `F_ERR`, on the claim that "an ownership refusal cannot land here: a refused
 * `__uflow` returns EOF, so it takes the `c < 0` branch above".
 *
 * If that claim is FALSE -- if a non-owner can be driven to site 2 by the
 * refusal rather than by a genuinely malformed byte stream -- then round 16
 * re-armed the owner-poisoning bug that F_XERR exists to stop.
 *
 * This probe attacks the claim the only way the refusal can reach the byte
 * loop with `first == 0`: it makes the OWNER keep REFILLING the shared buffer
 * while a non-owner reads it, so the non-owner is refused, resumes on fresh
 * bytes, is refused again, hundreds of times, with the buffer boundary landing
 * at every offset inside a 3-byte character.  The file is entirely VALID
 * UTF-8, so any `F_ERR` on the owner's stream can only have been manufactured
 * by the ownership split.
 *
 * Native truth (no ownership, sibling just reads): owner ferror == 0.
 * r14b (round 15, site 2 = F_XERR): owner ferror == 0.
 * r14c (round 16, site 2 = F_ERR): must ALSO be 0, or the revert re-armed it.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <locale.h>

static const char *PATH = "/d/site2-refusal.txt";
static int failures;
#define CHECK(cond, ...)                                                       \
  do { if (!(cond)) { fprintf(stderr, "FAIL: "); fprintf(stderr, __VA_ARGS__); \
       fprintf(stderr, "\n"); failures++; } } while (0)

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int turn;              /* 0 = owner reads, 1 = worker reads, 2 = done */
static void set_turn(int t){pthread_mutex_lock(&mu);turn=t;pthread_cond_broadcast(&cv);pthread_mutex_unlock(&mu);}
static void await_turn(int t){pthread_mutex_lock(&mu);while(turn!=t&&turn!=2)pthread_cond_wait(&cv,&mu);pthread_mutex_unlock(&mu);}

static FILE *rf;
static long worker_reads, worker_weof, worker_calls;
static int worker_ferror;

#define ROUNDS 400

static void *worker(void *a) {
  (void)a;
  for (int r = 0; r < ROUNDS; r++) {
    await_turn(1);
    if (turn == 2) break;
    /* Read a handful of wide chars out of whatever the owner just buffered.
       Each one that straddles the buffer end drives the byte-by-byte loop to
       `first == 0` and then into a refusal. */
    for (int i = 0; i < 3; i++) {
      worker_calls++;
      wint_t c = fgetwc(rf);
      if (c == WEOF) { worker_weof++; break; }
      worker_reads++;
    }
    set_turn(0);
  }
  worker_ferror = ferror(rf);
  return NULL;
}

int main(void) {
  setlocale(LC_ALL, "C.UTF-8");
  FILE *w = fopen(PATH, "w");
  if (!w) { fprintf(stderr, "FAIL(harness): fopen w: %s\n", strerror(errno)); return 3; }
  /* ONLY valid 3-byte characters. 3 does not divide BUFSIZ, so successive
     refills split a character at a different offset every time. */
  for (int i = 0; i < 40000; i++) fwrite("\xe2\x82\xac", 1, 3, w);
  fclose(w);

  rf = fopen(PATH, "r");
  if (!rf) { fprintf(stderr, "FAIL(harness): fopen r: %s\n", strerror(errno)); return 3; }
  fwide(rf, 1);

  pthread_t t;
  if (pthread_create(&t, NULL, worker, NULL)) { fprintf(stderr, "FAIL(harness): create\n"); return 3; }

  long owner_reads = 0, owner_weof = 0;
  for (int r = 0; r < ROUNDS; r++) {
    await_turn(0);
    /* The OWNER refills the shared buffer -- this is what lets the non-owner
       resume after a refusal and reach the byte loop again. */
    for (int i = 0; i < 5; i++) {
      wint_t c = fgetwc(rf);
      if (c == WEOF) { owner_weof++; break; }
      owner_reads++;
    }
    if (r == ROUNDS - 1) { set_turn(2); break; }
    set_turn(1);
  }
  set_turn(2);
  pthread_join(t, NULL);

  int owner_ferror = ferror(rf);
  fprintf(stderr,
          "info: worker calls=%ld reads=%ld weof=%ld worker_ferror=%d | "
          "owner reads=%ld weof=%ld owner_ferror=%d\n",
          worker_calls, worker_reads, worker_weof, worker_ferror,
          owner_reads, owner_weof, owner_ferror);

  CHECK(owner_ferror == 0,
        "OWNER ferror is 1 on a file of entirely VALID UTF-8: the ownership "
        "split manufactured an EILSEQ that reached fgetwc.c site 2, whose "
        "round-16 UNCONDITIONAL F_ERR then poisoned the owner's stream");
  CHECK(worker_calls > 100, "harness never interleaved (calls=%ld)", worker_calls);

  fclose(rf);
  if (failures) { fprintf(stderr, "FAILURES: %d\n", failures); return 1; }
  printf("PASS: a refusal cannot manufacture a site-2 EILSEQ\n");
  return 0;
}
