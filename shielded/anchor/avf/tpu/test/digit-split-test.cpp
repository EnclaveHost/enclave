// digit-split-test.cpp -- the digit decomposition, checked over every input it can ever see, under UBSan.
//
// Why this exists: `q = 256*hi + lo` was written THREE times in payload/ggml-tpu.cpp with three different
// expressions -- the send path, the minter's pad split, and the audit's exact recompute -- and two of them
// shifted negative values. A left shift of a negative is undefined in C++17 (defined only from C++20) and
// build.sh compiles that file as C++17; a right shift of a negative is implementation-defined. Found by
// review with an isolated UBSan harness: `w=1, q=-256, high=false` trips "left shift of negative value -1".
//
// The three sites must agree BIT-EXACTLY or the pad the VM subtracts and the digits the TPU multiplies
// describe different numbers, which would corrupt every product silently. So there is now one helper, and
// this checks it exhaustively rather than on samples.
//
//   clang++ -std=c++17 -O2 -fsanitize=undefined -fno-sanitize-recover=all \
//           tpu/test/digit-split-test.cpp -o /tmp/digit-split-test && /tmp/digit-split-test
//
// Exit 0 = every property holds over the full int16 range and the modular range the lanes use.
#include <cstdint>
#include <cstdio>
#include <cstdlib>

// --- the production helper, copied verbatim from payload/ggml-tpu.cpp ---
static inline int32_t digit_lo(int32_t v) { const int32_t m = (int32_t)((uint32_t)v & 0xFFu); return m >= 128 ? m - 256 : m; }
static inline int32_t digit_hi(int32_t v) { return (v - digit_lo(v)) / 256; }

// --- the three expressions it replaced, for an equivalence check on THIS compiler.
// These are the originals and they are the reason for the test; the shifting ones are guarded so the
// sanitizer does not abort before the comparison is made.
static int32_t old_send_hi(int32_t v) { return (v + 128) >> 8; }                       // implementation-defined for v+128 < 0
static int32_t old_send_lo(int32_t v) { const int32_t h = (v + 128) >> 8; return v - h * 256; }  // was h << 8: UB when h < 0
static int32_t old_mint_lo(int32_t v) { return (int8_t)(uint8_t)(v & 0xFF); }
static int32_t old_mint_hi(int32_t v) { return (v - old_mint_lo(v)) / 256; }            // was >> 8

int main() {
    long checked = 0, bad = 0;
    auto fail = [&](const char *what, int32_t v, long a, long b) {
        if (bad++ < 12) fprintf(stderr, "FAIL %s at v=%d: %ld vs %ld\n", what, v, a, b);
    };
    // Every value an int16 masked row can hold, both signs, including both rails and zero.
    for (int32_t v = -32768; v <= 32767; v++) {
        const int32_t lo = digit_lo(v), hi = digit_hi(v);
        checked++;
        if (256 * hi + lo != v)                       fail("reconstruction", v, 256L * hi + lo, v);
        if (lo < -128 || lo > 127)                    fail("lo out of int8", v, lo, 0);
        // hi only has to fit int8 over the modular range the lanes actually use (|q| <= 16384 + 128);
        // outside it the wire could not carry the digit anyway, which is itself worth asserting.
        if (v >= -16512 && v <= 16511 && (hi < -128 || hi > 127)) fail("hi out of int8 in range", v, hi, 0);
        if (lo != old_mint_lo(v) || hi != old_mint_hi(v))         fail("minter disagrees", v, lo, old_mint_lo(v));
        if (lo != old_send_lo(v) || hi != old_send_hi(v))         fail("send path disagrees", v, hi, old_send_hi(v));
    }
    // The boundaries that actually bit: multiples of 256, either side of them, and the int8 seams.
    const int32_t seams[] = { -32768, -16512, -16384, -257, -256, -255, -129, -128, -127, -1, 0,
                              1, 127, 128, 129, 255, 256, 257, 16383, 16511, 32767 };
    for (int32_t v : seams) {
        const int32_t lo = digit_lo(v), hi = digit_hi(v);
        if (256 * hi + lo != v) fail("seam reconstruction", v, 256L * hi + lo, v);
        if (lo < -128 || lo > 127) fail("seam lo", v, lo, 0);
    }
    printf("digit-split: %ld values checked, %ld failures\n", checked, bad);
    return bad ? 1 : 0;
}
