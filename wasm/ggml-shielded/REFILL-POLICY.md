# CPU refill policy

`SHIELDED_REFILL_VECTOR_CRT=1` opts the AVX-512 VNNI implementation into
a wider matrix kernel and vector CRT epilogue for pad refills larger than four rows. The default is
off; unset, empty, `0`, and any value other than the exact string `1` keep the
existing path. Set the variable before the first SIMD admission in the process.
The selected table remains fixed afterward. `SHIELDED_NO_SIMD` still takes
precedence, and the existing CPU-feature and arithmetic-agreement checks still
control admission. The selected table name is `avx512-vnni-vector-crt`.

The selected kernel uses four mask rows and six output columns per inner tile:
24 independent accumulators reuse each loaded mask vector across six columns.
Two inner tiles form a 12-column output tile. The 2048-byte slab holds 24 KiB
of weights plus 8 KiB of mask rows; saved accumulators are 25% smaller than
the original 16-column layout. No permanent packed-weight copy is allocated.

It completes the horizontal reductions for all three residue planes
before reconstructing independent output columns. This exposes the unchanged
CRT arithmetic to compiler vectorization. It uses 144 bytes of automatic scratch
per output row/tile. Duplicate tail columns are valid computations but are never
stored. Small batches use the existing specialized kernels; allocation failure
uses the same allocation-free four-row fallback and caller-provided `12*N`
accumulator. The 2048-byte weight slab and field representation are unchanged.
ARM/NEON and generic builds retain their existing refill implementations.

This is a CPU implementation choice, not a change to the trusted execution
boundary, pad format, keys, indices, consumption rules, or worker protocol. It
does not authorize generating secret pads on an untrusted machine.

Validation covers both entry points against an independent int64 field oracle:
11,628 row/column-tail and extreme-input cases per entry, plus 720 normal/forced
allocation-failure pairs per entry. The latter cover slab boundaries, output
stride canaries and extreme residues with K up to 65,536. Tests exercise both the
optimized O3 code and the sanitizer build. Startup probes check default, empty,
zero, one, invalid values, generic override and immutable selection after first
admission.
The wider kernel's inference comparison verifies attestation and compares output
tokens; its arithmetic equality is checked by the independent kernel-level oracle.

Run the focused checks with:

```sh
node --test test/shielded-refill.test.mjs test/shielded-refill-oom.test.mjs test/shielded-simd-bounds.test.mjs
SHIELDED_TEST_SANITIZE=1 node --test test/shielded-refill-oom.test.mjs
```

## Vector mask sampler

`SHIELDED_MASK_CHACHA16=1` opts the local mask bank into a sixteen-block
AVX-512 implementation of its existing ChaCha20 stream. It uses all twenty
rounds, the same 256-bit key from OS entropy, the same 64-bit counter, and the
same 64-bit-draw reduction into the field. The mask bytes are identical for
identical keys and issuance indices. This is not reduced-strength randomness
or reuse of a pad. ARM builds are unchanged.

Selection happens at bank creation, requires successful AVX-512 admission and
an additional scalar/vector stream agreement check, and respects
`SHIELDED_NO_SIMD`. Unset, empty, zero and invalid values keep the scalar
sampler. A failed stream self-test refuses the bank. Issuance still reserves
one unique counter window under the existing mutex before generating anything.
Requests exceeding its 2^24-block window are rejected before reservation.

Focused checks cover a public ChaCha20 known-answer vector, all lengths 0–513,
large model-sized batches, 32-bit counter carries, the final issuance window,
output canaries, concurrent issuance, exhaustion, disabled/invalid settings,
and the generic override:

```sh
node --test test/shielded-mask-stream.test.mjs
SHIELDED_TEST_SANITIZE=1 node --test test/shielded-mask-stream.test.mjs
```

Sampler microbenchmarks measure only random-mask generation. They must not be
reported as inference throughput or as the speedup of the complete refill,
which also computes each pad's matrix product inside the trusted boundary.
