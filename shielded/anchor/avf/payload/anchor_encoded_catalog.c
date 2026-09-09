#include "anchor_encoded_catalog.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* EWCAT001 header (192 bytes): magic8, count:u32, block_bytes:u32,
 * encoder_version:u32, QK:u32, FRAC:u32, weight_limit:u32,
 * model_sha256[32], source_catalog_sha256[32], calib_digest[32], converter_sha256[32],
 * total_length:u64, zero_reserved[24]. Entry fixed part (256 bytes): name[128],
 * type:u32, n_dims:u32, ne[4]:u64, source_tensor_sha256[32], encoded_bytes:u64,
 * rows:u64, blocks:u64, encoded_sha256[32]. Followed by rows*4 LE signed exponent
 * bytes, then blocks*32 SHA-256 bytes. Entries strictly sorted by name. */
#define HEAD 192u
#define FIXED 256u
#define BLOCK (1u << 20)
#define MAX_CATALOG (64u << 20)
#define MAX_ENTRIES 4096u
static uint32_t get32(const uint8_t *p) {
    return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;
}
static uint64_t get64(const uint8_t *p) {
    uint64_t v=0;for(int i=7;i>=0;i--)v=(v<<8)|p[i];return v;
}
void anchor_encoded_catalog_free(anchor_encoded_catalog *out) {
    if(!out) return;
    for(size_t i=0;i<out->count;i++)free(out->entries[i].exponents);
    free(out->entries);free(out->raw);memset(out,0,sizeof *out);
}
const anchor_encoded_entry *anchor_encoded_find(const anchor_encoded_catalog *c,const char *name) {
    if(!c || !c->authenticated || !name) return NULL;
    for(size_t i=0;i<c->count;i++)if(!strcmp(c->entries[i].source->name,name))return &c->entries[i];
    return NULL;
}
int anchor_encoded_catalog_open(int fd,const uint8_t expected_catalog[32],
        const anchor_catalog_table *source,const uint8_t expected_calib[32],
        const uint8_t expected_converter[32],const anchor_hash_ops *h,
        anchor_encoded_catalog *out,char *err,size_t errcap) {
    const char *why="invalid encoded catalog arguments";struct stat st;uint8_t hash[32];
    if(!out) {if(err&&errcap)snprintf(err,errcap,"null encoded output");return 0;}
    memset(out,0,sizeof *out);if(err&&errcap)err[0]=0;if(!err&&errcap)return 0;
    if(!expected_catalog||!expected_calib||!expected_converter||!source||!source->authenticated_catalog||
            !source->table.t||!h||!h->init||!h->update||!h->final)goto bad;
    why="encoded catalog descriptor/length refused";
    if(fd<0||fstat(fd,&st)||!S_ISREG(st.st_mode)||st.st_size<HEAD||(uint64_t)st.st_size>MAX_CATALOG)goto bad;
    out->raw_bytes=(size_t)st.st_size;out->raw=malloc(out->raw_bytes);why="encoded catalog allocation/read failed";
    if(!out->raw)goto bad;
    size_t have=0;
    while(have<out->raw_bytes) {
        ssize_t n=pread(fd,out->raw+have,out->raw_bytes-have,(off_t)have);
        if(n<0&&errno==EINTR)continue;if(n<=0)goto bad;have+=(size_t)n;
    }
    union {max_align_t alignment;uint8_t bytes[256];} ctx;
    h->init(ctx.bytes);h->update(ctx.bytes,out->raw,out->raw_bytes);h->final(ctx.bytes,hash);
    why="encoded catalog hash differs from measured authority";
    if(memcmp(hash,expected_catalog,32))goto bad;
    const uint8_t *raw=out->raw;uint32_t count=get32(raw+8);
    why="encoded catalog constants/version/length refused";
    if(memcmp(raw,"EWCAT001",8)||!count||count>MAX_ENTRIES||get32(raw+12)!=BLOCK||
            get32(raw+16)!=1||get32(raw+20)!=32||get32(raw+24)!=8||get32(raw+28)!=119||
            get64(raw+160)!=out->raw_bytes)goto bad;
    for(size_t i=168;i<HEAD;i++)if(raw[i])goto bad;
    why="encoded catalog model/source/calibration/converter binding differs";
    if(memcmp(raw+32,source->model_identity,32)||memcmp(raw+64,source->catalog_identity,32)||
            memcmp(raw+96,expected_calib,32)||memcmp(raw+128,expected_converter,32))goto bad;
    out->entries=calloc(count,sizeof *out->entries);why="encoded entries allocation failed";
    if(!out->entries)goto bad;
    out->count=count;size_t at=HEAD;
    for(size_t i=0;i<count;i++) {
        why="encoded catalog entry is truncated or noncanonical";
        if(at>out->raw_bytes||out->raw_bytes-at<FIXED)goto bad;
        const uint8_t *p=raw+at;const uint8_t *nul=memchr(p,0,128);
        if(!nul||nul==p)goto bad;
        for(const uint8_t *q=nul;q<p+128;q++)if(*q)goto bad;
        if(i && strcmp(out->entries[i-1].source->name,(const char *)p)>=0)goto bad;
        anchor_encoded_entry *e=&out->entries[i];e->source=anchor_gguf_find(&source->table,(const char *)p);
        why="encoded entry disagrees with authenticated source tensor";
        if(!e->source||get32(p+128)!=e->source->type||get32(p+132)!=e->source->n_dims||
                e->source->type!=8||e->source->n_dims!=2||memcmp(p+168,e->source->digest,32))goto bad;
        for(size_t d=0;d<4;d++)if(get64(p+136+8*d)!=e->source->ne[d])goto bad;
        uint64_t k=e->source->ne[0],n=e->source->ne[1];
        if(!k||k%32||k>131072||!n||n>SIZE_MAX/4||k>UINT64_MAX/n)goto bad;
        e->bytes=get64(p+200);e->rows=get64(p+208);e->blocks=get64(p+216);
        if(e->bytes!=k*n||e->bytes>(UINT64_C(64)<<30)||e->rows!=n||
                e->blocks!=(e->bytes-1)/BLOCK+1)goto bad;
        memcpy(e->encoded_sha256,p+224,32);at+=FIXED;
        why="encoded entry exponent/block array bounds refused";
        if(e->rows>(out->raw_bytes-at)/4)goto bad;
        size_t exponent_bytes=(size_t)e->rows*4;
        if(e->blocks>(out->raw_bytes-at-exponent_bytes)/32)goto bad;
        e->exponents_le32=raw+at;
        e->exponents=malloc(exponent_bytes);if(!e->exponents)goto bad;
        for(size_t j=0;j<(size_t)e->rows;j++) {
            uint32_t bits=get32(raw+at+4*j);
            int64_t value=bits<=INT32_MAX?(int64_t)bits:(int64_t)bits-INT64_C(4294967296);
            /* Broad arithmetic bound only. Calibration-specific inv/act_scale
             * checks remain mandatory in the backend before using exponents. */
            if(value < -256 || value > 256)goto bad;
            e->exponents[j]=(int32_t)value;
        }
        at+=exponent_bytes;e->block_sha256=raw+at;at+=(size_t)e->blocks*32;
    }
    why="encoded catalog has trailing bytes";if(at!=out->raw_bytes)goto bad;
    out->authenticated=1;memcpy(out->identity,expected_catalog,32);return 1;
bad:
    if(err&&errcap)snprintf(err,errcap,"%s",why);
    anchor_encoded_catalog_free(out);return 0;
}
