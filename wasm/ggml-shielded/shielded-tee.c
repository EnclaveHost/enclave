#define _GNU_SOURCE
#include "shielded-tee.h"
#include "shielded-field.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>

#define SH_ALIGN 64
static int64_t align_up(int64_t x) { return (x + SH_ALIGN - 1) & ~(int64_t)(SH_ALIGN - 1); }

/* ---------------------------------------------------------------------------
 * OS entropy. Both the pad seed and the Freivalds secret come from here and
 * nowhere else -- see rule 4 in the header, and the commit that had to fix it.
 * ------------------------------------------------------------------------ */
static bool os_random(void *buf, size_t n) {
    uint8_t *p = (uint8_t *)buf;
    while (n) {
        ssize_t r = getrandom(p, n, 0);
        if (r < 0) return false;
        p += r; n -= (size_t)r;
    }
    return true;
}

/* ---------------------------------------------------------------------------
 * ChaCha20 keystream, for the pad bank.
 *
 * The Python side uses SHAKE-256 and the guest uses it too, but pads are the one
 * value that never has to agree across languages: only the TEE generates them and
 * only the TEE consumes them, so the requirement here is cryptographic strength
 * and speed, not reproducibility. ChaCha20 keeps this file dependency-free, which
 * matters for something linked into the engine inside the measurement.
 * ------------------------------------------------------------------------ */
#define ROTL32(v, c) (((v) << (c)) | ((v) >> (32 - (c))))
#define QR(a, b, c, d) ( \
    a += b, d ^= a, d = ROTL32(d, 16), \
    c += d, b ^= c, b = ROTL32(b, 12), \
    a += b, d ^= a, d = ROTL32(d, 8),  \
    c += d, b ^= c, b = ROTL32(b, 7))

static void chacha20_block(const uint32_t key[8], uint64_t counter, uint32_t out[16]) {
    static const uint32_t C[4] = { 0x61707865, 0x3320646e, 0x79622d32, 0x6b206574 };
    uint32_t s[16];
    s[0] = C[0]; s[1] = C[1]; s[2] = C[2]; s[3] = C[3];
    for (int i = 0; i < 8; i++) s[4 + i] = key[i];
    s[12] = (uint32_t)counter; s[13] = (uint32_t)(counter >> 32);
    s[14] = 0; s[15] = 0;
    uint32_t x[16]; memcpy(x, s, sizeof x);
    for (int i = 0; i < 10; i++) {
        QR(x[0], x[4], x[ 8], x[12]); QR(x[1], x[5], x[ 9], x[13]);
        QR(x[2], x[6], x[10], x[14]); QR(x[3], x[7], x[11], x[15]);
        QR(x[0], x[5], x[10], x[15]); QR(x[1], x[6], x[11], x[12]);
        QR(x[2], x[7], x[ 8], x[13]); QR(x[3], x[4], x[ 9], x[14]);
    }
    for (int i = 0; i < 16; i++) out[i] = x[i] + s[i];
}

typedef struct {
    uint32_t key[8];
    uint64_t counter;      /* strictly monotonic; the machine-checkable form of "never reused" */
    uint64_t issued_hi;
    uint64_t capacity;
} sh_maskbank;

static bool maskbank_init(sh_maskbank *b) {
    b->counter = 0; b->issued_hi = 0; b->capacity = UINT64_C(1) << 40;
    return os_random(b->key, sizeof b->key);
}

/* Fill `n` pad values uniform over Z_M. Drawn as uint64 and reduced, so the
 * modulo bias is ~2^-40 rather than the ~2^-8 a uint32 draw would carry. */
