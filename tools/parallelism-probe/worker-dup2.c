/* enclave/SET repro: dup2 on a worker must return a USABLE descriptor.
 *
 * Round 4 made dup2's target translation lenient (it had been rejecting any
 * ordinary small target on a worker with EBADF) but still returned the raw
 * `arg` rather than a descriptor in the caller's namespace — so dup2 SUCCEEDED
 * and handed back something that was EBADF on every later use, and left the
 * table slot unreachable and uncloseable. Silent success is worse than the
 * failure it replaced.
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
    if (fd < 0) { printf("%s: open failed\n", who); return 1; }
    int d = dup2(fd, 9);
    if (d < 0) { printf("FAIL %s: dup2 -> %s\n", who, strerror(errno)); return 1; }
    ssize_t w = write(d, "xy", 2);
    int c = close(d);
    if (w != 2 || c != 0) {
        printf("FAIL %s: dup2 gave %d but write=%zd close=%d (%s)\n", who, d, w, c,
               strerror(errno));
        return 1;
    }
    printf("PASS %s: dup2 -> %d, write/close ok\n", who, d);
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
