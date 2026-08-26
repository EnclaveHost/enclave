/*
 * shielded-field.h -- the RNS field and THE shared weight encoding, in C.
 *
 * This is the third implementation of one routine. shielded/field.py is the
 * reference, metal/guest/shielded.mjs mirrors it in float32, and this mirrors it
 * again for the engine-side backend. They are not allowed to disagree by even one
 * ulp: the TEE computes u = r*W and the GPU computes (x+r)*W, and the unmasking
 * subtraction returns NOISE rather than an error if the two derived different
 * field elements from the same q8_0 bytes. There is no runtime signal for that,
 * which is why the agreement is pinned by a cross-language vector test instead of
 * by three careful readings.
 */
#ifndef SHIELDED_FIELD_H
#define SHIELDED_FIELD_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Byte-sized RNS primes: each residue fits one int8 lane, so a field GEMM is N
 * GEMMs rather than the N^2 cross-products a single 24-bit prime would need. */
#define SH_Q0 251
#define SH_Q1 241
#define SH_Q2 239
#define SH_M_MOD  ((int64_t)SH_Q0 * SH_Q1 * SH_Q2)   /* 14457349, ~2^23.8 */
#define SH_HALF_M (SH_M_MOD / 2)
#define SH_QK   32      /* q8_0 block: one fp16 scale per 32 weights */
#define SH_FRAC 8       /* l = 8 fractional bits, per the design doc */

/* The kernel's int8 weight lane, exactly min(primes)/2. At or below it the
 * balanced residue of w mod every prime IS w, so the weight needs no RNS
 * decomposition on either side -- the single largest reason the fused kernel is
 * fast (see REPORT.md: keeping the modulos made v1 ALU-bound and WORSE than not
 * fusing at all). */
#define SH_WEIGHT_BYTE_LIMIT 119

extern const int sh_primes[3];

/* fp16 bits -> float, subnormals included. Real GGUF scales reach subnormal
 * territory, and a naive converter silently gets those wrong. */
float sh_half_to_float(uint16_t h);

/* THE encoding. Mirrors shielded/field.py::encode_weight_fixed operation for
 * operation, in float32:
 *     d256    = fp32(d_fp16) * 256.0          (exact: 256 is a power of two)
 *     w_fixed = floor(d256 * fp32(q) + 0.5)   (one fp32 multiply, then floor)
 * Deviating from this order -- fusing the multiply-add, widening to double,
 * rounding differently -- is what silently breaks unmasking. */
int64_t sh_encode_weight_fixed(uint16_t wd_half, int8_t wq);

/* Balanced representative of Z_M in (-M/2, M/2]. */
int64_t sh_balanced(int64_t a);

/* Balanced residue of a mod q, int8-safe (|r| <= q/2 <= 125). */
int8_t sh_residue(int64_t a, int q);

/* Garner reconstruction from the three balanced residues. */
int64_t sh_crt(int32_t r0, int32_t r1, int32_t r2);

/* Pick the largest f_w whose encoding still fits the int8 lane, and produce the
 * SCALED fp16 block scales the encoder expects.
 *
 * The subtlety worth stating once: sh_encode_weight_fixed multiplies by 256, so
 * it is only THE encoding when handed scales that already carry the per-tensor
 * exponent -- wd_scaled = fp16(wd * 2^(f_w - FRAC)), which makes the product
 * floor(wd * 2^f_w * q + 0.5). Handing it raw GGUF scales silently encodes every
 * tensor at f_w = 8, which is not what the reference does and not what the worker
 * will assume. Returns f_w, or negative if no exponent fits.
 *
 * Scaling into fp16 SUBNORMALS is fine and must not be rejected: it happens where
 * weights are so small that w * 2^f_w rounds to zero anyway, so the bits lost were
 * already below the fixed-point quantum, and both sides read the same array
 * through the same routine either way. An earlier Python version rejected them and
 * refused every real tensor in the model.
 *
 * THE EXPONENT IS PER OUTPUT COLUMN, not per tensor, and that is a correctness
 * decision rather than a tuning one. One exponent for a whole tensor has to be
 * sized for its single largest weight, and a tensor with one big weight then
 * quantises every small one to nothing: measured on Qwen2.5-0.5B, a per-tensor
 * exponent rounds 13.5% of all nonzero weights to ZERO, and 39-41% on
 * blk.0.attn_q / blk.0.attn_k. Per column it is 0.7%. Each output column is its
 * own accumulation -- y[j] sums only over k -- so it can carry its own exponent
 * without the sum ever mixing two of them, and |w_fixed| <= 119 still holds per
 * element, which is what keeps the residue identity and the fused kernel intact.
 * The WORKER never learns about this: it multiplies the same wd_scaled/wq arrays
 * it always did, and only the TEE's final descale is per column.
 *
 * f_w_out receives N exponents, one per output column. */
int sh_prepare_weight(const uint16_t *wd_raw, const int8_t *wq,
                      int64_t K, int64_t N, uint16_t *wd_scaled_out, int *f_w_out);

/* The same choice of exponent and the same encoding, straight from ggml's own
 * q8_0 layout: `blocks` is N rows of K/32 blocks, each { fp16 d; int8 qs[32] },
 * i.e. one row per OUTPUT, which is also the layout the worker wants (a decode
 * GEMV is N contiguous dot products). No transpose on either side.
 * w_fixed_out is (N,K) int8; f_w_out is one exponent per row. Returns 0, or
 * negative if some row fits no exponent. */
int sh_prepare_weight_rows(const void *blocks, int64_t K, int64_t N,
                           int8_t *w_fixed_out, int *f_w_out);

/* fp32 -> fp16 bits, round-to-nearest, subnormals handled. */
uint16_t sh_float_to_half(float v);

/* Correctness gate, not a tuning hint: a fixed-point weight above the byte limit
 * wraps silently in the int8 cast, so the fast path must refuse the tensor. */
bool sh_weights_fit_byte(const int64_t *w_fixed, int64_t n);

#ifdef __cplusplus
}
#endif
#endif