static int maskbank_issue(sh_maskbank *b, int64_t *dst, size_t n) {
    if (b->counter >= b->capacity) return SH_ERR_EXHAUST;
    uint64_t index = b->counter++;
    if (b->counter <= b->issued_hi) return SH_ERR_EXHAUST;   /* counter went backwards */
    b->issued_hi = b->counter;
    uint32_t blk[16];
    uint64_t ctr = index << 20;      /* room for the whole pad under one index */
    size_t produced = 0;
    while (produced < n) {
        chacha20_block(b->key, ctr++, blk);
        for (int i = 0; i + 1 < 16 && produced < n; i += 2) {
            uint64_t v = ((uint64_t)blk[i + 1] << 32) | blk[i];
            dst[produced++] = (int64_t)(v % (uint64_t)SH_M_MOD);
        }
    }
    return SH_OK;
}

/* ---------------------------------------------------------------------------
 * Nodes
 * ------------------------------------------------------------------------ */
typedef struct {
    char     name[64];
    const int8_t   *wq;         /* (K,N) borrowed */
    const uint16_t *wd;         /* (K/QK,N) borrowed */
    int8_t   *w_fixed;          /* (K,N) the shared encoding, int8 lane */
    int64_t   K, N;
    int32_t   max_m;
    int64_t   wq_off, wd_off, x_off, y_off;
    bool      shared_x;
    /* Freivalds preprocessing: s (N,REPS) and s_tilde (K,REPS) mod P2. */
    int64_t  *s, *s_tilde;
} sh_node;

struct sh_link {
    sh_pipe   *pipe;
    char       host[128];
    int        port;
    bool       verify;
    sh_node   *nodes;
    size_t     n_nodes, cap_nodes;
    int64_t    wbytes, abytes;
    sh_maskbank bank;
    int64_t   *pad;      size_t pad_cap;
    int8_t    *planes;   size_t planes_cap;
    int64_t   *u;        size_t u_cap;
    int32_t   *acc;      size_t acc_cap;
    uint64_t   exchanges, macs, verify_fail;
    char       err[256];
};

const char *sh_link_last_error(const sh_link *l) { return l ? l->err : ""; }

void sh_link_stats(const sh_link *l, uint64_t *e, uint64_t *m, uint64_t *v) {
    if (!l) return;
    if (e) *e = l->exchanges;
    if (m) *m = l->macs;
    if (v) *v = l->verify_fail;
}

sh_link *sh_link_open(const char *host, int port, bool verify, int *err) {
    sh_link *l = (sh_link *)calloc(1, sizeof *l);
    if (!l) { if (err) *err = SH_ERR_NOMEM; return NULL; }
    snprintf(l->host, sizeof l->host, "%s", host);
    l->port = port; l->verify = verify;
    if (!maskbank_init(&l->bank)) { free(l); if (err) *err = SH_ERR_IO; return NULL; }
    if (err) *err = SH_OK;
    return l;
}

void sh_link_close(sh_link *l) {
    if (!l) return;
    for (size_t i = 0; i < l->n_nodes; i++) {
        free(l->nodes[i].w_fixed); free(l->nodes[i].s); free(l->nodes[i].s_tilde);
    }
    free(l->nodes); free(l->pad); free(l->planes); free(l->u); free(l->acc);
    sh_pipe_close(l->pipe);
    free(l);
}

