# Deleted Base state: recovery assessment (CORRECTED 2026-10-26 after root's 15:54 note; read-only; no tests, no mutations)

**Corrections to my first version:**
1. **"reth always deletes the `.part` on SIGTERM" is wrong as observed.**
   - **What happened:** root's memory guard stopped 1394 at 15:53:59 (host MemAvailable 15,404 MiB < the 16 GiB floor), and **`state.tar.zst.part` still exists**.
   - **What still holds (source):** reth's **next start** recreates and truncates it (`fetch.rs:580-581`, `create_file` + `set_len`), so it must not be restarted against this file.
2. **I withdraw the "ext4 journal has been cycled" statement.** I have no journal metadata evidence. Recovery practicality below is **inference**; nothing here proves the deleted data impossible to recover.
3. **I withdraw the "allocated extents + re-fetch the last 4 KiB" salvage idea as an integrity method.**
   - **Why:** block allocation does not prove that every byte in a piece was written correctly.
   - **What a piece needs instead:** full byte validation against a trusted source (re-fetching it, which costs the same bandwidth), or the final whole-output BLAKE3 after extraction.
   - **There is no cheap shortcut.**

## Current state (V = verified, by me at 15:53–15:54 or by root's note; I = inference)
- **The unit (V, root):** `enclave-base-retention.service` is inactive/dead, PID 0, `Result=success` from the controlled stop. **The retention is NOT complete.** Controller 1394 is terminal.
- **The datadir (V):**
  - `db/` is empty, emptied at 15:15:39 by reth's pending-archive `cleanup_outputs()` (`archive.rs:151-152`);
  - `static_files/` is 136.1 GB;
  - no compressed copy of the old state archive in any downloader path, nor in `tmp/` or `retention-backup/` (root);
  - no deleted-file descriptor (root);
  - no Base copy in the host recovery copies, and no qcow2 snapshot or backing file (root).
- **The partial download (V):** `data/.download-cache/state.tar.zst.part` is 761,228,785,915 B apparent and sparse, with 8,403,288 × 512 B ≈ **4.3 GB allocated** in 318 extents. It was written as concurrent 64 MiB pieces with no completion record.
  - **Its length proves nothing, and it is not a trustworthy prefix.**
  - The history `.part` files from this run are also present.

## Options (all inference unless marked)
- **ext4 undelete of `db/mdbx.dat` (1.14 TB):**
  - It would need writes stopped and raw-device forensics (out of scope).
  - Its only acceptance is reth's exact-size **BLAKE3 of the whole file**, which any missing or overwritten block fails.
  - **Practicality unknown and unlikely (I), not proven impossible.**
- **Rebuilding from the surviving static files:** **not viable (I).** Transactions and receipts cover only the recent range; changesets only unwind an existing later state. A genesis sync of Base is days to weeks.
- **Salvaging the 4.3 GB partial:** **small and unproven.**
  - Each piece would need full byte validation (Range re-fetch and compare) or final-output BLAKE3. A BLAKE3 failure cannot say which piece was wrong, so the fallback is a full re-fetch.
  - **Expected saving ≤ 4.3 GB. Keep it as evidence, not as progress.**

## Recommendation (short)
1. **Preserve the current state:**
   - do **not** start reth or the retention unit (it would truncate `state.tar.zst.part` and re-plan);
   - do not delete or move any `.part`;
   - keep the holder disabled.
2. **The fastest safe path is a re-fetch of the 761 GB state archive** through 6d's **durable, chunk-validated Range fetch** (under review, `logs/claude-resumable-state-review.md`). Every interruption then costs at most one bounded chunk.
   - Then staged extraction, an **independent pinned BLAKE3 check of the state outputs before any reth run**, then the unchanged unit run.
   - At about 18–19 MB/s (I), that is **≥ about 11 h of transfer**, plus unmeasured extraction and verification.
3. **Admission:** start only when root's host-memory admission allows it (host MemAvailable was at the floor at 15:54; KVM apps are recovering). Root owns every stop, start and download.
