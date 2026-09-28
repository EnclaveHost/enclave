#define _GNU_SOURCE
#include <omp.h>
#include <sched.h>
#include <assert.h>
#include <stdio.h>
int main(void){const int cpus[]={0,1,2,3,4,5,6,7};int count=0;cpu_set_t before,after;assert(!sched_getaffinity(0,sizeof before,&before));
#pragma omp parallel num_threads(8) reduction(+:count)
 {assert(sched_getcpu()==cpus[omp_get_thread_num()]);count++;}
 assert(count==8);assert(!sched_getaffinity(0,sizeof after,&after));assert(CPU_EQUAL(&before,&after));puts("PASS OpenMP team uses CPUs 0 through 7");}