static int fv_prepare(sh_node *nd) {
    const int64_t K = nd->K, N = nd->N;
    nd->s       = (int64_t *)malloc((size_t)N * SH_FV_REPS * sizeof(int64_t));
    nd->s_tilde = (int64_t *)malloc((size_t)K * SH_FV_REPS * sizeof(int64_t));
    if (!nd->s || !nd->s_tilde) return SH_ERR_NOMEM;
    /* s from the OS CSPRNG. Predictable s == forgeable results; see rule 4. */
    uint64_t *raw = (uint64_t *)malloc((size_t)N * SH_FV_REPS * sizeof(uint64_t));
    if (!raw) return SH_ERR_NOMEM;
    if (!os_random(raw, (size_t)N * SH_FV_REPS * sizeof(uint64_t))) { free(raw); return SH_ERR_IO; }
    for (int64_t i = 0; i < N * SH_FV_REPS; i++)
        nd->s[i] = 1 + (int64_t)(raw[i] % (uint64_t)(SH_FV_S_RANGE - 1));
    free(raw);
    /* s_tilde = W.s mod P2. |w| <= 119, |s| < 2^20, so a K-term sum stays under
     * 2^39 for any K we will ever see -- no chunking needed here. */
    for (int64_t k = 0; k < K; k++) {
        for (int rep = 0; rep < SH_FV_REPS; rep++) {
            int64_t acc = 0;
            const int8_t *wrow = nd->w_fixed + k * N;
            for (int64_t j = 0; j < N; j++) acc += (int64_t)wrow[j] * nd->s[j * SH_FV_REPS + rep];
            acc %= SH_FV_P2; if (acc < 0) acc += SH_FV_P2;
            nd->s_tilde[k * SH_FV_REPS + rep] = acc;
        }
    }
    return SH_OK;
}

int sh_link_add_weight(sh_link *l, const char *name,
                       const int8_t *wq, const uint16_t *wd,
                       int64_t K, int64_t N, int32_t max_m, int share_x_with) {
    if (K % SH_QK != 0) { snprintf(l->err, sizeof l->err, "K=%lld not a multiple of %d",
                                   (long long)K, SH_QK); return SH_ERR_PROTO; }
    if (l->n_nodes == l->cap_nodes) {
        size_t cap = l->cap_nodes ? l->cap_nodes * 2 : 16;
        sh_node *nn = (sh_node *)realloc(l->nodes, cap * sizeof *nn);
        if (!nn) return SH_ERR_NOMEM;
        l->nodes = nn; l->cap_nodes = cap;
    }
    sh_node *nd = &l->nodes[l->n_nodes];
    memset(nd, 0, sizeof *nd);
    snprintf(nd->name, sizeof nd->name, "%s", name);
    nd->wq = wq; nd->wd = wd; nd->K = K; nd->N = N; nd->max_m = max_m;

    /* THE shared encoding, applied once per weight. Both halves must derive the
     * same int8 from the same q8_0 bytes or unmasking returns noise. */
    nd->w_fixed = (int8_t *)malloc((size_t)K * N);
    if (!nd->w_fixed) return SH_ERR_NOMEM;
    for (int64_t k = 0; k < K; k++) {
        const uint16_t *drow = wd + (k / SH_QK) * N;
        const int8_t   *qrow = wq + k * N;
        int8_t         *frow = nd->w_fixed + k * N;
        for (int64_t j = 0; j < N; j++) {
            int64_t v = sh_encode_weight_fixed(drow[j], qrow[j]);
            if (v > SH_WEIGHT_BYTE_LIMIT || v < -SH_WEIGHT_BYTE_LIMIT) {
                snprintf(l->err, sizeof l->err,
                         "%s: fixed weight %lld exceeds the int8 lane (+-%d); it would wrap silently",
                         name, (long long)v, SH_WEIGHT_BYTE_LIMIT);
                free(nd->w_fixed); nd->w_fixed = NULL;
                return SH_ERR_RANGE;
            }
            frow[j] = (int8_t)v;
        }
    }

    nd->wq_off = align_up(l->wbytes);
    nd->wd_off = align_up(nd->wq_off + K * N);
    l->wbytes  = nd->wd_off + (K / SH_QK) * N * 2;

    if (share_x_with >= 0) {
        sh_node *donor = &l->nodes[share_x_with];
        if (donor->K != K || donor->max_m < max_m) {
            snprintf(l->err, sizeof l->err, "node %zu cannot share x with %d",
                     l->n_nodes, share_x_with);
            free(nd->w_fixed); return SH_ERR_PROTO;
        }
        nd->x_off = donor->x_off;
        nd->y_off = align_up(l->abytes);
        l->abytes = nd->y_off + (int64_t)max_m * N * 4;
        nd->shared_x = true;
    } else {
        nd->x_off = align_up(l->abytes);
        nd->y_off = align_up(nd->x_off + 3 * (int64_t)max_m * K);
        l->abytes = nd->y_off + (int64_t)max_m * N * 4;
    }

    if (l->verify) {
        int rc = fv_prepare(nd);
        if (rc != SH_OK) { free(nd->w_fixed); return rc; }
    }
    return (int)l->n_nodes++;
}

