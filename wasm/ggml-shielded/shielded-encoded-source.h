#pragma once
/* Catalog-authenticated ENCODED public weights (the registration hit path, encoded-artifact-hit-path-design.md).
 * The engine answers ggml_shielded_encoded_source ONLY from the APK-authenticated catalog: a descriptor of the artifact
 * file, the catalog's per-1 MiB-block SHA-256 digests over that tensor's encoded rows (K*N int8, row-major = e.w's
 * layout) and the catalog's per-row exponents as EXPLICIT little-endian int32. This header holds the pure pieces so a
 * host fixture can test them: LE decoding with the range the descale needs, and the entry sanity checks. */
#include <cstdint>
#include <new>
#include <stdexcept>
#include <vector>

/* -(af + f_w) must be a finite power-of-two exponent for ldexpf ([-149, 127]); the encoder never picks |f_w| > 64. */
static inline bool sh_encoded_f_w_ok(int64_t v, int64_t af) {   /* v is the DECODED value (int64: no narrowing before the check) */
    if (v < -64 || v > 64) return false;
    if (af < -1000000 || af > 1000000) return false;                /* af is a small calibration exponent; anything else is a corrupted site */
    const int64_t exponent = -(af + v);
    return exponent >= -149 && exponent <= 127;
}
/* rows x 4 bytes, little-endian two's complement, decoded WITHOUT native reinterpretation; false on any out-of-range row. */
static inline bool sh_encoded_decode_f_w_le32(const uint8_t *le, size_t rows, int64_t af, std::vector<int> &out) {
    if (!le) return false;
    out.clear();
    try { out.reserve(rows); } catch (const std::bad_alloc &) { return false; } catch (const std::length_error &) { return false; }
    for (size_t j = 0; j < rows; j++) {
        const uint32_t u = (uint32_t)le[4 * j] | ((uint32_t)le[4 * j + 1] << 8) | ((uint32_t)le[4 * j + 2] << 16) | ((uint32_t)le[4 * j + 3] << 24);
        const int64_t v = u <= (uint32_t)INT32_MAX ? (int64_t)u : (int64_t)u - INT64_C(4294967296);   /* two's-complement mapping in int64: no overflow for any bit pattern */
        if (!sh_encoded_f_w_ok(v, af)) { out.clear(); return false; }
        out.push_back((int)v);   /* |v| <= 64 here */
    }
    return true;
}
/* The entry the hook fills: geometry and counts must match the tensor the backend is registering. */
static inline bool sh_encoded_entry_ok(int fd, uint64_t bytes, size_t blocks, size_t rows, int64_t K, int64_t N) {
    if (fd < 0 || K <= 0 || N <= 0) return false;
    if ((uint64_t)K > UINT64_MAX / (uint64_t)N) return false;      /* K*N must not overflow before it is compared */
    const uint64_t want = (uint64_t)K * (uint64_t)N;
    if (bytes != want || rows != (size_t)N) return false;
    const uint64_t block_bytes = UINT64_C(1) << 20;
    return blocks == (size_t)((want - 1) / block_bytes + 1);
}
