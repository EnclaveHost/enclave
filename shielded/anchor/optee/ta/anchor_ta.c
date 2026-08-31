/*
 * anchor_ta.c -- the anchor spike as a GlobalPlatform TA.
 *
 * Everything secret lives here: the ChaCha20 pad bank key, the pads, u = r.W,
 * the Freivalds secrets, the plaintext activation and the unmasked products.
 * What crosses the TEEC boundary is ciphertext (masked planes out, masked
 * replies in), public weights (in), and verdicts (out). The normal-world CA
 * owns the socket to the worker and never sees a secret -- the phone
 * topology's rule, enforced here by construction.
 *
 * The activation is generated inside the TA from a (seed, index) pair with an
 * integer LCG: it is a public test fixture, but generating it here keeps the
 * spike's data flow identical to production's (plaintext never in normal
 * world) and proves the TA needs no floating point at all.
 */
#include <tee_internal_api.h>
#include <tee_internal_api_extensions.h>

#include "anchor_ta.h"
#include "anchor-core.h"

static an_ctx *g_ctx;
static int64_t g_K;

static int ta_rng(void *buf, size_t n) {
    TEE_GenerateRandom(buf, (uint32_t)n);
    return 0;
}

/* Same constants as harness/fixture.h's LCG, integer-only. */
static void gen_x(uint32_t seed, uint32_t index, int64_t K, int64_t *x) {
    uint32_t s = seed ^ (index * 2654435761u);
    for (int64_t i = 0; i < K; i++) {
        s = (uint32_t)(s * 1103515245u + 12345u) & 0x7fffffff;
        x[i] = (int64_t)(s % 1801u) - 900;
    }
}

static int64_t *g_x;   /* K, TA-heap: the plaintext never leaves */

TEE_Result TA_CreateEntryPoint(void) { return TEE_SUCCESS; }
void TA_DestroyEntryPoint(void) {}

TEE_Result TA_OpenSessionEntryPoint(uint32_t pt, TEE_Param params[4], void **sess) {
    (void)pt; (void)params; (void)sess;
    return TEE_SUCCESS;
}

void TA_CloseSessionEntryPoint(void *sess) {
    (void)sess;
    an_destroy(g_ctx); g_ctx = NULL;
    TEE_Free(g_x); g_x = NULL;
}

static TEE_Result cmd_setup(uint32_t pt, TEE_Param p[4]) {
    const uint32_t exp = TEE_PARAM_TYPES(TEE_PARAM_TYPE_MEMREF_INPUT,
                                         TEE_PARAM_TYPE_VALUE_OUTPUT,
                                         TEE_PARAM_TYPE_NONE, TEE_PARAM_TYPE_NONE);
    if (pt != exp) return TEE_ERROR_BAD_PARAMETERS;
    const uint8_t *blob = (const uint8_t *)p[0].memref.buffer;
    size_t len = p[0].memref.size;
    if (len < 4) return TEE_ERROR_BAD_PARAMETERS;

    an_destroy(g_ctx); g_ctx = NULL;
    TEE_Free(g_x); g_x = NULL;

    uint32_t n_nodes;
    TEE_MemMove(&n_nodes, blob, 4);
    if (n_nodes < 1 || n_nodes > AN_MAX_NODES) return TEE_ERROR_BAD_PARAMETERS;
    if (len < 4 + (size_t)n_nodes * 8) return TEE_ERROR_BAD_PARAMETERS;

    int64_t Ks[AN_MAX_NODES], Ns[AN_MAX_NODES];
    size_t off = 4;
    for (uint32_t i = 0; i < n_nodes; i++) {
        uint32_t K, N;
        TEE_MemMove(&K, blob + off, 4); off += 4;
        TEE_MemMove(&N, blob + off, 4); off += 4;
        Ks[i] = K; Ns[i] = N;
    }
    size_t need = off;
    for (uint32_t i = 0; i < n_nodes; i++) need += (size_t)Ks[i] * (size_t)Ns[i];
    if (len < need) return TEE_ERROR_BAD_PARAMETERS;

    g_ctx = an_create(ta_rng);
    if (!g_ctx) return TEE_ERROR_OUT_OF_MEMORY;
    for (uint32_t i = 0; i < n_nodes; i++) {
        if (an_add_weight(g_ctx, (const int8_t *)(blob + off), Ks[i], Ns[i]) < 0) {
            an_destroy(g_ctx); g_ctx = NULL;
            return TEE_ERROR_BAD_PARAMETERS;
        }
        off += (size_t)Ks[i] * (size_t)Ns[i];
    }
    if (an_prepare(g_ctx) != AN_OK) {
        an_destroy(g_ctx); g_ctx = NULL;
        return TEE_ERROR_OUT_OF_MEMORY;
    }
    g_K = Ks[0];
    g_x = (int64_t *)TEE_Malloc((uint32_t)(g_K * sizeof(int64_t)), 0);
    if (!g_x) { an_destroy(g_ctx); g_ctx = NULL; return TEE_ERROR_OUT_OF_MEMORY; }

    p[1].value.a = (uint32_t)(an_footprint((int)n_nodes, Ks, Ns) / 1024);
    p[1].value.b = 0;
    return TEE_SUCCESS;
}

