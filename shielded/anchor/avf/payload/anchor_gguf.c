#include "anchor_gguf.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* bytes per block and elements per block for the ggml types a shipped model may carry; anything else is refused */
static int type_geom(uint32_t t, uint32_t *blck, uint32_t *bytes) {
    switch (t) {
    case 0: *blck = 1; *bytes = 4; return 1;        /* F32 */
    case 1: *blck = 1; *bytes = 2; return 1;        /* F16 */
    case 2: *blck = 32; *bytes = 18; return 1;      /* Q4_0 */
    case 3: *blck = 32; *bytes = 20; return 1;      /* Q4_1 */
    case 6: *blck = 32; *bytes = 22; return 1;      /* Q5_0 */
    case 7: *blck = 32; *bytes = 24; return 1;      /* Q5_1 */
    case 8: *blck = 32; *bytes = 34; return 1;      /* Q8_0 */
    case 9: *blck = 32; *bytes = 36; return 1;      /* Q8_1 */
    case 10: *blck = 256; *bytes = 84; return 1;    /* Q2_K */
    case 11: *blck = 256; *bytes = 110; return 1;   /* Q3_K */
    case 12: *blck = 256; *bytes = 144; return 1;   /* Q4_K */
    case 13: *blck = 256; *bytes = 176; return 1;   /* Q5_K */
    case 14: *blck = 256; *bytes = 210; return 1;   /* Q6_K */
    case 15: *blck = 256; *bytes = 292; return 1;   /* Q8_K */
    case 24: *blck = 1; *bytes = 1; return 1;       /* I8 */
    case 25: *blck = 1; *bytes = 2; return 1;       /* I16 */
    case 26: *blck = 1; *bytes = 4; return 1;       /* I32 */
    case 27: *blck = 1; *bytes = 8; return 1;       /* I64 */
    case 28: *blck = 1; *bytes = 8; return 1;       /* F64 */
    case 30: *blck = 1; *bytes = 2; return 1;       /* BF16 */
    default: return 0;
    }
}

