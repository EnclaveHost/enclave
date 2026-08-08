#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static void *worker(void *arg) {
    (void)arg;
    puts("worker: about to flush");
    fflush(stdout);            /* forces fd_write / stream write on THIS thread */
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);   /* forces a clock import on THIS thread */
    printf("worker: clock=%lld.%09ld\n", (long long)ts.tv_sec, ts.tv_nsec);
    fflush(stdout);
    return (void *)42;
}

int main(void) {
    pthread_t t;
    printf("main: before spawn\n");
    fflush(stdout);
    int rc = pthread_create(&t, NULL, worker, NULL);
    void *ret = NULL;
    if (rc == 0) pthread_join(t, &ret);
    printf("main: joined, worker returned %ld\n", (long)ret);
    return 0;
}
