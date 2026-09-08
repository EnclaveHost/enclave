# Exact tiled pad-check preparation

`SHIELDED_PAD_PREPARE_TILED=1` opts into a contiguous tiled calculation of
the pad-verification vector during registration. The default keeps the
existing column-strided reference. `SHIELDED_PAD_CHECK` must still be enabled
to create the check; this option does not enable or disable verification.

Both paths compute `W^T s mod M` with the same fresh random check vector.
The tiled path reads 128 adjacent weight bytes per row and reduces after at
most 32768 rows. Even full int8 weights and full int32 coefficients keep each
partial sum within 2^53, so int64 arithmetic is exact without depending on
the total matrix height. A tile uses 1 KiB of accumulator storage. No masks,
entropy, online checking, network messages, or pad files change.

Validation: `node --test test/shielded-pad-check.test.mjs` compares against
an independent int128 oracle under ASan/UBSan, including partial tiles,
row-reduction boundaries, integer extremes, and the real registration selector.
The fixture also accepts `--bench` when compiled without sanitizers. An x86
host run at K=5120, N=17408 measured 198.6–199.3 ms reference versus
39.4–41.0 ms tiled across three alternating-order trials. This is a synthetic
single-operation result, not a phone startup or generation throughput result.

Before enabling on the phone, allow the option through its trusted engine
configuration and measure the same-model startup with and without it. Keep
the APK and remaining configuration fixed for that comparison.
