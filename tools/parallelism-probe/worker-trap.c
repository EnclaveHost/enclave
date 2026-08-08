#include <pthread.h>
#include <stdio.h>

static void *worker(void *arg) {
    (void)arg;
    puts("worker: about to trap");
    fflush(stdout);
    __builtin_trap();          /* unreachable -> the thread dies by TRAP */
    return (void *)7;
}

int main(void) {
    pthread_t t;
    printf("main: spawning a worker that will trap\n");
    fflush(stdout);
    if (pthread_create(&t, NULL, worker, NULL) != 0) return 1;
    void *ret = NULL;
    pthread_join(t, &ret);     /* must NOT hang */
    printf("main: joined a trapped worker, ret=%p\n", ret);
    return 0;
}
