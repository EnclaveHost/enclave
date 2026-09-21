/* LD_PRELOAD counter for OpenMP parallel regions: how many GOMP_parallel
 * calls a process makes and how long they take in total, per thread-count.
 * Prints at exit. Pure accounting; the regions run exactly as before. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
static unsigned long long n_calls[65], t_ns[65];
static unsigned long long n_total;
static double now(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec * 1e9 + ts.tv_nsec; }
static void (*real_parallel)(void (*)(void *), void *, unsigned, unsigned);
void GOMP_parallel(void (*fn)(void *), void *data, unsigned nthreads, unsigned flags) {
    if (!real_parallel) real_parallel = dlsym(RTLD_NEXT, "GOMP_parallel");
    unsigned k = nthreads > 64 ? 64 : nthreads;
    double t0 = now();
    real_parallel(fn, data, nthreads, flags);
    t_ns[k] += (unsigned long long)(now() - t0); n_calls[k]++; n_total++;
}
__attribute__((destructor)) static void report(void) {
    fprintf(stderr, "[ompprof] GOMP_parallel calls=%llu\n", n_total);
    for (int k = 0; k <= 64; k++) if (n_calls[k])
        fprintf(stderr, "[ompprof]   nthreads=%d calls=%llu total=%.1f ms mean=%.1f us\n", k, n_calls[k], t_ns[k] / 1e6, t_ns[k] / 1e3 / n_calls[k]);
}
