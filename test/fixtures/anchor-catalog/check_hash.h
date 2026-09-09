#include "shielded-sha256.h"
#include <stdint.h>
#include <string.h>
static void hi(void *p) { sha256_ctx c; sha_init(&c); memcpy(p,&c,sizeof c); }
static void hu(void *p,const uint8_t *b,size_t n) { sha256_ctx c; memcpy(&c,p,sizeof c); sha_update(&c,b,n); memcpy(p,&c,sizeof c); }
static void hf(void *p,uint8_t d[32]) { sha256_ctx c; memcpy(&c,p,sizeof c); sha_final(&c,d); memset(p,0,sizeof c); }
static int unhex(const char *s,uint8_t out[32]) {
    if(strlen(s)!=64) return 0;
    for(size_t i=0;i<32;i++) {
        unsigned v=0;
        for(size_t j=0;j<2;j++) { unsigned char c=s[2*i+j];
            if(c>='0'&&c<='9') c-='0'; else if(c>='a'&&c<='f') c=c-'a'+10; else return 0;
            v=(v<<4)|c;
        } out[i]=(uint8_t)v;
    } return 1;
}

static void check_sha256(const uint8_t *p,size_t n,uint8_t out[32]) {sha256_ctx c;sha_init(&c);sha_update(&c,p,n);sha_final(&c,out);}