/* --- start: connect, upload public weights, install the vetted graph ------ */
static int json_append(char **buf, size_t *len, size_t *cap, const char *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    for (;;) {
        size_t avail = *cap - *len;
        va_list cp; va_copy(cp, ap);
        int n = vsnprintf(*buf + *len, avail, fmt, cp);
        va_end(cp);
        if (n < 0) { va_end(ap); return SH_ERR_NOMEM; }
        if ((size_t)n < avail) { *len += (size_t)n; va_end(ap); return SH_OK; }
        size_t ncap = (*cap ? *cap : 1024) * 2;
        while (ncap < *len + (size_t)n + 1) ncap *= 2;
        char *nb = (char *)realloc(*buf, ncap);
        if (!nb) { va_end(ap); return SH_ERR_NOMEM; }
        *buf = nb; *cap = ncap;
    }
}

int sh_link_start(sh_link *l) {
    int err = SH_OK;
    /* Restartable on purpose. The worker sizes its buffers once and installs its
     * graph once, but the engine only learns which weights exist as graphs run, so
     * a newly seen tensor means a fresh connection carrying the whole set. In
     * practice this settles after the first graph or two and then never fires
     * again -- and until it does, the local path returns the same numbers. */
    if (l->pipe) { sh_pipe_close(l->pipe); l->pipe = NULL; }
    l->pipe = sh_pipe_open(l->host, l->port, &err);
    if (!l->pipe) { snprintf(l->err, sizeof l->err, "connect %s:%d failed", l->host, l->port); return err; }

    uint8_t pay[256]; sh_reply rep;
    size_t n = sh_pack_hello(pay, 1);
    int rc = sh_pipe_call(l->pipe, SH_CMD_HELLO, pay, n, &rep);
    if (rc != SH_OK) { snprintf(l->err, sizeof l->err, "HELLO: %s", sh_pipe_last_error(l->pipe)); return rc; }
    sh_reply_free(&rep);

    const struct { int64_t size; const char *role; } bufs[2] = {
        { l->wbytes, "weights" }, { l->abytes, "activations" } };
    for (int i = 0; i < 2; i++) {
        n = sh_pack_alloc(pay, (uint64_t)bufs[i].size, bufs[i].role);
        rc = sh_pipe_call(l->pipe, SH_CMD_ALLOC_BUFFER, pay, n, &rep);
        if (rc != SH_OK) { snprintf(l->err, sizeof l->err, "ALLOC(%s): %s",
                                    bufs[i].role, sh_pipe_last_error(l->pipe)); return rc; }
        sh_reply_free(&rep);
    }

    /* Weights are PUBLIC: they cross in the clear, by design. */
    for (size_t i = 0; i < l->n_nodes; i++) {
        sh_node *nd = &l->nodes[i];
        const struct { int64_t off; const void *p; size_t bytes; } parts[2] = {
            { nd->wq_off, nd->wq, (size_t)(nd->K * nd->N) },
            { nd->wd_off, nd->wd, (size_t)((nd->K / SH_QK) * nd->N * 2) } };
        for (int k = 0; k < 2; k++) {
            const size_t CHUNK = 32u << 20;
            for (size_t off = 0; off < parts[k].bytes; off += CHUNK) {
                size_t part = parts[k].bytes - off < CHUNK ? parts[k].bytes - off : CHUNK;
                uint8_t hdr[24];
                sh_pack_set_tensor_header(hdr, 1, (uint64_t)(parts[k].off + (int64_t)off), part);
                sh_frame f = { SH_CMD_SET_TENSOR, hdr, 24,
                               (const uint8_t *)parts[k].p + off, part };
                rc = sh_pipe_exchange(l->pipe, &f, 1, &rep);
                if (rc != SH_OK) { snprintf(l->err, sizeof l->err, "upload %s: %s",
                                            nd->name, sh_pipe_last_error(l->pipe)); return rc; }
                sh_reply_free(&rep);
            }
        }
    }

    /* The graph spec: FIELD_GEMM nodes and the regions GET_TENSOR may read. */
    char *js = NULL; size_t jl = 0, jc = 0;
    json_append(&js, &jl, &jc, "{\"nodes\":[");
    for (size_t i = 0; i < l->n_nodes; i++) {
        sh_node *nd = &l->nodes[i];
        json_append(&js, &jl, &jc,
            "%s{\"op\":\"FIELD_GEMM\",\"id\":\"%s\","
            "\"wq\":{\"bid\":1,\"offset\":%lld},\"wd\":{\"bid\":1,\"offset\":%lld},"
            "\"x\":{\"bid\":2,\"offset\":%lld},\"y\":{\"bid\":2,\"offset\":%lld},"
            "\"K\":%lld,\"N\":%lld,\"max_m\":%d}",
            i ? "," : "", nd->name,
            (long long)nd->wq_off, (long long)nd->wd_off,
            (long long)nd->x_off, (long long)nd->y_off,
            (long long)nd->K, (long long)nd->N, nd->max_m);
    }
    /* One output region PER BUCKET, not one for max_m. GET_TENSOR matches the
     * (bid, offset, nbytes) triple exactly -- deliberately, since a worker that
     * accepted any sub-range of a declared output would be back to arbitrary
     * activation read-out -- so a read of m*N*4 against a declaration of
     * max_m*N*4 is refused, correctly, and the tier silently falls back to
     * computing everything in the enclave. */
    json_append(&js, &jl, &jc, "],\"outputs\":[");
    bool first_out = true;
    for (size_t i = 0; i < l->n_nodes; i++) {
        sh_node *nd = &l->nodes[i];
        for (int32_t b = 1; ; b = b * 2) {
            const int32_t mb = b > nd->max_m ? nd->max_m : b;
            json_append(&js, &jl, &jc, "%s{\"bid\":2,\"offset\":%lld,\"nbytes\":%lld}",
                        first_out ? "" : ",", (long long)nd->y_off,
                        (long long)((int64_t)mb * nd->N * 4));
            first_out = false;
            if (mb >= nd->max_m) break;
        }
    }
    json_append(&js, &jl, &jc, "]}");
    rc = sh_pipe_call(l->pipe, SH_CMD_GRAPH_INSTALL, js, jl, &rep);
    free(js);
    if (rc != SH_OK) { snprintf(l->err, sizeof l->err, "GRAPH_INSTALL: %s", sh_pipe_last_error(l->pipe)); return rc; }
    sh_reply_free(&rep);
    return SH_OK;
}

