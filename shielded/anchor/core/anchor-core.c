/*
 * anchor-core.c -- see anchor-core.h. OS-free: libc string/stdlib only.
 *
 * The arithmetic is NOT reimplemented here: masking, unmasking, Freivalds and
 * refill are the generic build of wasm/ggml-shielded/shielded-simd.c -- the
 * same functions the CVM stack self-checks its AVX-512 twins against. This
 * file adds only what shielded-tee.c keeps around them: the ChaCha20 pad bank
 * (copied verbatim from shielded-tee.c, minus the pthread lock -- a TA
 * session is single-threaded), the Freivalds secret handling, and the
 * fixed-buffer lifecycle a TA needs (allocate once at prepare, never on the
 * exchange path).
 */
#include "anchor-core.h"
#include "shielded-field.h"
#include "shielded-simd.h"

/* The refill is the one hot loop that pays for a vector kernel (3x the token's
 * MACs). The core stays OS-free and table-free: the build names the kernel.
 * Default = the generic C body every other rung measured; the phone's pVM
 * build passes -DAN_REFILL=sh_simd_neon_refill and links the SDOT object
 * (shielded-simd.c with -DSH_SIMD_NEON). Both produce the same u: an_check_local
 * asserts the unmasked product against the int64 truth every exchange, so a
 * kernel that lied would fail `exact` on the first shape, not silently. */
#ifndef AN_REFILL
#define AN_REFILL sh_simd_generic_refill
#endif

#include <stdlib.h>
#include <string.h>

#define AN_FV_S_RANGE (1 << 20)   /* mirrors SH_FV_S_RANGE */
/* Each bank index owns 2^24 ChaCha blocks, eight field draws per block.
 * Refuse geometries that would overlap the next index's counter domain. */
#define AN_BANK_MAX_K (UINT64_C(8) << 24)
/* fv_prepare accumulates exact integers in double before reducing. */
#define AN_FV_MAX_N (((UINT64_C(1) << 53) - 1) / ((AN_FV_S_RANGE - 1) * SH_WEIGHT_BYTE_LIMIT))
/* Refill's float-estimate modq requires |dot| < 2^28. A row's L1 bound
 * covers every pad, all three unsigned residue planes, and the local oracle. */
#define AN_REFILL_L1_LIMIT (((UINT64_C(1) << 28) - 1) / (SH_Q0 - 1))

/* --- ChaCha20 block, verbatim from shielded-tee.c ------------------------- */
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

/* One issuance index -> n uniform values over [0, M). Uint64 draw then reduce:
 * modulo bias ~2^-40. Identical to shielded-tee.c's maskbank_issue body. */
static void bank_fill(const uint32_t key[8], uint64_t index, int32_t *dst, size_t n) {
    uint32_t blk[16];
    uint64_t ctr = index << 24;
    size_t produced = 0;
    while (produced < n) {
        chacha20_block(key, ctr++, blk);
        for (int i = 0; i + 1 < 16 && produced < n; i += 2) {
            const uint64_t v = ((uint64_t)blk[i + 1] << 32) | blk[i];
            dst[produced++] = (int32_t)(v % (uint64_t)SH_M_MOD);
        }
    }
}

typedef struct {
    int8_t  *w;                /* (N,K), owned copy */
    int64_t  K, N;
    int64_t  u_off;            /* columns within the group's u row */
    int64_t *s, *st;           /* Freivalds reference layout, (N,REPS)/(K,REPS) */
    int32_t *s32, *st32;       /* request-path rows [REPS][N] / [REPS][K] */
    int64_t *y;                /* unmasked, (1,N) -- m=1 spike */
    int64_t *y_local;          /* int64 reference product */
} an_node;

struct an_ctx {
    an_rng_fn rng;
    an_node  nodes[AN_MAX_NODES];
    int      n_nodes;
    int64_t  K, u_len;

    uint32_t bank_key[8];
    uint64_t bank_counter, bank_capacity;

