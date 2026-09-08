# Exact tiled online pad checks

`SHIELDED_PAD_CHECK_TILED=1` enables bounded int64 dot products when admitting
an encrypted pad cell. It preserves the existing `(u . s) == (r . W^T s) mod M`
check. The option is off by default; other values use the existing int128 path.
It is separate from `SHIELDED_PAD_PREPARE_TILED`, which prepares check vectors
at registration rather than checking incoming cells.

The online helper requires both operands to lie in `[-(M-1), M-1]`:
`r` is derived in `[0,M)`, `u` is authenticated and decoded into balanced field
values, `W^T s` is reduced modulo M at registration, and the secret `s` is below
2^20. It is not a generic dot product for arbitrary int32 values.

For chunks of 32768 values, every partial sum has magnitude at most
`32768*(M-1)^2 < 2^63`, since M is less than 2^24. Each chunk is reduced modulo M
before accumulating the next, so total dimensions do not increase the bound.
Chunk sizes and memory access order depend only on public dimensions. No check,
mask, signature or ciphertext authentication is removed.

Tests compare the result against the int128 reference at positive and negative
field extremes, random field operands, empty inputs, chunk boundaries and long
vectors. The actual encrypted shipment importer runs with both paths, covering
reordered/subset/shared groups, a wrong seed and corrupted ciphertext.
`shielded-pad-check.c --bench-online` provides an optional isolated host kernel
measurement; phone throughput still requires paired device runs.