/* --- the refill: u = r.W, the one term that can never be offloaded -------- */
static void refill(const int64_t *r, int32_t m, const sh_node *nd,
                   int8_t *planes_scratch, int32_t *acc, int64_t *u) {
    const int64_t K = nd->K, N = nd->N;
    for (int64_t i = 0; i < (int64_t)m * N; i++) u[i] = 0;
    for (int p = 0; p < 3; p++) {
        const int q = sh_primes[p];
        for (int64_t i = 0; i < (int64_t)m * K; i++) planes_scratch[i] = sh_residue(r[i], q);
        memset(acc, 0, (size_t)m * N * sizeof(int32_t));
        for (int32_t row = 0; row < m; row++) {
            const int8_t *rr = planes_scratch + (int64_t)row * K;
            int32_t *out = acc + (int64_t)row * N;
            for (int64_t k = 0; k < K; k++) {
                const int32_t rv = rr[k];
                if (!rv) continue;
                const int8_t *wrow = nd->w_fixed + k * N;
                for (int64_t j = 0; j < N; j++) out[j] += rv * wrow[j];
            }
        }
        for (int64_t i = 0; i < (int64_t)m * N; i++) {
            int64_t v = acc[i] % q; if (v < 0) v += q;
            /* Stash residue p in the low bits of u; combined by CRT below. */
            u[i] |= v << (p * 21);
        }
    }
    for (int64_t i = 0; i < (int64_t)m * N; i++) {
        int32_t r0 = (int32_t)( u[i]        & 0x1fffff);
        int32_t r1 = (int32_t)((u[i] >> 21) & 0x1fffff);
        int32_t r2 = (int32_t)((u[i] >> 42) & 0x1fffff);
        u[i] = sh_crt(r0, r1, r2);
    }
}