    int32_t *r;                /* staged pad, K */
    int32_t *u;                /* staged u = r.W, u_len */
    uint8_t *rplanes;          /* pad residue planes for refill, 3*K */
    int32_t *acc;              /* refill scratch, 12*Nmax */
    int64_t *x;                /* kept plaintext for the verify, K */
    int      pad_ready, reply_pending, result_valid, prepared;

    uint64_t pads_issued, exchanges, verify_fail;
};

static void an_wipe(void *p, size_t n) {
    volatile unsigned char *v = (volatile unsigned char *)p;
    if (v) while (n--) *v++ = 0;
}

static void *an_free_secret(void *p, size_t n) {
    an_wipe(p, n);
    free(p);
    return NULL;
}

/* Also used to unwind a failed prepare, preserving registered public weights
 * so a caller can retry without leaking buffers or reusing partial secrets. */
static void an_clear_work(an_ctx *c) {
    int64_t Nmax = 0;
    for (int i = 0; i < c->n_nodes; i++) {
        an_node *n = &c->nodes[i];
        if (n->N > Nmax) Nmax = n->N;
        n->s = an_free_secret(n->s, (size_t)n->N * AN_FV_REPS * sizeof(int64_t));
        n->st = an_free_secret(n->st, (size_t)n->K * AN_FV_REPS * sizeof(int64_t));
        n->s32 = an_free_secret(n->s32, (size_t)n->N * AN_FV_REPS * sizeof(int32_t));
        n->st32 = an_free_secret(n->st32, (size_t)n->K * AN_FV_REPS * sizeof(int32_t));
        n->y = an_free_secret(n->y, (size_t)n->N * sizeof(int64_t));
        n->y_local = an_free_secret(n->y_local, (size_t)n->N * sizeof(int64_t));
    }
    c->r = an_free_secret(c->r, (size_t)c->K * sizeof(int32_t));
    c->u = an_free_secret(c->u, (size_t)c->u_len * sizeof(int32_t));
    c->rplanes = an_free_secret(c->rplanes, (size_t)3 * c->K);
    c->acc = an_free_secret(c->acc, (size_t)12 * Nmax * sizeof(int32_t));
    c->x = an_free_secret(c->x, (size_t)c->K * sizeof(int64_t));
    c->pad_ready = c->reply_pending = c->result_valid = c->prepared = 0;
}

an_ctx *an_create(an_rng_fn rng) {
    if (!rng) return NULL;
    an_ctx *c = (an_ctx *)calloc(1, sizeof *c);
    if (!c) return NULL;
    c->rng = rng;
    c->bank_capacity = (uint64_t)1 << 40;
    if (rng(c->bank_key, sizeof c->bank_key) != 0) { an_destroy(c); return NULL; }
    return c;
}

void an_destroy(an_ctx *c) {
    if (!c) return;
    an_clear_work(c);
    for (int i = 0; i < c->n_nodes; i++) free(c->nodes[i].w);
    an_wipe(c, sizeof *c);
    free(c);
}

int an_add_weight(an_ctx *c, const int8_t *w_fixed, int64_t K, int64_t N) {
    if (!c || !w_fixed || K <= 0 || N <= 0 || c->prepared) return AN_ERR_PARAM;
    if (c->n_nodes == AN_MAX_NODES) return AN_ERR_PARAM;
    if (c->n_nodes && K != c->K) return AN_ERR_PARAM;   /* one group, one K */
    int64_t Ks[AN_MAX_NODES], Ns[AN_MAX_NODES];
    for (int i = 0; i < c->n_nodes; i++) { Ks[i] = c->nodes[i].K; Ns[i] = c->nodes[i].N; }
    Ks[c->n_nodes] = K; Ns[c->n_nodes] = N;
    if (!an_footprint(c->n_nodes + 1, Ks, Ns)) return AN_ERR_PARAM;
    int8_t *owned = (int8_t *)malloc((size_t)K * N);
    if (!owned) return AN_ERR_NOMEM;
    memcpy(owned, w_fixed, (size_t)K * N);
    for (int64_t j = 0; j < N; j++) {
        uint64_t l1 = 0;
        for (int64_t k = 0; k < K; k++) {
            const int v = owned[j * K + k];
            if (v > SH_WEIGHT_BYTE_LIMIT || v < -SH_WEIGHT_BYTE_LIMIT)
                goto bad_weight;                       /* residue identity would break */
            l1 += v < 0 ? -v : v;
        }
        if (l1 > AN_REFILL_L1_LIMIT) goto bad_weight;
    }
    an_node *n = &c->nodes[c->n_nodes];
    n->w = owned;
    n->K = K; n->N = N; n->u_off = c->u_len;
    c->K = K; c->u_len += N;
    return c->n_nodes++;
bad_weight:
    free(owned);
    return AN_ERR_PARAM;
}

