#include <pthread.h>
#include <stdio.h>
#include <stdint.h>
#include <time.h>
#include <stdlib.h>
#define N 16
static volatile uint64_t sink[N];
static void *burn(void *a) {
  long id = (long)a; uint64_t acc = 0;
  for (uint64_t i = 0; i < 900000000ULL; i++) acc += i ^ (uint64_t)id;
  sink[id] = acc; return 0;
}
int main(int argc, char **argv) {
  int n = (argc > 1) ? atoi(argv[1]) : N;
  struct timespec a, b; clock_gettime(CLOCK_MONOTONIC, &a);
  pthread_t t[N];
  for (long i = 0; i < n; i++) if (pthread_create(&t[i], 0, burn, (void*)i)) { puts("spawn failed"); return 1; }
  for (int i = 0; i < n; i++) pthread_join(t[i], 0);
  clock_gettime(CLOCK_MONOTONIC, &b);
  double ms = (b.tv_sec - a.tv_sec) * 1e3 + (b.tv_nsec - a.tv_nsec) / 1e6;
  printf("threads=%d wall=%.0fms\n", n, ms);
  return 0;
}