/* --- Freivalds over an unrelated prime ------------------------------------ */
static bool fv_check(const sh_node *nd, const int64_t *x, const int64_t *y, int32_t m) {
    const int64_t K = nd->K, N = nd->N;
    const int64_t CHUNK_K = 128;                 /* keeps the rhs accumulator under 2^61 */
    for (int32_t row = 0; row < m; row++) {
        const int64_t *xr = x + (int64_t)row * K;
        const int64_t *yr = y + (int64_t)row * N;
        for (int rep = 0; rep < SH_FV_REPS; rep++) {
            int64_t lhs = 0;
            for (int64_t j = 0; j < N; j++) lhs += yr[j] * nd->s[j * SH_FV_REPS + rep];
            lhs %= SH_FV_P2; if (lhs < 0) lhs += SH_FV_P2;
            int64_t rhs = 0;
            for (int64_t k0 = 0; k0 < K; k0 += CHUNK_K) {
                int64_t k1 = k0 + CHUNK_K < K ? k0 + CHUNK_K : K, blk = 0;
                for (int64_t k = k0; k < k1; k++) blk += xr[k] * nd->s_tilde[k * SH_FV_REPS + rep];
                blk %= SH_FV_P2; if (blk < 0) blk += SH_FV_P2;
                rhs = (rhs + blk) % SH_FV_P2;
            }
            if (lhs != rhs) return false;
        }
    }
    return true;
}

int sh_link_gemm_local(sh_link *l, const int *nodes, size_t n_nodes,
                       const int64_t *x_field, int32_t m, int64_t **y_out) {
    for (size_t i = 0; i < n_nodes; i++) {
        const sh_node *nd = &l->nodes[nodes[i]];
        const int64_t K = nd->K, N = nd->N;
        int64_t *y = y_out[i];
        for (int32_t row = 0; row < m; row++) {
            const int64_t *xr = x_field + (int64_t)row * K;
            int64_t *yr = y + (int64_t)row * N;
            for (int64_t j = 0; j < N; j++) yr[j] = 0;
            for (int64_t k = 0; k < K; k++) {
                const int64_t xv = xr[k];
                if (!xv) continue;
                const int8_t *wrow = nd->w_fixed + k * N;
                for (int64_t j = 0; j < N; j++) yr[j] += xv * wrow[j];
            }
            for (int64_t j = 0; j < N; j++) yr[j] = sh_balanced(yr[j]);
        }
        l->macs += (uint64_t)m * (uint64_t)K * (uint64_t)N;
    }
    return SH_OK;
}

bool sh_link_is_live(const sh_link *l) { return l && l->pipe; }

const int8_t *sh_link_weight_rows(const sh_link *l, int node) {
    if (!l || node < 0 || (size_t)node >= l->n_nodes) return NULL;
    return l->nodes[node].w_fixed;
}