int an_prepare(an_ctx *c) {
    if (!c || !c->n_nodes || c->prepared) return AN_ERR_PARAM;
    int err = AN_ERR_NOMEM;
    int64_t Nmax = 0;
    for (int i = 0; i < c->n_nodes; i++) if (c->nodes[i].N > Nmax) Nmax = c->nodes[i].N;
    c->r       = (int32_t *)malloc((size_t)c->K * sizeof(int32_t));
    c->u       = (int32_t *)malloc((size_t)c->u_len * sizeof(int32_t));
    c->rplanes = (uint8_t *)malloc((size_t)3 * c->K);
    c->acc     = (int32_t *)malloc((size_t)12 * Nmax * sizeof(int32_t));
    c->x       = (int64_t *)malloc((size_t)c->K * sizeof(int64_t));
    if (!c->r || !c->u || !c->rplanes || !c->acc || !c->x) goto fail;

    for (int i = 0; i < c->n_nodes; i++) {
        an_node *n = &c->nodes[i];
        const int64_t K = n->K, N = n->N;
        n->s    = (int64_t *)malloc((size_t)N * AN_FV_REPS * sizeof(int64_t));
        n->st   = (int64_t *)malloc((size_t)K * AN_FV_REPS * sizeof(int64_t));
        n->s32  = (int32_t *)malloc((size_t)N * AN_FV_REPS * sizeof(int32_t));
        n->st32 = (int32_t *)malloc((size_t)K * AN_FV_REPS * sizeof(int32_t));
        n->y       = (int64_t *)malloc((size_t)N * sizeof(int64_t));
        n->y_local = (int64_t *)malloc((size_t)N * sizeof(int64_t));
        if (!n->s || !n->st || !n->s32 || !n->st32 || !n->y || !n->y_local) goto fail;
        /* s from the CALLER'S CSPRNG -- rule 4: predictable s = forgeable y. */
        uint64_t *raw = (uint64_t *)malloc((size_t)N * AN_FV_REPS * sizeof(uint64_t));
        if (!raw) goto fail;
        if (c->rng(raw, (size_t)N * AN_FV_REPS * sizeof(uint64_t)) != 0) {
            an_wipe(raw, (size_t)N * AN_FV_REPS * sizeof(uint64_t));
            free(raw); err = AN_ERR_RNG; goto fail;
        }
        for (int64_t j = 0; j < N * AN_FV_REPS; j++)
            n->s[j] = 1 + (int64_t)(raw[j] % (uint64_t)(AN_FV_S_RANGE - 1));
        an_wipe(raw, (size_t)N * AN_FV_REPS * sizeof(uint64_t));
        free(raw);
        sh_simd_generic_fv_prepare(n->w, K, N, n->s, AN_FV_REPS, n->st);
        for (int64_t j = 0; j < N; j++)
            for (int rep = 0; rep < AN_FV_REPS; rep++)
                n->s32[(size_t)rep * N + j] = (int32_t)n->s[j * AN_FV_REPS + rep];
        for (int64_t k = 0; k < K; k++)
            for (int rep = 0; rep < AN_FV_REPS; rep++)
                n->st32[(size_t)rep * K + k] = (int32_t)n->st[k * AN_FV_REPS + rep];
    }
    c->prepared = 1;
    return AN_OK;
fail:
    an_clear_work(c);
    return err;
}

