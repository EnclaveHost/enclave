/* LAB ONLY: bind OpenMP compute threads to one L3 domain on this EPYC.
 * No input/output buffer is inspected or altered. Never a release artifact. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
typedef void (*par_fn)(void(*)(void*),void*,unsigned,unsigned);
static par_fn run;
static int (*tid)(void);
static pthread_once_t once=PTHREAD_ONCE_INIT;
static void resolve(void){
 void *h=dlopen("libgomp.so.1",RTLD_NOW|RTLD_LOCAL);
 if(h){run=(par_fn)dlsym(h,"GOMP_parallel");tid=(int(*)(void))dlsym(h,"omp_get_thread_num");}
 if(!run||!tid){fputs("LAB omp placement resolution failed\n",stderr);_exit(125);}
}
struct call {void(*fn)(void*);void *data;};
static void invoke(void *arg){
 struct call *c=arg;int n=tid();const int cpus[]={0,1,2,3,4,5,6,7};
 if(n>=0&&n<8){cpu_set_t want,cur;CPU_ZERO(&want);CPU_SET(cpus[n],&want);
  if(sched_getaffinity(0,sizeof cur,&cur)||(!CPU_EQUAL(&cur,&want)&&sched_setaffinity(0,sizeof want,&want))){perror("LAB omp affinity");_exit(126);}}
 c->fn(c->data);
}
void GOMP_parallel(void(*fn)(void*),void *data,unsigned n,unsigned flags){
 pthread_once(&once,resolve);cpu_set_t original;
 if(sched_getaffinity(0,sizeof original,&original)){perror("LAB original affinity");_exit(126);}
 struct call c={fn,data};run(invoke,&c,n,flags);
 /* Restore the caller: children created between regions must not inherit one CPU. */
 if(sched_setaffinity(0,sizeof original,&original)){perror("LAB restore affinity");_exit(126);}
}
