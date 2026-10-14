import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

test('measured OpenMP placement preserves output, repins workers, and restores caller/child affinity',()=>{
 const d=mkdtempSync(join(tmpdir(),'shield-affinity-'));
 try {
  execFileSync('cc',['-shared','-fPIC','-O2','-Wall','-Wextra','-Werror',resolve('wasm/ggml-shielded/shielded-omp-affinity.c'),'-pthread','-ldl','-o',join(d,'place.so')]);
  writeFileSync(join(d,'test.c'),`#define _GNU_SOURCE
#include <omp.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <assert.h>
static cpu_set_t original;
static void *child(void *p) { cpu_set_t c; assert(!sched_getaffinity(0,sizeof c,&c)); assert(CPU_EQUAL(&c,&original)); return p; }
int main(void) {
 assert(!sched_getaffinity(0,sizeof original,&original));
 int cpus[6],n=0;for(int i=0;i<CPU_SETSIZE&&n<6;i++)if(CPU_ISSET(i,&original))cpus[n++]=i;
 if(n<6)return 77;
 char list[128];snprintf(list,sizeof list,"%d,%d,%d,%d,%d,%d",cpus[0],cpus[1],cpus[2],cpus[3],cpus[4],cpus[5]);
 if(!getenv("SHIELDED_CPU_COMPUTE"))setenv("SHIELDED_CPU_COMPUTE",list,1);
 for(int pass=0;pass<4;pass++) {
  int sum=0,count=pass%2?3:6;
  #pragma omp parallel num_threads(count) reduction(+:sum)
  { int i=omp_get_thread_num();cpu_set_t c;assert(!sched_getaffinity(0,sizeof c,&c));assert(CPU_COUNT(&c)==1&&CPU_ISSET(cpus[i],&c));sum+=i+1;
    /* A backend sweep can move idle workers; next region must repin them. */
    assert(!sched_setaffinity(0,sizeof original,&original)); }
  assert(sum==count*(count+1)/2);cpu_set_t now;assert(!sched_getaffinity(0,sizeof now,&now));assert(CPU_EQUAL(&now,&original));
  pthread_t t;assert(!pthread_create(&t,0,child,0));assert(!pthread_join(t,0));
 }
 puts("PASS placement, computation, sweep recovery, restoration, child inheritance");
}`);
  execFileSync('cc',['-O2','-fopenmp','-pthread',join(d,'test.c'),'-o',join(d,'test')]);
  const env={...process.env,LD_PRELOAD:join(d,'place.so')};delete env.SHIELDED_CPU_COMPUTE;
  assert.match(execFileSync(join(d,'test'),[],{env,encoding:'utf8'}),/PASS/);
  for(const value of ['0,0','0,','-1','999999','x','0 1']) {
   const r=spawnSync(join(d,'test'),[],{env:{...env,SHIELDED_CPU_COMPUTE:value},encoding:'utf8'});
   assert.equal(r.status,125,value);assert.match(r.stderr,/compute affinity/);
  }
 } finally {rmSync(d,{recursive:true,force:true});}
});
