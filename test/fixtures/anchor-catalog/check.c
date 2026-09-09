#define _POSIX_C_SOURCE 200809L
#include "anchor_catalog.h"
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "check_hash.h"
int main(int argc,char **argv) {
    if(argc!=5 && argc!=6) return 2;
    uint8_t ch[32],mh[32]; if(!unhex(argv[3],ch)||!unhex(argv[4],mh)) return 2;
    int mf=open(argv[1],O_RDONLY),cf=open(argv[2],O_RDONLY);
    anchor_catalog_table out; char err[256]; const anchor_hash_ops h={hi,hu,hf};
    int ok=anchor_catalog_open(mf,cf,ch,mh,&h,&out,err,sizeof err);
    if(!ok) {
        if(out.table.t || out.table.header || out.authenticated_catalog) abort();
        fprintf(stderr,"REFUSED: %s\n",err); close(mf);close(cf);return 3;
    }
    if(!out.authenticated_catalog || out.table.has_whole || memcmp(out.model_identity,mh,32)) abort();
    uint8_t zero[32]={0}; if(memcmp(out.table.whole_digest,zero,32)) abort();
    /* Only requested for tiny negative fixtures; never scan the real 27B. */
    if(argc==6) {
        if(strcmp(argv[5],"--check-tensors")) return 2;
        for(size_t i=0;i<out.table.n;i++) {
            const anchor_gguf_tensor *e=&out.table.t[i];
            if(e->size>(16u<<20)) abort();
            uint8_t *b=malloc((size_t)e->size),d[32]; if(!b) abort();
            ssize_t got=pread(mf,b,(size_t)e->size,(off_t)(out.table.data_start+e->offset));
            if(got!=(ssize_t)e->size) { free(b); anchor_catalog_free(&out);close(mf);close(cf);return 4; }
            check_sha256(b,(size_t)e->size,d);free(b);
            if(memcmp(d,e->digest,32)) { anchor_catalog_free(&out);close(mf);close(cf);return 4; }
        }
    }
    printf("{\"status\":\"CATALOG_VALID\",\"tensors\":%zu,\"header_bytes\":%zu,\"has_whole\":false,\"authenticated_catalog\":true}\n",out.table.n,out.table.header_len);
    anchor_catalog_free(&out);close(mf);close(cf);return 0;
}
