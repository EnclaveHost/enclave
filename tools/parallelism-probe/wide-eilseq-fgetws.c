/* enclave/SET round-15 REVIEW probe #2 for fgetwc.c:37 (the EILSEQ site):
 *  (a) `fgetws` on a non-owner now SILENTLY TRUNCATES where it used to return
 *      NULL -- the internal `ferror` macro cannot see F_XERR;
 *  (b) the downgraded error is not merely hidden from the owner, it is ERASED:
 *      `ferror()` clears F_XERR for the owner, after which even the refusing
 *      thread reads 0.  A real, sticky stream error vanishes.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <locale.h>

static const char *PATH = "/d/wide-eilseq2.txt";
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
static wchar_t wbuf[64];
static wchar_t *ws_ret; static int ws_null;
static int worker_ferror_1, worker_ferror_2;

static void *worker(void *a) {
  (void)a;
  await_phase(1);
  ws_ret = fgetws(wbuf, 64, rf);
  ws_null = (ws_ret == NULL);
  worker_ferror_1 = ferror(rf);
  set_phase(2);
  await_phase(3);              /* main has now called ferror() once */
  worker_ferror_2 = ferror(rf);
  set_phase(4);
  return NULL;
}

int main(void) {
  setlocale(LC_ALL, "C.UTF-8");
  FILE *w = fopen(PATH, "w");
  if (!w) { fprintf(stderr, "FAIL(harness): fopen w\n"); return 3; }
  for (int i = 0; i < 4; i++) fwrite("\xe2\x82\xac", 1, 3, w);
  fwrite("\xe2\x41", 1, 2, w);
  fwrite("ZZZZ\n", 1, 5, w);
  fclose(w);

  rf = fopen(PATH, "r");
  if (!rf) { fprintf(stderr, "FAIL(harness): fopen r\n"); return 3; }
  fwide(rf, 1);
  if (fgetwc(rf) == WEOF) { fprintf(stderr, "FAIL(harness): prime\n"); return 3; }

  pthread_t t;
  if (pthread_create(&t, NULL, worker, NULL)) { fprintf(stderr, "FAIL(harness): create\n"); return 3; }
  set_phase(1); await_phase(2);

  int owner_ferror = ferror(rf);           /* the owner's ONE look */
  set_phase(3); await_phase(4);
  pthread_join(t, NULL);

  fprintf(stderr, "info: fgetws -> %s, chars=%zu, worker ferror before=%d after-owner-look=%d, owner ferror=%d\n",
          ws_null ? "NULL" : "non-NULL", ws_null ? (size_t)0 : wcslen(wbuf),
          worker_ferror_1, worker_ferror_2, owner_ferror);

  CHECK(ws_null,
        "fgetws on a sibling returned a TRUNCATED string instead of NULL after a "
        "real encoding error; native returns NULL. fgetwc.c:37 now sets F_XERR, "
        "which fgetws' internal `ferror` MACRO cannot see");
  CHECK(worker_ferror_2 != 0,
        "the encoding error was ERASED: after the owner's ferror() cleared F_XERR "
        "even the thread that hit it reads ferror==0; native keeps it sticky");
  CHECK(owner_ferror != 0, "owner ferror is 0; native is 1");

  fclose(rf);
  if (failures) { fprintf(stderr, "FAILURES: %d\n", failures); return 1; }
  printf("PASS\n");
  return 0;
}
