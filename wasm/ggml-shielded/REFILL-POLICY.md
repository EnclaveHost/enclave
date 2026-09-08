# CPU refill policy

`SHIELDED_REFILL_VECTOR_CRT=1` opts the AVX-512 VNNI implementation into an
alternative CRT epilogue for pad refills larger than four rows. The default is
off; unset, empty, `0`, and any value other than the exact string `1` keep the
existing path. Set the variable before the first SIMD admission in the process.
The selected table remains fixed afterward. `SHIELDED_NO_SIMD` still takes
precedence, and the existing CPU-feature and arithmetic-agreement checks still
control admission. The selected table name is `avx512-vnni-vector-crt`.

The candidate completes the horizontal reductions for all three residue planes
before reconstructing independent output columns. This exposes the unchanged
CRT arithmetic to compiler vectorization. It uses 192 bytes of automatic scratch
per output row/tile. Duplicate tail columns are valid computations but are never
stored. Small batches use the existing specialized kernels; allocation failure
uses the same allocation-free four-row fallback and caller-provided `12*N`
accumulator. The 2048-byte weight slab and field representation are unchanged.
ARM/NEON and generic builds retain their existing refill implementations.

This is a CPU implementation choice, not a change to the trusted execution
boundary, pad format, keys, indices, consumption rules, or worker protocol. It
does not authorize generating secret pads on an untrusted machine.

Validation covers both entry points against an independent int64 field oracle:
6,120 row/column-tail and extreme-input cases per entry, plus 320 normal/forced
allocation-failure pairs per entry. The latter cover slab boundaries, output
stride canaries and extreme residues with K up to 65,536. Tests exercise both the
optimized O3 code and the sanitizer build. Startup probes check default, empty,
zero, one, invalid values, generic override and immutable selection after first
admission. Full-model comparisons additionally authenticate and compare every
pad value between the two implementations; that equality is separate from the
independent kernel-level scalar oracle.

Run the focused checks with:

```sh
node --test test/shielded-refill.test.mjs test/shielded-refill-oom.test.mjs test/shielded-simd-bounds.test.mjs
SHIELDED_TEST_SANITIZE=1 node --test test/shielded-refill-oom.test.mjs
```

## Measured complete-dealer result

On an EPYC 9115 with 16 mint threads, the actual Qwen3.8 27B Q8 model
(262 groups / 409 members) produced a 64-row, 809,039,872-byte v2 shipment in
median 3.052280 seconds with the default versus 2.2107065 seconds with the
opt-in: 27.6% less wall time, or 20.97 versus 28.95 full-model pad rows/s.
Median process CPU time was 44.3352585 versus 31.807363 seconds (28.3% less).
These are pad-production rates, not inference token rates or phone performance.

The final-entry benchmark used one checked warm pair followed by six matched
pairs, three per order. The opt-in won all six. Each pair authenticated and
compared every one of its 269,582,336 field values. Model registration
(18.592 seconds), hashing, warm-up and verification were excluded from minting
times. The host was not affinity-isolated; the measurements cover one balanced
block and do not guarantee the same speedup on another machine.

Final scratch library SHA-256:
`f83459d58636fb9d5338a68ab1b01bf5f6784e1d24f6e60520d957633411d53c`.
Benchmark SHA-256:
`78af89be1999c9179ad7b239bd3db65c2c4dd35bd9cef7e21b1e79edded175ad`.
These artifacts include isolated benchmark hooks; they are not deployed
binaries. No live worker or phone setting was changed for this comparison.
