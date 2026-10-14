#define _GNU_SOURCE
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <assert.h>
#include "shielded-field.h"
#include "shielded-simd.h"
void sh_chacha20_block(const uint32_t*,uint64_t,uint32_t*);
static double now(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec+t.tv_nsec*1e-9;}
static uint32_t rng=731;static uint32_t next(void){rng=rng*1664525+1013904223;return rng;}
static void scalar(const uint32_t*k,uint64_t ctr,int32_t*out,size_t n){size_t at=0;while(at<n){uint32_t x[16];sh_chacha20_block(k,ctr++,x);for(int j=0;j<8&&at<n;j++)out[at++]=(((uint64_t)x[2*j+1]<<32)|x[2*j])%SH_M_MOD;}}
int main(void){
 const int shapes[][3]={{5120,2560,16},{5120,8704,64},{17408,2560,32},{5120,124160,16}};
 uint32_t key[8]={1,2,3,4,5,6,7,8};
 for(int shape=0;shape<4;shape++){int K=shapes[shape][0],N=shapes[shape][1],B=shapes[shape][2];
 int8_t*w=malloc((size_t)K*N);int32_t*r=malloc((size_t)B*K*4),*u=malloc((size_t)B*N*4),*ref=malloc((size_t)B*N*4),*acc=malloc((size_t)12*N*4);uint8_t*p=malloc((size_t)3*B*K);assert(w&&r&&u&&ref&&acc&&p);
 for(size_t i=0;i<(size_t)K*N;i++)w[i]=(int)(next()%239)-119;
 for(int round=-1;round<8;round++)for(int order=0;order<2;order++){
  int fast=round<0?order:(round%2?1-order:order);double t=now();
  if(fast)sh_simd_avx512_mask_stream(key,1337,r,(size_t)B*K);else scalar(key,1337,r,(size_t)B*K);
  double t1=now();sh_simd_avx512_pad_planes(r,(size_t)B*K,p,p+(size_t)B*K,p+(size_t)2*B*K);
  double t2=now();sh_simd_avx512_refill_vector_crt(p,B,w,K,N,u,N,acc);double t3=now();
  if(round<0&&!fast)memcpy(ref,u,(size_t)B*N*4);else assert(!memcmp(ref,u,(size_t)B*N*4));
  if(round>=0)printf("{\"shape\":[%d,%d,%d],\"fast\":%d,\"round\":%d,\"sampler_ms\":%.6f,\"planes_ms\":%.6f,\"product_ms\":%.6f,\"total_ms\":%.6f,\"exact\":true}\n",K,N,B,fast,round,(t1-t)*1000,(t2-t1)*1000,(t3-t2)*1000,(t3-t)*1000);
 }
 free(w);free(r);free(u);free(ref);free(acc);free(p);
 }
}