int an_pad_gen(an_ctx *c) {
    if (!c || !c->prepared || c->reply_pending) return AN_ERR_PARAM;
    if (c->bank_counter >= c->bank_capacity) return AN_ERR_EXHAUST;   /* stall, never wrap */
    const uint64_t index = c->bank_counter++;
    bank_fill(c->bank_key, index, c->r, (size_t)c->K);
    sh_simd_generic_pad_planes(c->r, (size_t)c->K, c->rplanes, c->rplanes + c->K, c->rplanes + 2 * c->K);
    for (int i = 0; i < c->n_nodes; i++) {
        an_node *n = &c->nodes[i];
        AN_REFILL(c->rplanes, 1, n->w, n->K, n->N, c->u + n->u_off, c->u_len, c->acc);
    }
    c->pads_issued++;
    c->pad_ready = 1;
    return AN_OK;
}

int an_pad_ready(const an_ctx *c) { return c && c->pad_ready; }

int an_mask(an_ctx *c, const int64_t *x, int8_t *planes_out) {
    if (!c || !x || !planes_out || !c->prepared || c->reply_pending) return AN_ERR_PARAM;
    if (!c->pad_ready) return AN_ERR_NOPAD;
    /* Same raw-kernel precondition as sh_link_gemm: reject before consuming
     * the pad or writing ciphertext. Unsigned arithmetic handles INT64_MIN. */
    uint64_t bad = 0;
    for (int64_t k = 0; k < c->K; k++)
        bad |= (uint64_t)x[k] + SH_FV_X_LIMIT - 1 >= 2 * SH_FV_X_LIMIT - 1;
    if (bad) return AN_ERR_VERIFY;
    c->pad_ready = 0;                 /* CONSUMED here, whatever happens next */
    memcpy(c->x, x, (size_t)c->K * sizeof(int64_t));
    c->reply_pending = 1;
    c->result_valid = 0;
    sh_simd_generic_mask_planes(c->x, c->r, (size_t)c->K,
                                planes_out, planes_out + c->K, planes_out + 2 * c->K);
    return AN_OK;
}

int an_finish(an_ctx *c, const uint8_t *reply, size_t reply_len, int ywidth) {
    if (!c || !c->prepared || !c->reply_pending) return AN_ERR_PARAM;
    /* One attempt per consumed pad, including malformed responses. Keeping
     * x for the local oracle must never authorize another worker response. */
    c->reply_pending = 0;
    c->result_valid = 0;
    if (!reply || (ywidth != 3 && ywidth != 4)) return AN_ERR_PARAM;
    size_t want = 0;
    for (int i = 0; i < c->n_nodes; i++) want += (size_t)c->nodes[i].N * (size_t)ywidth;
    if (reply_len != want) return AN_ERR_PARAM;

    size_t off = 0;
    int ok = 1;
    for (int i = 0; i < c->n_nodes; i++) {
        an_node *n = &c->nodes[i];
        int64_t lhs[AN_FV_REPS], rhs[AN_FV_REPS];
        /* unmask fused with the Freivalds lhs, exactly the online path */
        if (ywidth == 3)
            sh_simd_generic_unmask24_fv(reply + off, c->u + n->u_off, n->s32, AN_FV_REPS, n->N, n->y, lhs);
        else {
            /* Snapshot before checking: TA shared memory can change between
             * validation and use. Refill scratch is idle and holds 12*Nmax
             * words, so this also handles unaligned replies without allocating.
             * Packed int24 is intrinsically safe for the raw subtraction. */
            memcpy(c->acc, reply + off, (size_t)n->N * sizeof(int32_t));
            uint32_t bad = 0;
            for (int64_t j = 0; j < n->N; j++)
                bad |= (uint32_t)c->acc[j] + (uint32_t)SH_HALF_M >= (uint32_t)SH_M_MOD;
            if (bad) { ok = 0; break; }
            sh_simd_generic_unmask_fv(c->acc, c->u + n->u_off,
                                      n->s32, AN_FV_REPS, n->N, n->y, lhs);
        }
        sh_simd_generic_fv_dots_x(c->x, n->st32, AN_FV_REPS, n->K, rhs);
        for (int rep = 0; rep < AN_FV_REPS; rep++) ok = ok && lhs[rep] == rhs[rep];
        off += (size_t)n->N * (size_t)ywidth;
    }
    if (!ok) {
        c->verify_fail++;
        for (int i = 0; i < c->n_nodes; i++)
            memset(c->nodes[i].y, 0, (size_t)c->nodes[i].N * sizeof(int64_t));   /* discard, rule 3 */
        return AN_ERR_VERIFY;
    }
    c->exchanges++;
    c->result_valid = 1;              /* verified y and x stay valid for the local oracle */
    return AN_OK;
}

