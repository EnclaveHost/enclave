#define _GNU_SOURCE
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <dlfcn.h>
#include <assert.h>
#include "shielded-field.h"
typedef void (*refill_fn)(const uint8_t*,int,const int8_t*,int64_t,int64_t,int32_t*,int64_t,int32_t*);
typedef void (*planes_fn)(const int32_t*,size_t,uint8_t*,uint8_t*,uint8_t*);
static double now(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec+t.tv_nsec*1e-9;}
static uint32_t rng=731;static uint32_t next(void){rng=rng*1664525+1013904223;return rng;}
int main(int argc,char **argv){
 assert(argc>=3);int nlib=argc-1;refill_fn f[16];planes_fn planes=0;
 for(int i=0;i<nlib;i++){void*h=dlopen(argv[i+1],RTLD_NOW|RTLD_LOCAL);if(!h){puts(dlerror());return 1;}f[i]=(refill_fn)dlsym(h,"sh_simd_avx512_refill_vector_crt");assert(f[i]);if(!planes)planes=(planes_fn)dlsym(h,"sh_simd_avx512_pad_planes");}
 const int shapes[][3]={{5120,2560,16},{5120,8704,64},{17408,2560,32},{5120,124160,16}};
 for(int s=0;s<4;s++){int K=shapes[s][0],N=shapes[s][1],B=shapes[s][2];
 int8_t*w=malloc((size_t)K*N);int32_t*r=malloc((size_t)B*K*4),*u=malloc((size_t)B*N*4),*ref=malloc((size_t)B*N*4),*acc=malloc((size_t)12*N*4);uint8_t*p=malloc((size_t)3*B*K);assert(w&&r&&u&&ref&&acc&&p);
 for(size_t i=0;i<(size_t)K*N;i++)w[i]=(int)(next()%239)-119;
 for(size_t i=0;i<(size_t)B*K;i++)r[i]=next()%SH_M_MOD;
 planes(r,(size_t)B*K,p,p+(size_t)B*K,p+(size_t)2*B*K);f[0](p,B,w,K,N,ref,N,acc);
 for(int round=0;round<8;round++)for(int ix=0;ix<nlib;ix++){int i=round%2?nlib-1-ix:ix;double t=now();f[i](p,B,w,K,N,u,N,acc);t=now()-t;assert(memcmp(ref,u,(size_t)B*N*4)==0);printf("{\"shape\":[%d,%d,%d],\"variant\":\"%s\",\"round\":%d,\"ms\":%.6f,\"exact\":true}\n",K,N,B,argv[i+1],round,t*1000);fflush(stdout);}
 free(w);free(r);free(u);free(ref);free(acc);free(p);
 }
}
