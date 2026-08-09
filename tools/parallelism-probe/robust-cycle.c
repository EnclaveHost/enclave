/* enclave/SET round-14 review probe: the robust-list walk that round 14 bounded
 * has an IDENTICAL, UNBOUNDED twin 250 lines above it in the same file.
 *
 *   pthread_create.c:457  __enclave_set_thread_died   -- bounded in r14a
 *                                                        (`robust_guard > 4096`)
 *   pthread_create.c:208  __pthread_exit              -- STILL UNBOUNDED
 *
 * Both walk `self->robust_list` while holding `__thread_list_lock`, and both
 * follow `_m_next` pointers that live in guest-writable memory -- which is the
 * entire hazard the round-14 comment states ("A cycle -- forged, or merely torn
 * by a trap mid-update -- would spin here forever and wedge every sibling's
 * pthread_create/pthread_join permanently at zero CPU"). `__pthread_exit` is
 * the path EVERY NORMALLY-EXITING thread takes.
 *
 * The list is not exotic: musl links EVERY non-NORMAL mutex into
 * `self->robust_list` (pthread_mutex_trylock.c, after `success:`), so a plain
 * PTHREAD_MUTEX_RECURSIVE mutex populates it. `pthread_mutexattr_setrobust`
 * returning EINVAL under wasi-libc does not make this walk dead code.
 *
 * argv[1] selects which death path the worker takes:
 *   exit  -- worker returns normally      -> __pthread_exit's walk (line 208)
 *   trap  -- worker executes an unreachable -> the death hook's walk (line 457)
 *
 * NO NATIVE CONTROL IS POSSIBLE for the forged-cycle arm: glibc's robust list
 * has a different layout and is walked by the KERNEL, which bounds itself with
 * ROBUST_LIST_LIMIT. The native build therefore runs the SAME program WITHOUT
 * forging, and establishes only that the program terminates. The failure being
 * tested -- the component never makes progress again -- needs no native
 * reference to be a failure.
 */
#define _GNU_SOURCE
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static pthread_mutex_t rm;
static int do_forge;
static int mode_trap;

static void *nothing(void *a) { (void)a; return NULL; }

static void *worker(void *a) {
  (void)a;
  pthread_mutex_lock(&rm);            /* RECURSIVE -> links into robust_list */
  if (do_forge) {
    /* _m_next is __u.__p[4]; make the list a self-cycle. */
    void **p = (void **)&rm;
    p[4] = (void *)&p[4];
  }
  fprintf(stderr, "worker: linked%s, dying via %s\n",
          do_forge ? "+forged" : "", mode_trap ? "trap" : "return");
  fflush(stderr);
  if (mode_trap) __builtin_trap();
  return NULL;                        /* -> __pthread_exit */
}

int main(int argc, char **argv) {
  mode_trap = argc > 1 && !strcmp(argv[1], "trap");
#ifdef __wasm__
  do_forge = 1;
#else
  do_forge = 0;                       /* see header: no portable native analogue */
#endif

  pthread_mutexattr_t a;
  pthread_mutexattr_init(&a);
  pthread_mutexattr_settype(&a, PTHREAD_MUTEX_RECURSIVE);
  pthread_mutex_init(&rm, &a);

  pthread_t t;
  if (pthread_create(&t, NULL, worker, NULL)) { fprintf(stderr, "FAIL(harness): create\n"); return 3; }

  /* Give the worker time to die, then prove the component still makes
     progress: pthread_create needs __thread_list_lock, which a spinning
     robust walk holds forever. */
  struct timespec ts = {0, 300 * 1000 * 1000};
  nanosleep(&ts, NULL);

  fprintf(stderr, "main: attempting a second pthread_create (needs __thread_list_lock)\n");
  fflush(stderr);
  pthread_t t2;
  if (pthread_create(&t2, NULL, nothing, NULL)) { fprintf(stderr, "FAIL: second create failed\n"); return 1; }
  pthread_join(t2, NULL);
  fprintf(stderr, "main: second create+join OK\n");
  printf("PASS: component still makes progress after the worker died\n");
  return 0;
}
