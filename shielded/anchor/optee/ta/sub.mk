# The TA's sources. anchor-core.c and shielded-simd.c are symlinks to the
# canonical files (core/ and wasm/ggml-shielded/): the TA must run THE SAME
# arithmetic the CVM stack runs, so there is exactly one copy of it.
global-incdirs-y += include

srcs-y += anchor_ta.c
srcs-y += anchor-core.c
srcs-y += shielded-simd.c
srcs-y += shielded-field.c

# the generic SIMD build only: no AVX-512 in S-EL0, and the TA measures what
# the phone will actually run until the NEON/i8mm port lands
# S-EL0 has no libm and no <math.h>; the guard in shielded-simd.c selects
# __builtin_lrintf instead. The TA never calls encode anyway -- it receives
# activations already in field form -- so this only makes the file compile.
cflags-shielded-simd.c-y += -O3 -DSH_NO_LIBM

# same guard: the TA links only the INTEGER half of the field code (sh_balanced,
# sh_crt, sh_residue). The float weight-encoder is offline/host-side by design.
cflags-shielded-field.c-y += -DSH_NO_LIBM
