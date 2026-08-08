/* enclave/SET repro: dup2 on a worker must return a USABLE descriptor.
 *
 * This has been wrong in three different ways across three rounds: rejecting
 * every ordinary target on a worker; returning the raw `arg` so dup2 SUCCEEDED
 * and handed back something EBADF on every later use; and returning a tagged
 * descriptor that a caller using the constant it passed could not use.
 * The contract now: targets a thread can legitimately name — 0/1/2, or a
 * descriptor already in its own namespace — behave exactly as POSIX says, on
 * every thread. That covers `dup2(fd, STDOUT_FILENO)`, which is the real use.
 * An arbitrary bare target on a worker is REFUSED rather than half-served.
 *
 * Expected: "PASS" from both threads.
 */
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int check(const char *who, const char *path) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) { fprintf(stderr, "%s: open failed\n", who); return 1; }
    /* `dup2(fd, 1)` — redirecting a standard stream — is the whole real-world
       use, and it must work identically on every thread. An arbitrary bare
       target on a worker is refused rather than half-served; see
       descriptor_table.c. */
    int saved = dup(1);
    int d = dup2(fd, 1);
    if (d < 0) { fprintf(stderr, "FAIL %s: dup2 -> %s\n", who, strerror(errno)); return 1; }
    if (d != 1) { fprintf(stderr, "FAIL %s: dup2(fd,1) returned %d, not 1\n", who, d); return 1; }
    ssize_t w = write(d, "xy", 2);
    int c = close(d);
    if (saved >= 0) { dup2(saved, 1); close(saved); }
    if (w != 2 || c != 0) {
        fprintf(stderr, "FAIL %s: dup2 gave %d but write=%zd close=%d (%s)\n", who, d, w, c,
               strerror(errno));
        return 1;
    }
    fprintf(stderr, "PASS %s: dup2(fd,1) -> %d, write/close ok\n", who, d);
    close(fd);
    return 0;
}

static int wrc = 0;
static void *worker(void *arg) { (void)arg; wrc = check("worker", "/d/dw.txt"); return 0; }

int main(void) {
    pthread_t t;
    if (pthread_create(&t, 0, worker, 0) != 0) return 1;
    pthread_join(t, 0);
    int mrc = check("main", "/d/dm.txt");
    fflush(stdout);
    return wrc | mrc;
}