typedef struct { int fd; uint64_t pos, size; uint8_t buf[65536]; size_t have, at; char *err; size_t errcap; } rd;
static int fill(rd *r) {
    if (r->at < r->have) return 1;
    ssize_t n; do { n = pread(r->fd, r->buf, sizeof r->buf, (off_t)r->pos); } while (n < 0 && errno == EINTR);
    if (n <= 0) { snprintf(r->err, r->errcap, n < 0 ? "read error at %llu" : "header runs past the end at %llu", (unsigned long long)r->pos); return 0; }
    r->have = (size_t)n; r->at = 0; return 1;
}
static int take(rd *r, void *out, size_t n) {
    uint8_t *o = (uint8_t *)out;
    while (n) { if (!fill(r)) return 0; size_t k = r->have - r->at; if (k > n) k = n; if (o) memcpy(o, r->buf + r->at, k); r->at += k; r->pos += k; n -= k; if (o) o += k; }
    return 1;
}
static int u32(rd *r, uint32_t *v) { uint8_t b[4]; if (!take(r, b, 4)) return 0; *v = (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24; return 1; }
static int u64(rd *r, uint64_t *v) { uint8_t b[8]; if (!take(r, b, 8)) return 0; *v = 0; for (int i = 7; i >= 0; i--) *v = (*v << 8) | b[i]; return 1; }
static int skip(rd *r, uint64_t n) { if (n > r->size - r->pos) { snprintf(r->err, r->errcap, "header field of %llu bytes runs past the end", (unsigned long long)n); return 0; } return take(r, NULL, (size_t)n) ; }
static int gstr(rd *r, char *out, size_t cap) {   /* GGUF string: u64 length + bytes; out truncated, always NUL-terminated */
    uint64_t n; if (!u64(r, &n)) return 0;
    if (n > 1 << 20) { snprintf(r->err, r->errcap, "string of %llu bytes", (unsigned long long)n); return 0; }
    size_t keep = n < cap - 1 ? (size_t)n : cap - 1;
    if (out) { if (!take(r, out, keep)) return 0; out[keep] = 0; if (n > keep && !skip(r, n - keep)) return 0; }
    else if (!skip(r, n)) return 0;
    return 1;
}
static const uint32_t SCALAR[] = { 1,1,2,2,4,4,4,1, 0,0, 8,8,8 };   /* by GGUF value type: u8 i8 u16 i16 u32 i32 f32 bool str arr u64 i64 f64 */
static int skip_value(rd *r, uint32_t type, uint64_t *u64_out) {
    if (type == 8) return gstr(r, NULL, 0);
    if (type == 9) {
        uint32_t et; uint64_t n; if (!u32(r, &et) || !u64(r, &n)) return 0;
        if (n > 1u << 26) { snprintf(r->err, r->errcap, "array of %llu", (unsigned long long)n); return 0; }
        for (uint64_t i = 0; i < n; i++) if (!skip_value(r, et, NULL)) return 0;
        return 1;
    }
    if (type > 12 || SCALAR[type] == 0) { snprintf(r->err, r->errcap, "unknown value type %u", type); return 0; }
    uint8_t b[8]; if (!take(r, b, SCALAR[type])) return 0;
    if (u64_out) { *u64_out = 0; for (int i = (int)SCALAR[type] - 1; i >= 0; i--) *u64_out = (*u64_out << 8) | b[i]; }
    return 1;
}

static int cmp_off(const void *a, const void *b) { const anchor_gguf_tensor *x = a, *y = b; return x->offset < y->offset ? -1 : x->offset > y->offset; }

int anchor_gguf_parse(int fd, anchor_gguf_table *t, char *err, size_t errcap) {
    memset(t, 0, sizeof *t); if (errcap) err[0] = 0;
    struct stat st; if (fd < 0 || fstat(fd, &st) != 0 || st.st_size <= 0) { snprintf(err, errcap, "not a readable file"); return 0; }
    rd r; memset(&r, 0, sizeof r); r.fd = fd; r.size = (uint64_t)st.st_size; r.err = err; r.errcap = errcap;
    uint8_t magic[4]; if (!take(&r, magic, 4)) return 0;
    if (memcmp(magic, "GGUF", 4)) { snprintf(err, errcap, "not a GGUF file"); return 0; }
    if (!u32(&r, &t->version)) return 0;
    if (t->version != 2 && t->version != 3) { snprintf(err, errcap, "GGUF version %u", t->version); return 0; }
    uint64_t n_tensors, n_kv; if (!u64(&r, &n_tensors) || !u64(&r, &n_kv)) return 0;
    if (n_tensors == 0 || n_tensors > 65536 || n_kv > 65536) { snprintf(err, errcap, "%llu tensors / %llu kv", (unsigned long long)n_tensors, (unsigned long long)n_kv); return 0; }
    t->alignment = 32;
    for (uint64_t i = 0; i < n_kv; i++) {
        char key[128]; uint32_t vt; if (!gstr(&r, key, sizeof key) || !u32(&r, &vt)) return 0;
        uint64_t v = 0; if (!skip_value(&r, vt, &v)) return 0;
        if (!strcmp(key, "general.alignment")) { if (vt == 4 && v && !(v & (v - 1))) t->alignment = v; else { snprintf(err, errcap, "bad general.alignment"); return 0; } }
    }
    t->t = (anchor_gguf_tensor *)calloc((size_t)n_tensors, sizeof *t->t); if (!t->t) { snprintf(err, errcap, "no memory"); return 0; }
    t->n = (size_t)n_tensors;
    for (size_t i = 0; i < t->n; i++) {
        anchor_gguf_tensor *e = &t->t[i];
        if (!gstr(&r, e->name, sizeof e->name)) goto bad;
        uint32_t nd; if (!u32(&r, &nd)) goto bad;
        if (nd == 0 || nd > 4) { snprintf(err, errcap, "%s: %u dims", e->name, nd); goto bad; }
        uint64_t ne = 1; for (uint32_t d = 0; d < nd; d++) { uint64_t x; if (!u64(&r, &x)) goto bad; if (x == 0 || ne > UINT64_MAX / x) { snprintf(err, errcap, "%s: dims overflow", e->name); goto bad; } ne *= x; }
        if (!u32(&r, &e->type) || !u64(&r, &e->offset)) goto bad;
        uint32_t blck, bytes; if (!type_geom(e->type, &blck, &bytes)) { snprintf(err, errcap, "%s: unknown tensor type %u", e->name, e->type); goto bad; }
        if (ne % blck) { snprintf(err, errcap, "%s: %llu elements not a multiple of the block", e->name, (unsigned long long)ne); goto bad; }
        e->size = ne / blck * bytes;
    }
    t->data_start = (r.pos + t->alignment - 1) / t->alignment * t->alignment;
    t->file_size = r.size;
    qsort(t->t, t->n, sizeof *t->t, cmp_off);
    for (size_t i = 0; i < t->n; i++) {           /* contiguous by offset, inside the file, no overlap */
        anchor_gguf_tensor *e = &t->t[i];
        if (e->offset > t->file_size - t->data_start || e->size > t->file_size - t->data_start - e->offset) { snprintf(err, errcap, "%s: runs past the end of the file", e->name); goto bad; }
        if (i && e->offset < t->t[i - 1].offset + t->t[i - 1].size) { snprintf(err, errcap, "%s overlaps %s", e->name, t->t[i - 1].name); goto bad; }
    }
    return 1;
bad:
    anchor_gguf_free(t); return 0;
}

void anchor_gguf_free(anchor_gguf_table *t) { if (t) { free(t->t); t->t = NULL; t->n = 0; } }

const anchor_gguf_tensor *anchor_gguf_find(const anchor_gguf_table *t, const char *name) {
    if (!t || !name) return NULL;
    for (size_t i = 0; i < t->n; i++) if (!strcmp(t->t[i].name, name)) return &t->t[i];
    return NULL;
}

int anchor_gguf_digest_pass(int fd, anchor_gguf_table *t, const anchor_hash_ops *h, uint8_t pin[32], char *err, size_t errcap) {
    if (!t || !t->t || !h || !pin) { snprintf(err, errcap, "bad arguments"); return 0; }
    uint8_t whole[256], one[256]; h->init(whole);
    uint8_t *buf = (uint8_t *)malloc(1 << 20); if (!buf) { snprintf(err, errcap, "no memory"); return 0; }
    uint64_t pos = 0; size_t ti = 0; int open = 0; uint64_t tend = 0;
    while (pos < t->file_size) {
        size_t want = t->file_size - pos < (1 << 20) ? (size_t)(t->file_size - pos) : (1 << 20);
        ssize_t n; do { n = pread(fd, buf, want, (off_t)pos); } while (n < 0 && errno == EINTR);
        if (n <= 0) { snprintf(err, errcap, n < 0 ? "read error at %llu" : "file shrank at %llu", (unsigned long long)pos); free(buf); return 0; }
        h->update(whole, buf, (size_t)n);
        /* route the chunk's bytes into the tensor(s) they belong to, in offset order */
        uint64_t cpos = pos; size_t coff = 0;
        while (coff < (size_t)n) {
            if (!open) {
                if (ti >= t->n) break;                                    /* trailing bytes belong to no tensor */
                const uint64_t tstart = t->data_start + t->t[ti].offset;
                if (cpos < tstart) { uint64_t gap = tstart - cpos; size_t g = gap < (size_t)n - coff ? (size_t)gap : (size_t)n - coff; cpos += g; coff += g; continue; }
                h->init(one); open = 1; tend = tstart + t->t[ti].size;
            }
            size_t k = tend - cpos < (size_t)n - coff ? (size_t)(tend - cpos) : (size_t)n - coff;
            h->update(one, buf + coff, k); cpos += k; coff += k;
            if (cpos == tend) { h->final(one, t->t[ti].digest); open = 0; ti++; }
        }
        pos += (uint64_t)n;
    }
    free(buf);
    if (open || ti != t->n) { snprintf(err, errcap, "file ended inside tensor %zu", ti); return 0; }
    h->final(whole, pin);
    return 1;
}
