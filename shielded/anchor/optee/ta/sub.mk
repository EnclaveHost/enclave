# The TA's sources. anchor-core.c and shielded-simd.c are symlinks to the
# canonical files (core/ and wasm/ggml-shielded/): the TA must run THE SAME
# arithmetic the CVM stack runs, so there is exactly one copy of it.
global-incdirs-y += include

srcs-y += anchor_ta.c
srcs-y += anchor-core.c
srcs-y += shielded-simd.c

# the generic SIMD build only: no AVX-512 in S-EL0, and the TA measures what
# the phone will actually run until the NEON/i8mm port lands
cflags-shielded-simd.c-y += -O3
