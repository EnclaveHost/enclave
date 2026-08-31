/*
 * anchor-core.h -- the TA-side core of the phone trust anchor, as a spike.
 *
 * This is the piece of shielded-tee.c that must live inside a TrustZone TA
 * for the phone-hosted anchor: pad derivation (ChaCha20 bank), masking,
 * unmasking, integer Freivalds, and the int64 local reference. It is OS-free
 * on purpose -- no threads, no sockets, no stdio, no getenv -- so the same
 * object links into a GlobalPlatform TA, a qemu-user functional check, and a
 * native POSIX harness. Randomness comes in through a callback (getrandom()
 * outside, TEE_GenerateRandom() inside).
 *
 * Scope: SPIKE. One group of nodes sharing one activation, m = 1 (the decode
 * shape), one exchange in flight. The production port replaces this file with
 * the real executor; what must survive verbatim are the four rules from
 * shielded/README.md -- pads one-time (the bank counter STALLS, never wraps),
 * verify strictly before use, Freivalds over the integers mod an unrelated
 * prime, no adaptive exponents -- all of which this core inherits from the
 * same generic kernels (shielded-simd.c) the CVM stack runs.
 *
 * What NEVER leaves this core through its API: the pad r, u = r.W, the
 * Freivalds secrets s / s_tilde, or an unmasked y. an_mask() emits ciphertext
 * planes; an_finish() consumes a ciphertext reply and reports only verdicts
 * and digests. The plaintext x enters (in the TA it arrives through secure
 * storage or stays TA-internal; in the spike the CA supplies a public test
 * fixture and the README says why that is not a leak: the fixture is public
 * by construction, the measurement is what the spike is for).
 */
#ifndef ANCHOR_CORE_H
#define ANCHOR_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define AN_MAX_NODES 8            /* mirrors SH_GROUP_MAX */
#define AN_FV_REPS   2
#define AN_OK          0
#define AN_ERR_NOMEM  -1
#define AN_ERR_PARAM  -2
#define AN_ERR_RNG    -3
#define AN_ERR_VERIFY -10         /* worker lied or the field wrapped */
#define AN_ERR_EXHAUST -11        /* pad bank dry: stall, never wrap */
#define AN_ERR_NOPAD  -12         /* an_mask() with no staged pad */

/* Fill buf with n cryptographically strong random bytes; nonzero = failure. */
typedef int (*an_rng_fn)(void *buf, size_t n);

typedef struct an_ctx an_ctx;

an_ctx *an_create(an_rng_fn rng);
void    an_destroy(an_ctx *c);

/* Register one weight of the single group. `w_fixed` is (N,K) int8 in THE
 * encoding (shielded-field.h), COPIED into the core (in the TA that copy is
 * what puts it behind the TEE boundary). All nodes share K -- one activation,
 * one pad. Returns node index or negative. */
int an_add_weight(an_ctx *c, const int8_t *w_fixed, int64_t K, int64_t N);

/* Draw the Freivalds secrets from the rng, compute s_tilde = W.s per node,
 * allocate the working buffers. Call once, after the last add_weight. */
int an_prepare(an_ctx *c);

/* Stage one pad: r from the ChaCha20 bank (one-time, monotonic, stalls when
 * dry), u = r.W for every node. This is the refill term -- the cost the phone
 * pays per exchange (from its precomputed bank in production; inline here so
 * the spike can measure it). */
int an_pad_gen(an_ctx *c);
int an_pad_ready(const an_ctx *c);

/* Mask the plaintext activation x (len K, balanced field elements) under the
 * staged pad, CONSUMING it. Writes the three residue planes -- ciphertext --
 * to planes_out (3*K bytes) and keeps x for the verify. */
int an_mask(an_ctx *c, const int64_t *x, int8_t *planes_out);

/* Consume the worker's reply for every node in order: ywidth 4 (FIELD_GEMM,
 * int32) or 3 (FIELD_GEMM24, packed int24). Unmasks INTO THE CORE, runs the
 * integer Freivalds check per node, and refuses the lot on any mismatch.
 * reply_len must equal sum(N_i) * ywidth. */
int an_finish(an_ctx *c, const uint8_t *reply, size_t reply_len, int ywidth);

/* After a successful finish: compare the unmasked y of every node against a
 * local int64 x.W computed here, bit for bit (e2e.py's equality, inside the
 * core). Returns AN_OK only on exact agreement everywhere. */
int an_check_local(an_ctx *c);

/* Largest |y| over every node of the last finished exchange -- the field
 * headroom witness. A value approaching M/2 means the site is about to wrap,
 * which the integer Freivalds would catch as a verification failure. */
int64_t an_peak_abs_y(const an_ctx *c);

/* FNV-1a over the unmasked y of `node`, so an outer harness can compare two
 * runs without the plaintext leaving the core. */
uint64_t an_y_digest(const an_ctx *c, int node);

/* Counters. pads_issued only ever grows; verify_fail should stay 0. */
void an_stats(const an_ctx *c, uint64_t *pads_issued, uint64_t *exchanges,
              uint64_t *verify_fail);

/* Heap the core would need for this geometry, before creating it: the TA has
 * to declare TA_DATA_SIZE up front and the spike wants the number in the log. */
size_t an_footprint(int n_nodes, const int64_t *K, const int64_t *N);

#ifdef __cplusplus
}
#endif
#endif