int an_check_local(an_ctx *c) {
    if (!c || !c->result_valid) return AN_ERR_PARAM;
    for (int i = 0; i < c->n_nodes; i++) {
        an_node *n = &c->nodes[i];
        for (int64_t j = 0; j < n->N; j++) {
            const int8_t *w = n->w + j * n->K;
            int64_t acc = 0;
            for (int64_t k = 0; k < n->K; k++) acc += c->x[k] * w[k];
            n->y_local[j] = sh_balanced(acc);
        }
        if (memcmp(n->y, n->y_local, (size_t)n->N * sizeof(int64_t)) != 0)
            return AN_ERR_VERIFY;
    }
    return AN_OK;
}

int64_t an_peak_abs_y(const an_ctx *c) {
    if (!c || !c->result_valid) return 0;
    int64_t peak = 0;
    for (int i = 0; i < c->n_nodes; i++) {
        const an_node *n = &c->nodes[i];
        for (int64_t j = 0; j < n->N; j++) {
            const int64_t v = n->y[j] < 0 ? -n->y[j] : n->y[j];
            if (v > peak) peak = v;
        }
    }
    return peak;
}

uint64_t an_y_digest(const an_ctx *c, int node) {
    if (!c || !c->result_valid || node < 0 || node >= c->n_nodes) return 0;
    const an_node *n = &c->nodes[node];
    uint64_t h = 0xcbf29ce484222325ull;
    const uint8_t *p = (const uint8_t *)n->y;
    for (size_t i = 0; i < (size_t)n->N * sizeof(int64_t); i++) { h ^= p[i]; h *= 0x100000001b3ull; }
    return h;
}

void an_stats(const an_ctx *c, uint64_t *pads_issued, uint64_t *exchanges, uint64_t *verify_fail) {
    if (!c) return;
    if (pads_issued) *pads_issued = c->pads_issued;
    if (exchanges) *exchanges = c->exchanges;
    if (verify_fail) *verify_fail = c->verify_fail;
}

static int an_size_add(size_t *total, uint64_t count, size_t bytes) {
    if (count > (SIZE_MAX - *total) / bytes) return 0;
    *total += (size_t)count * bytes;
    return 1;
}

size_t an_footprint(int n_nodes, const int64_t *K, const int64_t *N) {
    size_t total = sizeof(an_ctx);
    if (n_nodes < 0 || n_nodes > AN_MAX_NODES || (n_nodes && (!K || !N))) return 0;
    uint64_t u_len = 0, Nmax = 0, k0 = n_nodes ? (uint64_t)K[0] : 0;
    for (int i = 0; i < n_nodes; i++) {
        if (K[i] <= 0 || N[i] <= 0 || (uint64_t)K[i] != k0 || k0 > AN_BANK_MAX_K ||
            (uint64_t)N[i] > AN_FV_MAX_N) return 0;
        const uint64_t n = (uint64_t)N[i];
        if (!an_size_add(&total, k0 * n, 1) ||                         /* w */
            !an_size_add(&total, n, AN_FV_REPS * (8 + 4) + 16) ||    /* s, s32, y, y_local */
            !an_size_add(&total, k0, AN_FV_REPS * (8 + 4))) return 0; /* st, st32 */
        u_len += n;
        if (n > Nmax) Nmax = n;
    }
    if (!an_size_add(&total, k0, 4 + 3 + 8) ||                         /* r, planes, x */
        !an_size_add(&total, u_len, 4) || !an_size_add(&total, Nmax, 12 * 4)) return 0; /* u, acc */
    return total;
}
