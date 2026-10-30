# Recovery evidence, 2026-10-26 20:42 UTC

The database has NOT been restored or validated, and no production RPC cutover occurred.

- JBD2: 14,488 transactions pass checksum/contiguous-commit verification. All 29 selected inode/index/leaf records match proven logged content. This establishes historical content, not current database integrity.
- ext4: inode and 28 tree blocks pass inode/generation-bound checksums and structural checks. All 9,001 extents account exactly for allocated bytes; the remaining file tail is sparse capacity.
- Current bitmap: none of the 276,959,557 mapped data blocks is allocated now. A second per-block pass agrees with the range search. This does not exclude temporary reuse followed by freeing; that investigation is pending.
- Samples: first four pages plus two distant pages contain nonzero data. Only sample hashes/metadata are archived, not page contents. Samples do not validate the database.

Required remaining gates: post-deletion reuse/history coverage, disposable read-only recovery view, strict MDBX validation and independent chain-state verification. Original image and downloaded checkpoints remain retained. USB writes and production VM startup remain paused.

Final fixture qualification: overlap r5 10 tests PASS, JBD2 verifier r3 9 tests PASS, ext4 checker r2 7 tests PASS. Earlier compile/fixture/wrapper failures are retained in the run evidence; final runtime checksum verifiers were unchanged by wrapper fixes. No skipped tests are counted as passes.
