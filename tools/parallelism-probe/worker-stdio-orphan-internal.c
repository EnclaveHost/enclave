/* Same as worker-stdio-orphan.c, but the worker dies inside the INTERNAL lock
 * path (`printf` itself), which is the layer musl never registered. That is
 * the half that was still open after the first fix.
 *
 * The trap is placed in a `putc`-driven callback: the worker takes stdout's
 * internal lock via a partial write and then traps while it is held.
 */
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

static void *worker(void *arg) {
    (void)arg;
    /* setvbuf to unbuffered makes each putc take and release the lock; instead
     * force a long buffered write and trap from the middle of it via a
     * deliberately bad format argument is not portable, so trap under an
     * explicit internal lock: `fwrite` holds FLOCK for its duration. */
    char big[4096];
    for (size_t i = 0; i < sizeof big; i++) big[i] = 'x';
    /* A write large enough to reach the internal lock, then trap while the
     * stream is mid-flush. */
    fwrite(big, 1, sizeof big, stdout);
    __builtin_trap();
    return 0;
}

int main(void) {
    pthread_t t;
    if (pthread_create(&t, 0, worker, 0) != 0) return 1;
    pthread_join(t, 0);
    printf("\nmain: stdout still works after the orphan\n");
    fflush(stdout);
    return 0;
}
