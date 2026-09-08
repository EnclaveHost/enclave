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

/* The one reader: every byte handed out is also hashed into the whole-file digest and, while the header is
 * being parsed, appended to the retained header copy. */
typedef struct {
    int fd; uint64_t pos, size; uint8_t *buf; size_t have, at;
    const anchor_hash_ops *h; void *whole;
    uint8_t *hdr; size_t hdr_len, hdr_cap; int keep_hdr;
    char *err; size_t errcap;
} rd;
#define CHUNK (1u << 20)
static int fill(rd *r) {
    if (r->at < r->have) return 1;
    if (r->pos >= r->size) { snprintf(r->err, r->errcap, "runs past the end of the file at %llu", (unsigned long long)r->pos); return 0; }
    size_t want = r->size - r->pos < CHUNK ? (size_t)(r->size - r->pos) : CHUNK;
    ssize_t n; do { n = pread(r->fd, r->buf, want, (off_t)r->pos); } while (n < 0 && errno == EINTR);
    if (n <= 0) { snprintf(r->err, r->errcap, n < 0 ? "read error at %llu" : "file shrank at %llu", (unsigned long long)r->pos); return 0; }
    if (r->h) r->h->update(r->whole, r->buf, (size_t)n);
    r->have = (size_t)n; r->at = 0; return 1;
}
/* hand out n bytes (copied to out when non-NULL); header bytes are retained while keep_hdr */
static int take(rd *r, void *out, size_t n) {
    uint8_t *o = (uint8_t *)out;
    while (n) {
        if (!fill(r)) return 0;
        size_t k = r->have - r->at; if (k > n) k = n;
        if (o) { memcpy(o, r->buf + r->at, k); o += k; }
        if (r->keep_hdr) {
            if (r->hdr_len + k > r->hdr_cap) { size_t cap = r->hdr_cap ? r->hdr_cap * 2 : 65536; while (cap < r->hdr_len + k) cap *= 2; if (cap > (256u << 20)) { snprintf(r->err, r->errcap, "header larger than 256 MiB"); return 0; } uint8_t *nh = realloc(r->hdr, cap); if (!nh) { snprintf(r->err, r->errcap, "no memory"); return 0; } r->hdr = nh; r->hdr_cap = cap; }
            memcpy(r->hdr + r->hdr_len, r->buf + r->at, k); r->hdr_len += k;
        }
        r->at += k; r->pos += k; n -= k;
    }
    return 1;
}
static int u32(rd *r, uint32_t *v) { uint8_t b[4]; if (!take(r, b, 4)) return 0; *v = (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24; return 1; }
static int u64(rd *r, uint64_t *v) { uint8_t b[8]; if (!take(r, b, 8)) return 0; *v = 0; for (int i = 7; i >= 0; i--) *v = (*v << 8) | b[i]; return 1; }
/* a GGUF string into out (cap includes the NUL): longer, or holding a NUL, is refused - a name is never truncated */
static int gstr(rd *r, char *out, size_t cap, const char *what) {
    uint64_t n; if (!u64(r, &n)) return 0;
    if (n > 1u << 20) { snprintf(r->err, r->errcap, "%s of %llu bytes", what, (unsigned long long)n); return 0; }
    if (!out) { uint8_t tmp[4096]; while (n) { size_t k = n < sizeof tmp ? (size_t)n : sizeof tmp; if (!take(r, tmp, k)) return 0; n -= k; } return 1; }
    if (n >= cap) { snprintf(r->err, r->errcap, "%s longer than %zu bytes", what, cap - 1); return 0; }
    if (!take(r, out, (size_t)n)) return 0; out[n] = 0;
    if (strlen(out) != (size_t)n) { snprintf(r->err, r->errcap, "%s holds a NUL", what); return 0; }
    return 1;
}
static const uint32_t SCALAR[] = { 1,1,2,2,4,4,4,1, 0,0, 8,8,8 };   /* u8 i8 u16 i16 u32 i32 f32 bool str arr u64 i64 f64 */
static int skip_value(rd *r, uint32_t type, uint64_t *u64_out, int in_array) {
    if (type == 8) return gstr(r, NULL, 0, "string");
    if (type == 9) {
        if (in_array) { snprintf(r->err, r->errcap, "nested array"); return 0; }
        uint32_t et; uint64_t n; if (!u32(r, &et) || !u64(r, &n)) return 0;
        if (et == 9) { snprintf(r->err, r->errcap, "nested array"); return 0; }
        if (n > 1u << 26) { snprintf(r->err, r->errcap, "array of %llu", (unsigned long long)n); return 0; }
        for (uint64_t i = 0; i < n; i++) if (!skip_value(r, et, NULL, 1)) return 0;
        return 1;
    }
    if (type > 12 || SCALAR[type] == 0) { snprintf(r->err, r->errcap, "unknown value type %u", type); return 0; }
    uint8_t b[8]; if (!take(r, b, SCALAR[type])) return 0;
    if (u64_out) { *u64_out = 0; for (int i = (int)SCALAR[type] - 1; i >= 0; i--) *u64_out = (*u64_out << 8) | b[i]; }
    return 1;
}
static int cmp_off(const void *a, const void *b) { const anchor_gguf_tensor *x = a, *y = b; return x->offset < y->offset ? -1 : x->offset > y->offset; }
static int cmp_name(const void *a, const void *b) { return strcmp(((const anchor_gguf_tensor *)a)->name, ((const anchor_gguf_tensor *)b)->name); }

void anchor_gguf_free(anchor_gguf_table *t) { if (t) { free(t->t); free(t->header); t->t = NULL; t->header = NULL; t->n = 0; t->header_len = 0; } }
const anchor_gguf_tensor *anchor_gguf_find(const anchor_gguf_table *t, const char *name) {
    if (!t || !name) return NULL;
    for (size_t i = 0; i < t->n; i++) if (!strcmp(t->t[i].name, name)) return &t->t[i];
    return NULL;
}

int anchor_gguf_stage(int fd, anchor_gguf_table *t, const anchor_hash_ops *h, uint8_t pin[32], char *err, size_t errcap) {
    memset(t, 0, sizeof *t); if (errcap) err[0] = 0;
    struct stat st; if (fd < 0 || fstat(fd, &st) != 0 || st.st_size <= 0) { snprintf(err, errcap, "not a readable file"); return 0; }
    rd r; memset(&r, 0, sizeof r); r.fd = fd; r.size = (uint64_t)st.st_size; r.err = err; r.errcap = errcap; r.h = h; r.keep_hdr = 1;
    r.buf = (uint8_t *)malloc(CHUNK); uint8_t whole[256]; r.whole = whole;
    if (!r.buf) { snprintf(err, errcap, "no memory"); return 0; }
    if (h) h->init(whole);
    uint8_t magic[4]; if (!take(&r, magic, 4)) goto bad;
    if (memcmp(magic, "GGUF", 4)) { snprintf(err, errcap, "not a GGUF file"); goto bad; }
    if (!u32(&r, &t->version)) goto bad;
    if (t->version != 2 && t->version != 3) { snprintf(err, errcap, "GGUF version %u", t->version); goto bad; }
    uint64_t n_tensors, n_kv; if (!u64(&r, &n_tensors) || !u64(&r, &n_kv)) goto bad;
    if (n_tensors == 0 || n_tensors > 65536 || n_kv > 65536) { snprintf(err, errcap, "%llu tensors / %llu kv", (unsigned long long)n_tensors, (unsigned long long)n_kv); goto bad; }
    t->alignment = 32;
    for (uint64_t i = 0; i < n_kv; i++) {
        char key[256]; uint32_t vt; if (!gstr(&r, key, sizeof key, "key") || !u32(&r, &vt)) goto bad;
        uint64_t v = 0; if (!skip_value(&r, vt, &v, 0)) goto bad;
        if (!strcmp(key, "general.alignment")) { if (vt == 4 && v && v <= 65536 && !(v & (v - 1))) t->alignment = v; else { snprintf(err, errcap, "bad general.alignment"); goto bad; } }
    }
    t->t = (anchor_gguf_tensor *)calloc((size_t)n_tensors, sizeof *t->t); if (!t->t) { snprintf(err, errcap, "no memory"); goto bad; }
    t->n = (size_t)n_tensors;
    for (size_t i = 0; i < t->n; i++) {
        anchor_gguf_tensor *e = &t->t[i];
        if (!gstr(&r, e->name, sizeof e->name, "tensor name")) goto bad;
        if (!e->name[0]) { snprintf(err, errcap, "empty tensor name"); goto bad; }
        if (!u32(&r, &e->n_dims)) goto bad;
        if (e->n_dims == 0 || e->n_dims > 4) { snprintf(err, errcap, "%s: %u dims", e->name, e->n_dims); goto bad; }
        uint64_t ne = 1;
        for (uint32_t d = 0; d < e->n_dims; d++) { if (!u64(&r, &e->ne[d])) goto bad; if (e->ne[d] == 0 || ne > UINT64_MAX / e->ne[d]) { snprintf(err, errcap, "%s: dims overflow", e->name); goto bad; } ne *= e->ne[d]; }
        for (uint32_t d = e->n_dims; d < 4; d++) e->ne[d] = 1;
        if (!u32(&r, &e->type) || !u64(&r, &e->offset)) goto bad;
        uint32_t blck, bytes; if (!type_geom(e->type, &blck, &bytes)) { snprintf(err, errcap, "%s: unknown tensor type %u", e->name, e->type); goto bad; }
        if (e->ne[0] % blck) { snprintf(err, errcap, "%s: row of %llu elements not a multiple of the block", e->name, (unsigned long long)e->ne[0]); goto bad; }   /* quantization runs along ne[0] */
        if (ne / blck > UINT64_MAX / bytes) { snprintf(err, errcap, "%s: size overflow", e->name); goto bad; }
        e->size = ne / blck * bytes;
        if (e->offset % t->alignment) { snprintf(err, errcap, "%s: offset not aligned", e->name); goto bad; }
    }
    r.keep_hdr = 0; t->header = r.hdr; t->header_len = r.hdr_len; r.hdr = NULL;
    t->data_start = (r.pos + t->alignment - 1) / t->alignment * t->alignment;
    t->file_size = r.size;
    /* no duplicate names; contiguous by offset, inside the file, no overlap */
    { anchor_gguf_tensor *byname = (anchor_gguf_tensor *)malloc(t->n * sizeof *byname); if (!byname) { snprintf(err, errcap, "no memory"); goto bad; }
      memcpy(byname, t->t, t->n * sizeof *byname); qsort(byname, t->n, sizeof *byname, cmp_name);
      for (size_t i = 1; i < t->n; i++) if (!strcmp(byname[i].name, byname[i - 1].name)) { snprintf(err, errcap, "duplicate tensor name %s", byname[i].name); free(byname); goto bad; }
      free(byname); }
    qsort(t->t, t->n, sizeof *t->t, cmp_off);
    for (size_t i = 0; i < t->n; i++) {
        anchor_gguf_tensor *e = &t->t[i];
        if (t->data_start > t->file_size || e->offset > t->file_size - t->data_start || e->size > t->file_size - t->data_start - e->offset) { snprintf(err, errcap, "%s: runs past the end of the file", e->name); goto bad; }
        if (i && e->offset < t->t[i - 1].offset + t->t[i - 1].size) { snprintf(err, errcap, "%s overlaps %s", e->name, t->t[i - 1].name); goto bad; }
    }
    if (!h) { free(r.buf); return 1; }                                  /* header only: nothing authenticated */
    /* the data region, through the same reader (every byte still hashed into the whole): route bytes to tensors */
    { uint8_t one[256]; size_t ti = 0; int open = 0; uint64_t tend = 0;
      while (r.pos < r.size) {
        if (!fill(&r)) goto bad;
        while (r.at < r.have) {
            if (!open) {
                if (ti >= t->n) { r.pos += r.have - r.at; r.at = r.have; break; }     /* trailing bytes: nobody's, still in the pin */
                const uint64_t tstart = t->data_start + t->t[ti].offset;
                if (r.pos < tstart) { uint64_t gap = tstart - r.pos; size_t g = gap < r.have - r.at ? (size_t)gap : r.have - r.at; r.pos += g; r.at += g; continue; }
                h->init(one); open = 1; tend = tstart + t->t[ti].size;
            }
            size_t k = tend - r.pos < r.have - r.at ? (size_t)(tend - r.pos) : r.have - r.at;
            h->update(one, r.buf + r.at, k); r.pos += k; r.at += k;
            if (r.pos == tend) { h->final(one, t->t[ti].digest); open = 0; ti++; }
        }
      }
      if (open || ti != t->n) { snprintf(err, errcap, "file ended inside tensor %zu", ti); goto bad; }
    }
    if (r.pos != r.size) { snprintf(err, errcap, "size changed under the read"); goto bad; }
    h->final(whole, pin);
    free(r.buf);
    return 1;
bad:
    free(r.buf); free(r.hdr); anchor_gguf_free(t); return 0;
}
