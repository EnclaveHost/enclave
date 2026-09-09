# Optional ARM request kernels

The `engine-pvm` build includes a second ARM SIMD table. Set
`SHIELDED_ARM_TUNED=1` before first SIMD admission to select it. The phone
payload accepts the setting in `SHENV`. All other values retain `neon-sdot`.
Other build targets keep the original table unless they explicitly compile
`shielded-simd.c` with both `SH_SIMD_NEON` and `SH_SIMD_NEON_TUNED`, link that
object beside the original NEON object, and compile `shielded-tee.c` with
`SH_HAVE_NEON_TUNED`.

Selection still requires the ARM dot-product hardware capability and the
existing exact comparison against the generic kernels. A disagreement selects
generic code; `SHIELDED_NO_SIMD=1` also selects generic code. The selected table
is cached at first admission, so changing the environment afterward cannot
switch a running link.

The candidate changes four request-side operations:

- Checked encoding uses four lanes, retaining current FPCR rounding in libm
  builds and nearest-even rounding in `SH_NO_LIBM` builds. Inputs outside the
  vector conversion bounds take the original checked scalar path.
- Masking reduces directly modulo each of the three field primes. Their
  product is M, so the preceding reduction modulo M is redundant. The caller's
  `|x| < 2^26` and `0 <= r < M` bounds keep the sum inside the corrected
  single-precision reducer's domain.
- Two-repetition Freivalds dot products use exact 32-bit by 32-bit products
  accumulated in 64-bit lanes. Operands that do not narrow exactly take the
  original scalar path. The existing chunk sizes and final modulus stay fixed.
- Packed reply recovery reads exactly 24 bytes per eight values, sign-extends
  each 24-bit value, and combines recovery with the two verification sums.
  Scalar tails handle every incomplete group without reading caller padding.

No field, pad format, calibration, verification count, or acceptance bound is
changed. Existing refill kernels, including the vector CRT experiment, remain
present. The original ARM function bodies were compared byte-for-byte against
the default build after these guards were added.

Validation before phone measurement included independent integer oracles,
guarded input/output tails, four rounding modes, exhaustive packed decoding,
the reachable mask-sum interval, startup admission, and injected disagreement
falling back to generic. `test/shielded-simd-bounds.test.mjs` runs both tables on
ARM and the existing tables on x86, with ASan/UBSan. NDK/qemu checks cover the
Android build separately. These establish numerical and dispatch behavior;
only paired runs on the phone establish a throughput benefit.
