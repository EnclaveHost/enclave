# Recovery qualification at 2026-10-26 21:15 UTC

No production RPC cutover or original database exposure. USB writes, downloads and production RPC VM boot remain paused.

- MDBX wrapper r4: actual 20 tests PASS, no ResourceWarning, correct read-only behavior, corrupted input rejection, bounded output, timeout and cancellation cleanup. Official checker binary is reused by exact SHA256. Runtime is byte-identical to r3; r4 fixes only the fixture process-exit ESRCH race. Initial fixture sync RESULT_TRUE handling was corrected without weakening generic error checks.
- Post-deletion bitmap checker r2: actual 13 tests PASS. Runtime unchanged from r1; fixture unrelated blocks moved away from target blocks and a disjointness invariant was added. The real journal-history scan is still pending independent review; no no-reuse finding yet.
- Offline recovery plan r1: verified 30 patches / 119,040 bytes / 9,001 extents from copied metadata. No overlay applied to the original. Plan is diagnostic metadata only; no file-data integrity claim.
- Overlay r4: NOT qualified. Twenty tests ran, six failed because the Unix socket path exceeds 108 bytes; no leftover mounts/processes, parents and peers unchanged. A prior attempt was stopped by the host memory guard during Eyesoff restart; that stop is not a test pass. Corrective r5 is pending.
- Actual pinned Base binary exposes maintenance under base reth db, including repair-trie --dry-run. Upstream dry-run logs inconsistencies but can exit 0; full state-root/plain-hashed checks and independent canonical-chain anchoring are still required. Source findings list gaps explicitly.

The small historical inode metadata test vector is included for checksum reproducibility. The full copied journal, database pages, patch-source bytes, binaries and recovered file data are excluded.

Temporary freed RAM/storage during Eyesoff configuration relaunch belongs to that existing app and is not RPC capacity. Existing apps and administrator controls remain preserved.
