/* anchor-gguf: the pVM's GGUF header walk and single-pass per-tensor digests (payload/anchor_gguf.c).
 * A synthetic file with known bytes (verified again in node), malformed variants, and the real 0.8B when present. */
#include "anchor_gguf.h"
#include <assert.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* test-local scalar SHA-256 (the payload plugs in anchor_pins' backend) */
typedef struct { uint32_t h[8]; uint8_t buf[64]; size_t used; uint64_t total; } sha_ctx;
static const uint32_t K[64] = {0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
#define R(x,n) (((x)>>(n))|((x)<<(32-(n))))
static void blk(uint32_t h[8], const uint8_t p[64]) { uint32_t w[64]; for (int i=0;i<16;i++) w[i]=(uint32_t)p[4*i]<<24|(uint32_t)p[4*i+1]<<16|(uint32_t)p[4*i+2]<<8|p[4*i+3]; for (int i=16;i<64;i++){uint32_t a=w[i-15],b=w[i-2]; w[i]=w[i-16]+(R(a,7)^R(a,18)^(a>>3))+w[i-7]+(R(b,17)^R(b,19)^(b>>10));} uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7]; for(int i=0;i<64;i++){uint32_t t1=hh+(R(e,6)^R(e,11)^R(e,25))+((e&f)^(~e&g))+K[i]+w[i]; uint32_t t2=(R(a,2)^R(a,13)^R(a,22))+((a&b)^(a&c)^(b&c)); hh=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;} h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh; }
static void t_init(void *c_) { sha_ctx *c=c_; static const uint32_t iv[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19}; memcpy(c->h,iv,32); c->used=0; c->total=0; }
static void t_update(void *c_, const uint8_t *m, size_t n) { sha_ctx *c=c_; c->total+=n; while(n){ size_t k=64-c->used<n?64-c->used:n; memcpy(c->buf+c->used,m,k); c->used+=k; m+=k; n-=k; if(c->used==64){blk(c->h,c->buf);c->used=0;} } }
static void t_final(void *c_, uint8_t out[32]) { sha_ctx *c=c_; uint64_t bits=c->total*8; uint8_t pad=0x80,z=0; t_update(c,&pad,1); while(c->used!=56) t_update(c,&z,1); uint8_t len[8]; for(int i=0;i<8;i++) len[i]=(uint8_t)(bits>>(8*(7-i))); t_update(c,len,8); for(int i=0;i<8;i++){out[4*i]=(uint8_t)(c->h[i]>>24);out[4*i+1]=(uint8_t)(c->h[i]>>16);out[4*i+2]=(uint8_t)(c->h[i]>>8);out[4*i+3]=(uint8_t)c->h[i];} }
static const anchor_hash_ops OPS = { t_init, t_update, t_final };
static void hex(const uint8_t *b, size_t n, char *out) { for (size_t i = 0; i < n; i++) sprintf(out + 2 * i, "%02x", b[i]); out[2 * n] = 0; }

/* a GGUF v3 with general.alignment=32 and two tensors: F32 "a" [4] and Q8_0 "blk.0.b" [64] (2 blocks) */
static void put_u32(FILE *f, uint32_t v) { for (int i = 0; i < 4; i++) fputc((v >> (8 * i)) & 0xff, f); }
static void put_u64(FILE *f, uint64_t v) { for (int i = 0; i < 8; i++) fputc((v >> (8 * i)) & 0xff, f); }
static void put_str(FILE *f, const char *s) { put_u64(f, strlen(s)); fputs(s, f); }
static long write_synthetic(const char *path, uint32_t type_b, uint64_t off_b) {
    FILE *f = fopen(path, "wb"); assert(f);
    fputs("GGUF", f); put_u32(f, 3); put_u64(f, 2); put_u64(f, 2);
    put_str(f, "general.alignment"); put_u32(f, 4); put_u32(f, 32);
    put_str(f, "general.name"); put_u32(f, 8); put_str(f, "synthetic");
    put_str(f, "a"); put_u32(f, 1); put_u64(f, 4); put_u32(f, 0); put_u64(f, 0);
    put_str(f, "blk.0.b"); put_u32(f, 1); put_u64(f, 64); put_u32(f, type_b); put_u64(f, off_b);
    long hdr = ftell(f); while (ftell(f) % 32) fputc(0, f);
    for (int i = 0; i < 16; i++) fputc(0x10 + i, f);            /* a: 16 bytes */
    while ((ftell(f) - (hdr + 31) / 32 * 32) < (long)off_b) fputc(0xee, f);   /* gap to b */
    for (int i = 0; i < 68; i++) fputc(0x40 + i, f);            /* b: 2 x 34 bytes */
    fputs("trailer", f);                                          /* bytes after the last tensor: no tensor's, still in the pin */
    long size = ftell(f); fclose(f); return size;
}