static TEE_Result cmd_pad(void) {
    if (!g_ctx) return TEE_ERROR_BAD_STATE;
    int rc = an_pad_gen(g_ctx);
    if (rc == AN_ERR_EXHAUST) return TEE_ERROR_STORAGE_NO_SPACE;   /* stall, never wrap */
    return rc == AN_OK ? TEE_SUCCESS : TEE_ERROR_GENERIC;
}

static TEE_Result cmd_mask(uint32_t pt, TEE_Param p[4]) {
    const uint32_t exp = TEE_PARAM_TYPES(TEE_PARAM_TYPE_VALUE_INPUT,
                                         TEE_PARAM_TYPE_MEMREF_OUTPUT,
                                         TEE_PARAM_TYPE_NONE, TEE_PARAM_TYPE_NONE);
    if (pt != exp) return TEE_ERROR_BAD_PARAMETERS;
    if (!g_ctx || !g_x) return TEE_ERROR_BAD_STATE;
    if (p[1].memref.size < (size_t)(3 * g_K)) return TEE_ERROR_SHORT_BUFFER;
    gen_x(p[0].value.a, p[0].value.b, g_K, g_x);
    int rc = an_mask(g_ctx, g_x, (int8_t *)p[1].memref.buffer);
    if (rc == AN_ERR_NOPAD) return TEE_ERROR_BAD_STATE;
    if (rc != AN_OK) return TEE_ERROR_GENERIC;
    p[1].memref.size = (size_t)(3 * g_K);
    return TEE_SUCCESS;
}

static TEE_Result cmd_finish(uint32_t pt, TEE_Param p[4]) {
    const uint32_t exp = TEE_PARAM_TYPES(TEE_PARAM_TYPE_MEMREF_INPUT,
                                         TEE_PARAM_TYPE_VALUE_INPUT,
                                         TEE_PARAM_TYPE_VALUE_OUTPUT, TEE_PARAM_TYPE_NONE);
    if (pt != exp) return TEE_ERROR_BAD_PARAMETERS;
    if (!g_ctx) return TEE_ERROR_BAD_STATE;
    const int rc = an_finish(g_ctx, (const uint8_t *)p[0].memref.buffer,
                             p[0].memref.size, (int)p[1].value.a);
    p[2].value.a = rc == AN_OK;
    p[2].value.b = 0;
    if (rc == AN_OK)
        p[2].value.b = an_check_local(g_ctx) == AN_OK;
    /* A verification failure is an ANSWER for the spike, not a TA fault. */
    return (rc == AN_OK || rc == AN_ERR_VERIFY) ? TEE_SUCCESS : TEE_ERROR_BAD_PARAMETERS;
}

static TEE_Result cmd_stats(uint32_t pt, TEE_Param p[4]) {
    const uint32_t exp = TEE_PARAM_TYPES(TEE_PARAM_TYPE_VALUE_OUTPUT,
                                         TEE_PARAM_TYPE_NONE,
                                         TEE_PARAM_TYPE_NONE, TEE_PARAM_TYPE_NONE);
    if (pt != exp) return TEE_ERROR_BAD_PARAMETERS;
    if (!g_ctx) return TEE_ERROR_BAD_STATE;
    uint64_t pads = 0, ex = 0, vf = 0;
    an_stats(g_ctx, &pads, &ex, &vf);
    p[0].value.a = (uint32_t)pads;
    p[0].value.b = (uint32_t)vf;
    return TEE_SUCCESS;
}

TEE_Result TA_InvokeCommandEntryPoint(void *sess, uint32_t cmd, uint32_t pt, TEE_Param params[4]) {
    (void)sess;
    switch (cmd) {
    case TA_ANCHOR_CMD_SETUP:  return cmd_setup(pt, params);
    case TA_ANCHOR_CMD_PAD:    return cmd_pad();
    case TA_ANCHOR_CMD_MASK:   return cmd_mask(pt, params);
    case TA_ANCHOR_CMD_FINISH: return cmd_finish(pt, params);
    case TA_ANCHOR_CMD_NOP:    return TEE_SUCCESS;
    case TA_ANCHOR_CMD_STATS:  return cmd_stats(pt, params);
    default: return TEE_ERROR_NOT_SUPPORTED;
    }
}
