/*
 * shielded-tee.h -- the trusted half, in C: pads, refill, Freivalds, and the
 * link that drives one shielded worker.
 *
 * Mirrors shielded/tee.py. What the worker sees is public weights and masked
 * activations; what never crosses is the pad, the Freivalds secret, or any
 * plaintext activation. The four rules most easily broken by accident, all of
 * which this file is responsible for:
 *
 *  1. PADS ARE ONE-TIME. Issuance is a monotonic counter that STALLS at capacity
 *     and never wraps. Two activations under one pad hand the adversary their
 *     difference, and successive decode activations differ by very little.
 *  2. ONE PLAINTEXT GETS ONE PAD. Weights fed by the same activation (q/k/v from
 *     one attn_norm) share the pad, because masking one x three times under three
 *     pads is three encryptions of one value for no benefit.
 *  3. VERIFY BEFORE USE, over the INTEGERS. A product that exceeds M/2 wraps and
 *     stays congruent mod M, so a mod-M check accepts it and it decodes to
 *     garbage with no error signal. The check runs modulo an unrelated prime and
 *     catches a lying worker AND a field wrap in the same two dot products.
 *  4. THE FREIVALDS SECRET COMES FROM THE OS CSPRNG. A worker that can predict s
 *     solves d.s == 0 over three outputs and forges freely.
 */
#ifndef SHIELDED_TEE_H
#define SHIELDED_TEE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "shielded-wire.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SH_FV_P2      2147483647   /* 2^31-1, Mersenne, coprime to M */
#define SH_FV_S_RANGE (1 << 20)
#define SH_FV_REPS    2            /* ~2^-40 soundness per check */

typedef struct sh_link sh_link;

/* Errors beyond the wire's. */
#define SH_ERR_VERIFY   -10   /* worker lied, or the field wrapped */
#define SH_ERR_EXHAUST  -11   /* pad bank dry: stall the request, never wrap */
#define SH_ERR_RANGE    -12   /* weights do not fit the int8 lane */

sh_link *sh_link_open(const char *host, int port, bool verify, int *err);
void     sh_link_close(sh_link *l);
const char *sh_link_last_error(const sh_link *l);

/* Register one weight as a FIELD_GEMM node, before connecting.
 * `wq` is (K,N) int8 q8_0 quants, `wd` is (K/QK,N) fp16 scale bits.
 * `share_x_with` is an earlier node fed by the SAME activation, or -1.
 * Returns the node index, or negative on error. */
int sh_link_add_weight(sh_link *l, const char *name,
                       const int8_t *wq, const uint16_t *wd,
                       int64_t K, int64_t N, int32_t max_m, int share_x_with);

/* Ship the public weights and install the vetted graph. After this the only
 * compute trigger is the per-node doorbell. */
int sh_link_start(sh_link *l);

/* One masked linear op, or several sharing one activation.
 * `x_field` is the PLAINTEXT field-encoded activation, (m,K) int64, balanced.
 * `y_out[i]` receives (m,N_i) int64, exact and verified. Nothing is returned
 * until every check in the group passes. */
int sh_link_gemm(sh_link *l, const int *nodes, size_t n_nodes,
                 const int64_t *x_field, int32_t m, int64_t **y_out);

/* The same product, computed in the TEE in plain int64, with no worker involved.
 *
 * Numerically IDENTICAL to sh_link_gemm -- the offloaded path is exact, not an
 * approximation -- which is what makes it usable as a fallback rather than a
 * degraded mode: a graph that runs some nodes locally and some offloaded produces
 * the same tokens either way. Used before the link is up (weights are discovered
 * as the graph runs, but the worker's buffers are sized once) and as the honest
 * answer when no worker is reachable at all. */
int sh_link_gemm_local(sh_link *l, const int *nodes, size_t n_nodes,
                       const int64_t *x_field, int32_t m, int64_t **y_out);

/* True once the worker is connected and the graph installed. */
bool sh_link_is_live(const sh_link *l);

/* Rows of the encoded weight, for the caller's TEE-side outlier term. */
const int8_t *sh_link_weight_rows(const sh_link *l, int node);

/* Run the integrity check directly on a candidate (x, y) pair. Exposed so the
 * probe can assert BOTH directions -- accepts the honest product, rejects a
 * single-element corruption -- against the same code the online path uses. A
 * check that is only ever observed accepting is not evidence that it rejects. */
bool sh_link_verify(const sh_link *l, int node, const int64_t *x, const int64_t *y, int32_t m);

/* Counters, for the probe and for tests. */
void sh_link_stats(const sh_link *l, uint64_t *exchanges, uint64_t *macs,
                   uint64_t *verify_fail);

#ifdef __cplusplus
}
#endif
#endif
