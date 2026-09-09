#include "anchor_catalog.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* AGCAT001: 112-byte fixed header, 216-byte entries, integers little endian.
 * Header: magic[8], tensor_count:u32, gguf_version:u32, file_size:u64,
 * header_len:u64, data_start:u64, alignment:u64, model_sha256[32], header_sha256[32].
 * Entry: name[128] canonical zero padding, n_dims:u32, type:u32, ne[4]:u64,
 * relative_offset:u64, byte_length:u64, tensor_sha256[32]. Entries sorted by offset.
 * No trailing bytes, optional fields, inferred digests or writable authority. */
#define FIXED 112u
#define ENTRY 216u
#define MAX_TENSORS 65536u
#define MAX_HEADER (256u << 20)
static uint32_t u32(const uint8_t *p) {
    return (uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
}
static uint64_t u64(const uint8_t *p) {
    uint64_t v=0; for(int i=7;i>=0;--i) v=(v<<8)|p[i]; return v;
}
static int read_exact(int fd, uint8_t *p, size_t n) {
    size_t at=0;
    while(at<n) {
        ssize_t r=pread(fd,p+at,n-at,(off_t)at);
        if(r<0 && errno==EINTR) continue;
        if(r<=0) return 0;
        at+=(size_t)r;
    }
    return 1;
}
static void digest(const anchor_hash_ops *h, const uint8_t *p, size_t n, uint8_t out[32]) {
    union { max_align_t alignment; uint8_t bytes[256]; } ctx;
    h->init(ctx.bytes); h->update(ctx.bytes,p,n); h->final(ctx.bytes,out);
}
void anchor_catalog_free(anchor_catalog_table *out) {
    if(out) { anchor_gguf_free(&out->table); memset(out,0,sizeof *out); }
}
int anchor_catalog_open(int model_fd, int catalog_fd,
        const uint8_t expected_catalog[32], const uint8_t expected_model[32],
        const anchor_hash_ops *h, anchor_catalog_table *out, char *err, size_t errcap) {
    uint8_t *cat=NULL,*hdr=NULL,hash[32]; struct stat cs,ms;
    const char *why="invalid catalog arguments";
    if(!out) { if(err && errcap) snprintf(err,errcap,"null catalog output"); return 0; }
    memset(out,0,sizeof *out); if(err && errcap) err[0]=0;
    if(!err && errcap) return 0;
    if(!expected_catalog || !expected_model || !h || !h->init || !h->update || !h->final) goto bad;
    why="catalog descriptor/size refused";
    if(catalog_fd<0 || fstat(catalog_fd,&cs) || !S_ISREG(cs.st_mode) || cs.st_size<FIXED ||
            (uint64_t)cs.st_size>FIXED+(uint64_t)ENTRY*MAX_TENSORS) goto bad;
    size_t n=(size_t)cs.st_size;
    cat=malloc(n); why="catalog allocation/read failed";
    if(!cat || !read_exact(catalog_fd,cat,n)) goto bad;
    digest(h,cat,n,hash); why="catalog hash differs from measured authority";
    if(memcmp(hash,expected_catalog,32)) goto bad;
    why="catalog encoding refused";
    if(memcmp(cat,"AGCAT001",8)) goto bad;
    uint32_t count=u32(cat+8),version=u32(cat+12);
    uint64_t file_size=u64(cat+16),header_len=u64(cat+24),data_start=u64(cat+32),alignment=u64(cat+40);
    if(!count || count>MAX_TENSORS || n!=FIXED+(size_t)count*ENTRY ||
            (version!=2 && version!=3) || !header_len || header_len>MAX_HEADER ||
            header_len>file_size || file_size>INT64_MAX ||
            !alignment || alignment>65536 || (alignment&(alignment-1))) goto bad;
    why="catalog model identity differs from measured pin";
    if(memcmp(cat+48,expected_model,32)) goto bad;
    why="model descriptor/size differs from catalog";
    if(model_fd<0 || fstat(model_fd,&ms) || !S_ISREG(ms.st_mode) || ms.st_size<=0 ||
            (uint64_t)ms.st_size!=file_size) goto bad;
    hdr=malloc((size_t)header_len); why="private header allocation/read failed";
    if(!hdr || !read_exact(model_fd,hdr,(size_t)header_len)) goto bad;
    digest(h,hdr,(size_t)header_len,hash); why="private header differs from catalog";
    if(memcmp(hash,cat+80,32)) goto bad;
    if(!anchor_gguf_private_header(hdr,(size_t)header_len,file_size,&out->table,err,errcap)) {
        why=NULL; goto bad;
    }
    anchor_gguf_table *t=&out->table; why="catalog layout differs from verified header";
    if(t->n!=count || t->version!=version || t->file_size!=file_size ||
            t->data_start!=data_start || t->alignment!=alignment || t->header_len!=header_len) goto bad;
    for(size_t i=0;i<count;i++) {
        const uint8_t *p=cat+FIXED+i*ENTRY;
        anchor_gguf_tensor *e=&t->t[i]; size_t name_len=strlen(e->name);
        if(memcmp(p,e->name,name_len) || p[name_len] || u32(p+128)!=e->n_dims ||
                u32(p+132)!=e->type || u64(p+168)!=e->offset || u64(p+176)!=e->size) goto bad;
        for(size_t j=name_len+1;j<128;j++) if(p[j]) goto bad;
        for(size_t j=0;j<4;j++) if(u64(p+136+8*j)!=e->ne[j]) goto bad;
        memcpy(e->digest,p+184,32);
    }
    /* Nothing here claims that unused padding or every tensor has been read. */
    if(t->has_whole) { why="unexpected whole-file digest state"; goto bad; }
    memcpy(out->model_identity,expected_model,32);
    memcpy(out->catalog_identity,expected_catalog,32);
    out->authenticated_catalog=1;
    free(hdr); free(cat); return 1;
bad:
    if(why && err && errcap) snprintf(err,errcap,"%s",why);
    free(hdr); free(cat); anchor_catalog_free(out); return 0;
}
