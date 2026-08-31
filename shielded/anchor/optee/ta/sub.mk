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
# -march matters as much here as it did in the harness: OP-TEE's arm.mk sets no
# -march for arm64, so without this the TA is built for baseline ARMv8-A and the
# auto-vectoriser sits idle. Measured on the S21+: 1.57x from the flag alone,
# 6.00x with the hand SDOT kernel. Safe because OP-TEE core is built
# -mgeneral-regs-only but TAs (S-EL0) may use NEON, which is where our kernels are.
cflags-shielded-simd.c-y += -O3 -march=armv8.2-a+dotprod -DSH_NO_LIBM

# same guard: the TA links only the INTEGER half of the field code (sh_balanced,
# sh_crt, sh_residue). The float weight-encoder is offline/host-side by design.
cflags-shielded-field.c-y += -DSH_NO_LIBM -march=armv8.2-a+dotprod
cflags-anchor-core.c-y += -march=armv8.2-a+dotprod