bool sh_link_verify(const sh_link *l, int node, const int64_t *x, const int64_t *y, int32_t m) {
    if (!l || node < 0 || (size_t)node >= l->n_nodes) return false;
    return fv_check(&l->nodes[node], x, y, m);
}

static int ensure(void **p, size_t *cap, size_t want) {
    if (*cap >= want) return SH_OK;
    void *n = realloc(*p, want);
    if (!n) return SH_ERR_NOMEM;
    *p = n; *cap = want;
    return SH_OK;
}

int sh_link_gemm(sh_link *l, const int *nodes, size_t n_nodes,
                 const int64_t *x_field, int32_t m, int64_t **y_out) {
    if (!n_nodes) return SH_OK;
    const int64_t K = l->nodes[nodes[0]].K;
    for (size_t i = 0; i < n_nodes; i++)
        if (l->nodes[nodes[i]].K != K) {
            snprintf(l->err, sizeof l->err, "grouped nodes disagree on K"); return SH_ERR_PROTO;
        }

    /* Shapes are PUBLIC and bucketed: the worker's readable regions are declared
     * at install time, so a batch size is rounded up to the next power of two and
     * the extra rows are zero. Zero rows produce zero outputs and are discarded,
     * and bucketing is what keeps the declaration finite -- one entry per m from
     * 1..512 per node would be tens of thousands of regions in the install. */
    int32_t mb = 1;
    while (mb < m) mb *= 2;
    if (mb > l->nodes[nodes[0]].max_m) {
        snprintf(l->err, sizeof l->err, "m=%d exceeds this node's max_m=%d", m, l->nodes[nodes[0]].max_m);
        return SH_ERR_PROTO;
    }

    int64_t maxN = 0;
    for (size_t i = 0; i < n_nodes; i++) if (l->nodes[nodes[i]].N > maxN) maxN = l->nodes[nodes[i]].N;
    int rc;
    if ((rc = ensure((void **)&l->pad,    &l->pad_cap,    (size_t)mb * K * sizeof(int64_t))) != SH_OK) return rc;
    if ((rc = ensure((void **)&l->planes, &l->planes_cap, (size_t)mb * K * 3)) != SH_OK) return rc;
    if ((rc = ensure((void **)&l->u,      &l->u_cap,      (size_t)mb * maxN * sizeof(int64_t))) != SH_OK) return rc;
    if ((rc = ensure((void **)&l->acc,    &l->acc_cap,    (size_t)mb * maxN * sizeof(int32_t))) != SH_OK) return rc;

    /* ONE pad for ONE plaintext -- rule 2. Shared-x nodes reuse this pad by
     * construction, because they read the same uploaded x region. */
    if ((rc = maskbank_issue(&l->bank, l->pad, (size_t)mb * K)) != SH_OK) {
        snprintf(l->err, sizeof l->err, "pad bank exhausted; stall the request"); return rc;
    }
    for (int p = 0; p < 3; p++) {
        const int q = sh_primes[p];
        int8_t *pl = l->planes + (size_t)p * mb * K;
        for (int64_t i = 0; i < (int64_t)mb * K; i++) {
            /* Padding rows are masked too, not left as plaintext zeros: an
             * unmasked block would tell the worker exactly where the real batch
             * ends, which is public here but is a habit worth not forming. */
            const int64_t xv = i < (int64_t)m * K ? x_field[i] : 0;
            int64_t v = (xv + l->pad[i]) % SH_M_MOD;
            if (v < 0) v += SH_M_MOD;
            pl[i] = sh_residue(v, q);
        }
    }

    /* One write: upload each distinct masked x once, ring one doorbell per node,
     * then read every output. */
    size_t nf = 0;
    sh_frame *frames = (sh_frame *)malloc((3 + 2) * n_nodes * sizeof *frames);
    uint8_t  *hdrs   = (uint8_t *)malloc((3 + 2) * n_nodes * 24);
    sh_reply *reps   = (sh_reply *)malloc((3 + 2) * n_nodes * sizeof *reps);
    if (!frames || !hdrs || !reps) { free(frames); free(hdrs); free(reps); return SH_ERR_NOMEM; }

    int64_t seen[64]; size_t n_seen = 0;
    for (size_t i = 0; i < n_nodes; i++) {
        sh_node *nd = &l->nodes[nodes[i]];
        bool dup = false;
        for (size_t t = 0; t < n_seen; t++) if (seen[t] == nd->x_off) { dup = true; break; }
        if (dup) continue;
        if (n_seen < 64) seen[n_seen++] = nd->x_off;
        const int64_t stride = (int64_t)nd->max_m * K;
        for (int p = 0; p < 3; p++) {
            uint8_t *h = hdrs + nf * 24;
            sh_pack_set_tensor_header(h, 2, (uint64_t)(nd->x_off + p * stride), (uint64_t)mb * K);
            frames[nf].cmd = SH_CMD_SET_TENSOR; frames[nf].payload = h; frames[nf].len = 24;
            frames[nf].payload2 = l->planes + (size_t)p * mb * K; frames[nf].len2 = (size_t)mb * K;
            nf++;
        }
    }
    for (size_t i = 0; i < n_nodes; i++) {
        uint8_t *h = hdrs + nf * 24;
        sh_pack_recompute(h, (uint32_t)nodes[i], (uint32_t)mb);
        frames[nf].cmd = SH_CMD_GRAPH_RECOMPUTE; frames[nf].payload = h; frames[nf].len = 8;
        frames[nf].payload2 = NULL; frames[nf].len2 = 0; nf++;
    }
    for (size_t i = 0; i < n_nodes; i++) {
        sh_node *nd = &l->nodes[nodes[i]];
        uint8_t *h = hdrs + nf * 24;
        sh_pack_region(h, 2, (uint64_t)nd->y_off, (uint64_t)mb * nd->N * 4);
        frames[nf].cmd = SH_CMD_GET_TENSOR; frames[nf].payload = h; frames[nf].len = 24;
        frames[nf].payload2 = NULL; frames[nf].len2 = 0; nf++;
    }

    rc = sh_pipe_exchange(l->pipe, frames, nf, reps);
    free(frames); free(hdrs);
    if (rc != SH_OK) {
        snprintf(l->err, sizeof l->err, "exchange: %s", sh_pipe_last_error(l->pipe));
        free(reps); return rc;
    }
    l->exchanges++;

    /* Unmask, then verify, then hand back -- never the other way round. */
    int result = SH_OK;
    for (size_t i = 0; i < n_nodes; i++) {
        sh_node *nd = &l->nodes[nodes[i]];
        sh_reply *r = &reps[nf - n_nodes + i];
        if (r->len != (size_t)mb * nd->N * 4) {
            snprintf(l->err, sizeof l->err, "%s: worker returned %zu bytes, expected %lld",
                     nd->name, r->len, (long long)((int64_t)mb * nd->N * 4));
            result = SH_ERR_PROTO; break;
        }
        const int32_t *ym = (const int32_t *)r->data;
        refill(l->pad, mb, nd, l->planes, l->acc, l->u);
        int64_t *y = y_out[i];
        for (int64_t t = 0; t < (int64_t)m * nd->N; t++)
            y[t] = sh_balanced((int64_t)ym[t] - l->u[t]);
        l->macs += (uint64_t)m * (uint64_t)nd->K * (uint64_t)nd->N;

        if (l->verify && !fv_check(nd, x_field, y, m)) {
            l->verify_fail++;
            snprintf(l->err, sizeof l->err,
                     "%s: verification FAILED -- the worker lied or the field wrapped. "
                     "Abort the request; do not sample, stream, or cache this.", nd->name);
            result = SH_ERR_VERIFY; break;
        }
    }
    for (size_t i = 0; i < nf; i++) sh_reply_free(&reps[i]);
    free(reps);
    return result;
}
