# Original-image recovery evidence, 2026-10-26 21:44 UTC

Actual original QCOW2 allocation scan PASS: all 9001 candidate extents, 1134426345472 bytes, are allocated in the image. No hole/zero flags, image unchanged, cleanup complete. This is allocation evidence, not content integrity.

Actual postdelete r5 journal scan returned REUSE_OBSERVED, not a pass. Precisely two reused blocks are extent-tree metadata (499155437 and 499155449), not database data. Both have authenticated journal replacement patches in the diagnostic plan. The attached independently computed classification preserves the original verdict and limitations. No cross-commit database-data reuse was observed. Invisible within-transaction reuse and raw writes remain outside this evidence.

Overlay r9 actual 20+15 tests PASS, including live-validator cancellation, escaped-child cleanup and original uid/gid/mode traversal. Root reviewed the focused runtime correction. A bounded 1800-second, read-only original-database diagnostic probe has started with a 4096 MiB guard and 16 GiB host floor. A running probe is NOT a successful validation; its result is not included here yet.

Original USB image remains read-only. USB writes, downloads and production VM boot remain paused. No RPC cutover, recovery acceptance or decentralization completion. Source, test and small metadata evidence only; database/journal bytes and binaries excluded.
