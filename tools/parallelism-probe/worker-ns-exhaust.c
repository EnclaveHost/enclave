/* enclave/SET repro: exhausting the per-thread fd namespaces must fail that
 * THREAD, not kill the component.
 *
 * Namespaces are monotonic (2^18 per component instance) so that a dead
 * thread's fd can never name a live thread's object. Running out is therefore
 * possible for a long-lived thread-per-task program. It used to end the whole
 * process with status 1 and NO diagnostic on either stream: the first refused
 * thread failed `__wasilibc_populate_preopens`, which reaches
 * `_Exit(EX_SOFTWARE)` — and `_Exit` here is `proc_exit`.
 *
 * Run with ENCLAVE_MAX_SET_SPAWN_RATE=0 to reach the ceiling in seconds; the
 * limit is a COUNT, not a rate.
 *
 * Expected: the loop reports failed opens and main still prints its summary.
 * A silent exit with no output is the old behaviour.
 */
#include <fcntl.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <unistd.h>

static atomic_int badopen = 0, ran = 0;

static void *task(void *a) {
    (void)a;
    int fd = open("/d", O_RDONLY);
    if (fd < 0) atomic_fetch_add(&badopen, 1);
    else close(fd);
    atomic_fetch_add(&ran, 1);
    return 0;
}

int main(void) {
    for (int i = 0; i < 262500; i++) {
        pthread_t t;
        if (pthread_create(&t, 0, task, 0) != 0) continue;
        pthread_join(t, 0);
    }
    printf("SURVIVED: ran=%d failed_open=%d\n", atomic_load(&ran), atomic_load(&badopen));
    fflush(stdout);
    return 0;
}
