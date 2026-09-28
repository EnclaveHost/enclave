/* Measured OpenMP compute-team placement. No tensor or verification data is touched. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

typedef void (*parallel_fn)(void (*)(void *), void *, unsigned, unsigned);
static parallel_fn parallel;
static int (*thread_num)(void);
static int cpus[CPU_SETSIZE], count;
static pthread_once_t once = PTHREAD_ONCE_INIT;

static void fail(const char *what) {
    fprintf(stderr, "[shielded] compute affinity: %s\n", what);
    _exit(125);
}
static void init(void) {
    void *lib = dlopen("libgomp.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!lib) fail("libgomp unavailable");
    parallel = (parallel_fn)dlsym(lib, "GOMP_parallel");
    thread_num = (int (*)(void))dlsym(lib, "omp_get_thread_num");
    if (!parallel || !thread_num) fail("OpenMP symbols unavailable");
    const char *s = getenv("SHIELDED_CPU_COMPUTE");
    if (!s || !*s) return;
    cpu_set_t allowed, seen;
    if (sched_getaffinity(0, sizeof allowed, &allowed)) fail("cannot read allowed CPUs");
    CPU_ZERO(&seen);
    for (;;) {
        if (*s < '0' || *s > '9') fail("invalid compute CPU list");
        char *end; long cpu = strtol(s, &end, 10);
        if (cpu < 0 || cpu >= CPU_SETSIZE || count == CPU_SETSIZE ||
            !CPU_ISSET(cpu, &allowed) || CPU_ISSET(cpu, &seen)) fail("unavailable or duplicate compute CPU");
        cpus[count++] = (int)cpu; CPU_SET(cpu, &seen);
        if (!*end) break;
        if (*end != ',' || !end[1]) fail("invalid compute CPU separator");
        s = end + 1;
    }
}
struct call { void (*fn)(void *); void *data; };
static void invoke(void *arg) {
    struct call *c = arg;
    int n = thread_num();
    if (n < 0 || n >= count) fail("compute team exceeds assigned CPUs");
    cpu_set_t desired, current;
    CPU_ZERO(&desired); CPU_SET(cpus[n], &desired);
    if (sched_getaffinity(0, sizeof current, &current) ||
        (!CPU_EQUAL(&current, &desired) && sched_setaffinity(0, sizeof desired, &desired)))
        fail("cannot place compute thread");
    c->fn(c->data);
}
void GOMP_parallel(void (*fn)(void *), void *data, unsigned threads, unsigned flags) {
    pthread_once(&once, init);
    if (!count) { parallel(fn, data, threads, flags); return; }
    cpu_set_t original;
    if (sched_getaffinity(0, sizeof original, &original)) fail("cannot save caller affinity");
    struct call c = {fn, data};
    parallel(invoke, &c, threads, flags);
    /* Children created between regions must not inherit the compute leader's CPU. */
    if (sched_setaffinity(0, sizeof original, &original)) fail("cannot restore caller affinity");
}
