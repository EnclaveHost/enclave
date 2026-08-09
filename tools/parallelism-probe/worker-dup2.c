/* enclave/SET repro: the dup2/dup3 target contract, which has now been wrong
 * in FOUR different ways across four rounds.
 *
 *   r5: refused every ordinary target on a worker, so dup2(fd, STDOUT_FILENO)
 *       failed there.
 *   r6: returned the raw `arg`, so dup2 reported SUCCESS and handed back a
 *       descriptor that was EBADF on every later use — and uncloseable.
 *   r7: returned a namespace-tagged fd, which a caller that passed its own
 *       constant could not then use.
 *   r7 again: guarded the refusal on `set_fd_ns > 0` as a stand-in for "am I a
 *       worker". It is not that predicate — a namespace is claimed lazily by
 *       index_to_fd, which returns 0/1/2 WITHOUT claiming — so before its first
 *       descriptor at index >= 3 EVERY thread, the main one included, fell into
 *       the r6 hole. The previous version of this probe open()ed first and so
 *       could not see it. `unclaimed()` below is that case.
 *
 * The contract, stated once:
 *
 *   MAIN thread   — identical to a stock wasip2 build, for every target.
 *   WORKER, target already in its own namespace — POSIX.
 *   WORKER, target 0/1/2 — REFUSED, EBADF.  Not a namespace question: musl's
 *       `stdout` is ONE FILE in shared memory, so a worker's dup2(f, 1)
 *       redirected only its own table entry while the shared buffer was still
 *       flushed through MAIN's fd 1 — the operator's process stdout. A guest
 *       redirecting into its sandbox had its bytes delivered to the host log.
 *   WORKER, any other bare target — REFUSED, EBADF.
 *
 * Every check below FAILS LOUDLY and sets the exit status; "PASS" lines are
 * not the pass criterion, the exit code is.
 *
 * Expected: "ALL PASS" and exit 0.
 */
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int failures = 0;

#define CHECK(cond, ...)                                                       \
    do {                                                                       \
        if (!(cond)) {                                                         \
            fprintf(stderr, "FAIL %s: ", who);                                 \
            fprintf(stderr, __VA_ARGS__);                                      \
            fputc('\n', stderr);                                               \
            __atomic_fetch_add(&failures, 1, __ATOMIC_RELAXED);                \
        }                                                                      \
    } while (0)

/* The r7 hole: a bare target BEFORE this thread has created any descriptor at
   index >= 3, i.e. before it has claimed a namespace. On the main thread this
   must behave exactly as a stock build does. */
static void unclaimed(const char *who, int worker) {
    int d = dup2(2, 9);
    if (worker) {
        CHECK(d < 0 && errno == EBADF,
              "worker dup2(2,9) with no namespace yet returned %d (errno %s); a "
              "bare target on a worker must be EBADF",
              d, strerror(errno));
        if (d >= 0) close(d);
        return;
    }
    CHECK(d == 9, "main dup2(2,9) returned %d, want 9", d);
    if (d < 0)
        return;
    /* The r6/r7 symptom was success here followed by EBADF forever. */
    ssize_t w = write(d, "", 0);
    int c = close(d);
    CHECK(w == 0 && c == 0,
          "main dup2(2,9) reported success but write=%zd close=%d (%s) — the "
          "returned descriptor is not resolvable",
          w, c, strerror(errno));
}

static void contract(const char *who, int worker, const char *path) {
    int before = __atomic_load_n(&failures, __ATOMIC_RELAXED);
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    CHECK(fd >= 0, "open(%s) -> %s", path, strerror(errno));
    if (fd < 0)
        return;

    /* self-dup: POSIX returns the fd without closing it; dup3 is EINVAL. */
    CHECK(dup2(fd, fd) == fd, "dup2(fd,fd) must return fd");
    CHECK(dup3(fd, fd, 0) < 0 && errno == EINVAL, "dup3(fd,fd,0) must be EINVAL");

    /* a target in this thread's own namespace: POSIX, on every thread. */
    int mine = dup(fd);
    CHECK(mine >= 0, "dup(fd) -> %s", strerror(errno));
    if (mine >= 0) {
        int d = dup2(fd, mine);
        CHECK(d == mine, "dup2(fd, own) returned %d, want %d", d, mine);
        if (d >= 0) {
            CHECK(write(d, "z", 1) == 1, "write to dup2(fd, own) -> %s",
                  strerror(errno));
            CHECK(close(d) == 0, "close(dup2(fd, own)) -> %s", strerror(errno));
        }
    }

    /* redirecting a standard stream. Main: POSIX. Worker: refused, because the
       FILE behind it is shared even though the fd table is not. */
    int saved = worker ? -1 : dup(1);
    int d = dup2(fd, 1);
    if (worker) {
        CHECK(d < 0 && errno == EBADF,
              "worker dup2(fd,1) returned %d (errno %s); a worker may not "
              "redirect a standard stream — the FILE is shared",
              d, strerror(errno));
    } else {
        CHECK(d == 1, "main dup2(fd,1) returned %d, want 1", d);
        if (d >= 0) {
            CHECK(write(d, "xy", 2) == 2, "main write after dup2(fd,1) -> %s",
                  strerror(errno));
        }
        if (saved >= 0) {
            dup2(saved, 1);
            close(saved);
        }
    }

    /* a tagged spelling of index 1. index_to_fd never emits one, so honouring
       it gave stdout a second name that dup2 would accept: on a worker this
       silently redirected that thread's stdout into the guest's own file. */
    int tagged_stdout = (1 << 13) | 1;
    int t = dup2(fd, tagged_stdout);
    CHECK(t < 0 && errno == EBADF,
          "dup2(fd, %d) returned %d; a tagged spelling of 0/1/2 is not a "
          "descriptor number this thread was ever handed",
          tagged_stdout, t);
    if (t >= 0)
        close(t);

    close(fd);
    if (__atomic_load_n(&failures, __ATOMIC_RELAXED) == before)
        fprintf(stderr, "PASS %s: dup2/dup3 contract\n", who);
}

static void *worker_main(void *arg) {
    const char *who = "worker";
    unclaimed(who, 1);
    contract(who, 1, (const char *)arg);
    return NULL;
}

int main(void) {
    const char *who = "main";
    /* BEFORE anything else: main must not have claimed a namespace yet. */
    unclaimed(who, 0);

    pthread_t t;
    if (pthread_create(&t, NULL, worker_main, (void *)"/d/dup2-worker.txt") != 0) {
        fprintf(stderr, "FAIL: pthread_create -> %s\n", strerror(errno));
        return 1;
    }
    contract(who, 0, "/d/dup2-main.txt");
    pthread_join(t, NULL);

    int f = __atomic_load_n(&failures, __ATOMIC_RELAXED);
    if (f) {
        fprintf(stderr, "FAILURES: %d\n", f);
        return 1;
    }
    fprintf(stderr, "ALL PASS\n");
    return 0;
}
