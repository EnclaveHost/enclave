#pragma once
/*
 * The SOURCE quantization, and why it is not the tier's format.
 *
 * What the card holds is the field encoding: one int8 per weight plus one
 * exponent per row (sh_prepare_weight_rows). q8_0 is merely the layout that
 * encoder reads, because it is what the first models arrived in. It is not a
 * property of the protocol, the pads, the Freivalds vectors or the kernels --
 * none of which can tell how the bytes were quantized on disk.
 *
 * So any quantization ggml can dequantize is serveable: convert each row to
 * q8_0 on the way into the encoder and everything downstream is unchanged. A
 * k-quant mix needs no special case either -- a UD-style GGUF carries one type
 * per TENSOR and several per model, and each weight converts from whatever it
 * happens to be.
 *
 * Only QUANTIZED sources convert. f16/f32 weights keep their exact CPU path:
 * they are norms and biases, they sit under the MAC floor anyway, and pushing
 * them through an 8-bit lane would spend precision the card cannot give back.
 *
 * The accuracy this costs is the second quantization step (say q4_K -> f32 ->
 * q8_0), and it is small by construction: q8_0 spends 8 bits per weight over a
 * scale chosen per 32 weights, against the 4-6 bits over a 16- or 32-wide scale
 * inside a 256 super-block that the source already spent. The encoder's own
 * fixed-point step follows either way.
 *
 * Both the backend and the calibrator include this: they must agree on what is
 * claimable and encode identically, or a calibration would describe sites the
 * runtime does not offload (or worse, the reverse).
 */
#include "ggml.h"
#include "ggml-backend.h"

extern "C" {
#include "shielded-field.h"
}

#include <cstdint>
#include <cstring>
#include <new>
#include <stdexcept>
#include <vector>

/* q8_0, as ggml stores it: one fp16 scale then 32 quants, per block, per row. */
struct sh_block_q8_0 { uint16_t d; int8_t qs[32]; };
static_assert(sizeof(sh_block_q8_0) == 34, "unexpected q8_0 block layout");

/* REPACKED ROWS ARE NOT THIS TENSOR'S ROWS. The CPU backend's extra buffer
 * types rewrite a weight into interleaved blocks at load time (ARM: q8_0 ->
 * q8_0_4x8 with dotprod/i8mm; x86/AVX2: q4_K -> q4_K_8x8, iq4_nl, q2_K and
 * friends) while keeping the tensor's TYPE tag. Reading them as the type says
 * would encode a weight nobody computes with -- and that is not a loud failure:
 * the card is verified against OUR encoding, so wrong-but-consistent products
 * would pass Freivalds and the model would just be quietly wrong. So the tier
 * declines such a tensor everywhere it could touch it.
 *
 * Two ways out, both at model load: llama's `use_extra_bufts = false` (what
 * shielded-calib does), or a ggml-cpu built with GGML_CPU_REPACK=OFF. */
static inline bool sh_is_repacked(const ggml_tensor *t) {
    if (!t || !t->buffer) return false;
    const char *bn = ggml_backend_buft_name(ggml_backend_buffer_get_type(t->buffer));
    return bn && strstr(bn, "REPACK");
}

static inline bool sh_source_type_ok(ggml_type t) {
    if (t == GGML_TYPE_Q8_0) return true;
    if (!ggml_is_quantized(t)) return false;
    const ggml_type_traits *tr = ggml_get_type_traits(t);
    return tr && tr->to_float && ggml_blck_size(t) > 0;
}

/* A row must divide into whole blocks of BOTH the source type (k-quants are 256
 * wide, q8_0 is 32) and the encoder's. Everything real satisfies this; a tensor
 * that does not stays on the CPU rather than being converted in pieces. */
static inline bool sh_source_geometry_ok(ggml_type t, int64_t K) {
    const int64_t blk = ggml_blck_size(t);
    return blk > 0 && K % blk == 0 && K % SH_QK == 0;
}

/* One row, any supported quantization -> the q8_0 blocks the encoder reads.
 * `f32` and `q8` are caller-owned scratch (one row each), so a whole tensor is
 * never staged in q8_0 form: the peak cost of serving a k-quant model is one row
 * per encoding thread, not a second copy of the weights. */
static inline bool sh_row_to_q8_0(ggml_type type, const void *row, int64_t K, float *f32, void *q8) {
    const ggml_type_traits *tr = ggml_get_type_traits(type);
    if (!tr || !tr->to_float) return false;
    tr->to_float(row, f32, K);
    const size_t want = (size_t)(K / SH_QK) * sizeof(sh_block_q8_0);
    return ggml_quantize_chunk(GGML_TYPE_Q8_0, f32, q8, 0, 1, K, nullptr) == want;
}

/* Encode rows [j0, j1) of a weight of ANY supported quantization, exactly as
 * sh_prepare_weight_rows_range does for q8_0 -- which is what it delegates to
 * when the source already is q8_0, so that path stays byte-for-byte what it
 * was. The encoder is per-row (its exponent search reads one row and writes one
 * exponent), which is what lets the conversion stay one row deep. */
static inline int sh_prepare_rows_any(const void *src, ggml_type type, int64_t K, int64_t N,
                                      int64_t j0, int64_t j1, int8_t *w_out, int *f_out) {
    if (type == GGML_TYPE_Q8_0) return sh_prepare_weight_rows_range(src, K, N, j0, j1, w_out, f_out);
    if (!sh_source_type_ok(type) || !sh_source_geometry_ok(type, K)) return -1;
    const size_t row_bytes = (size_t)ggml_row_size(type, K);
    std::vector<float> f32;
    std::vector<uint8_t> q8;
    try {
        f32.resize((size_t)K);
        q8.resize((size_t)(K / SH_QK) * sizeof(sh_block_q8_0));
    } catch (const std::bad_alloc &) { return -1; }
    catch (const std::length_error &) { return -1; }
    const uint8_t *base = (const uint8_t *)src;
    for (int64_t j = j0; j < j1 && j < N; j++) {
        if (!sh_row_to_q8_0(type, base + (size_t)j * row_bytes, K, f32.data(), q8.data())) return -1;
        /* one row in, that row's slot out: N=1 over the scratch, outputs offset by j */
        const int rc = sh_prepare_weight_rows_range(q8.data(), K, 1, 0, 1, w_out + (size_t)j * K, f_out + j);
        if (rc < 0) return rc;
    }
    return 0;
}