int main(void) {
    char dir[] = "/tmp/anchor-gguf-XXXXXX"; assert(mkdtemp(dir));
    char p[600]; snprintf(p, sizeof p, "%s/s.gguf", dir);
    char err[256]; anchor_gguf_table t; uint8_t pin[32]; char h[65];
    write_synthetic(p, 8, 32);
    int fd = open(p, O_RDONLY); assert(fd >= 0);
    assert(anchor_gguf_parse(fd, &t, err, sizeof err) == 1);
    assert(t.n == 2 && t.alignment == 32 && t.version == 3);
    assert(!strcmp(t.t[0].name, "a") && t.t[0].offset == 0 && t.t[0].size == 16 && t.t[0].type == 0);
    assert(!strcmp(t.t[1].name, "blk.0.b") && t.t[1].offset == 32 && t.t[1].size == 68 && t.t[1].type == 8);
    assert(anchor_gguf_find(&t, "blk.0.b") == &t.t[1] && !anchor_gguf_find(&t, "nope"));
    assert(anchor_gguf_digest_pass(fd, &t, &OPS, pin, err, sizeof err) == 1);
    hex(pin, 32, h); printf("synthetic %s size %llu data_start %llu pin %s\n", p, (unsigned long long)t.file_size, (unsigned long long)t.data_start, h);
    for (size_t i = 0; i < t.n; i++) { hex(t.t[i].digest, 32, h); printf("tensor %s offset %llu size %llu digest %s\n", t.t[i].name, (unsigned long long)t.t[i].offset, (unsigned long long)t.t[i].size, h); }
    anchor_gguf_free(&t); close(fd);
    /* malformed: overlapping offsets, unknown type, wrong magic, truncated */
    write_synthetic(p, 8, 8); fd = open(p, O_RDONLY); assert(!anchor_gguf_parse(fd, &t, err, sizeof err) && strstr(err, "overlaps")); close(fd);
    write_synthetic(p, 99, 32); fd = open(p, O_RDONLY); assert(!anchor_gguf_parse(fd, &t, err, sizeof err) && strstr(err, "unknown tensor type")); close(fd);
    write_synthetic(p, 8, 32); { FILE *f = fopen(p, "r+b"); fputs("GGUX", f); fclose(f); } fd = open(p, O_RDONLY); assert(!anchor_gguf_parse(fd, &t, err, sizeof err) && strstr(err, "not a GGUF")); close(fd);
    long size = write_synthetic(p, 8, 32); assert(truncate(p, size - 20) == 0); fd = open(p, O_RDONLY); assert(!anchor_gguf_parse(fd, &t, err, sizeof err) && strstr(err, "past the end")); close(fd);
    /* a file that shrinks between the parse and the pass is not trusted either */
    write_synthetic(p, 8, 32); fd = open(p, O_RDONLY); assert(anchor_gguf_parse(fd, &t, err, sizeof err)); assert(truncate(p, size - 20) == 0);
    assert(!anchor_gguf_digest_pass(fd, &t, &OPS, pin, err, sizeof err) && strstr(err, "shrank")); anchor_gguf_free(&t); close(fd);
    /* the real 0.8B when present: parses, every tensor inside the file, digests over the whole file */
    const char *real = "/home/steven/Projects/enclave-models/qwen3.5-0.8b-mtp-gguf/Qwen3.5-0.8B-Q8_0.gguf";
    fd = open(real, O_RDONLY);
    if (fd >= 0) {
        assert(anchor_gguf_parse(fd, &t, err, sizeof err) == 1 && t.n > 100);
        assert(anchor_gguf_digest_pass(fd, &t, &OPS, pin, err, sizeof err) == 1);
        hex(pin, 32, h); const anchor_gguf_tensor *e = anchor_gguf_find(&t, "token_embd.weight"); assert(e);
        char d[65]; hex(e->digest, 32, d);
        printf("real %s tensors %zu data_start %llu pin %s token_embd offset %llu size %llu digest %s\n", real, t.n, (unsigned long long)t.data_start, h, (unsigned long long)e->offset, (unsigned long long)e->size, d);
        anchor_gguf_free(&t); close(fd);
    } else printf("real absent\n");
    char cmd[700]; snprintf(cmd, sizeof cmd, "rm -rf %s", dir); (void)!system(cmd);
    printf("anchor-gguf: ok\n");
    return 0;
}
