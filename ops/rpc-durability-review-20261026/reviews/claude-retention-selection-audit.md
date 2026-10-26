# Retention download selection audit (root 1394, live PID 110490): read-only handoff (2026-10-26)

**Scope:**
- Read-only.
- I made no live calls, did not touch the guest, and ran no tests, builds, queue jobs, commits or source edits.

**Sources read:**
- root's `logs/root-retention-live-20261026T145821Z-1929639/{check,start}.json`, `controller.log`, `observe.txt`, `units-now.txt`;
- the installed preflight `base-retention-stage/activation-r2/cached_download_preflight.py` (the stage `SHA256SUMS` `409b8ed2…` = the one recorded in `staged.txt`);
- the pinned manifest copy `logs/base-manifest.body`: sha256 `1f0c4e6c…`, the same as `manifest-measurements.txt`, block 53048526, `reth_version 2.5.2-dev (7134be3)`;
- the pinned reth source from the local cargo checkout `~/.cargo/git/checkouts/reth-babcd6134566c621/7134be3/crates/cli/commands/src/download/`.

## 1. Cause of the count difference: a boundary off-by-one in the PREFLIGHT, not extra "latest" entries
**What reth does (source):**
- `planning.rs:197`: `Since(b)` → distance = `snapshot_block - b + 1`.
- `manifest.rs:481-489`: `tail_chunks_for_distance` uses `first_chunk = (total_blocks - min(distance, total_blocks)) / blocks_per_file`.
- **Manifest fact:** `total_blocks` = **53048526** (= the snapshot block, not block + 1) for every chunked component, with `blocks_per_file` 500000 and 107 chunks.
- **So:** for since 48,000,000 the first chunk is `(53048526 − 5048527) / 500000 = 47999999 / 500000` = **95**. For since 52,500,000 it is `52499999 / 500000` = **104**.
- In effect reth's first chunk is `(B − 1) // 500000`. When B is exactly on a 500k boundary, that is one chunk earlier.

**What the installed preflight does:** `first = since // blocks_per_file` (lines 33-35), giving 96 and 105.

**Measured against the CLI startup log** (reported by root):

| component | CLI | preflight | difference |
|---|---|---|---|
| Headers | 107 (All) | not part of the old-history selection | 0 extra (see §3) |
| Transactions | 12 (95–106) | 11 (96–106) | +1: chunk 95 |
| Receipts | 12 (95–106) | 11 (96–106) | +1: chunk 95 |
| AccountChangesets | 3 (104–106) | 2 (105–106) | +1: chunk 104 |
| StorageChangesets | 3 (104–106) | 2 (105–106) | +1: chunk 104 |

The CLI therefore selects **30** chunked archives versus the preflight's **26**. The 4 extras are the predecessor chunk below each exact boundary. None is a "latest" or extra manifest entry.

## 2. The extra archives (exact sizes from the pinned manifest)
| archive | blocks | compressed | extracted (decompressed = output files) |
|---|---|---|---|
| `transactions-47500000-47999999` | 47.5M–47,999,999 | 15,619,048,094 | 25,614,878,606 |
| `receipts-47500000-47999999` | same | 7,923,586,354 | 17,360,959,414 |
| `account_changesets-52000000-52499999` | 52.0M–52,499,999 | 1,303,603,499 | 3,747,610,781 |
| `storage_changesets-52000000-52499999` | same | 9,687,338,298 | 33,318,978,057 |
| **total** | | **34,533,576,245** | **80,042,426,858** |

**Are they already on disk?** UNKNOWN; I did not inspect the guest.
- **Expected missing:** all 4. The first download's selection was "distance 140000 → first chunk 105" (`manifest-measurements.txt`), and the preflight found 105–106 present for every component. So chunk 95 for tx/receipts and chunk 104 for the changesets were never selected before.
- **Worst case:** 18 + 4 = **22 missing archives**. The CLI's reuse check will show the real number (see §3).

**Space with the worst case**, using the preflight's own conservative formula (all compressed + all extracted + reserves):
- need = 1,043,161,148,110 + 34,533,576,245 + 80,042,426,858 = **1,157,737,151,213** bytes;
- free (preflight) 2,696,017,272,832 → **headroom 1,538,280,121,619** bytes, down from 1,652,856,124,722;
- the 161.0 GB index reserve and the 250.5 GB 30-day growth reserve are **untouched**.
- **The free-space guard still covers the extras, by about 1.54 TB.**
- The index estimate is still labelled "ESTIMATE (not measured)". Peak use is lower than this sum, because reth deletes each archive after extraction (`archive.rs:255-276`, per the earlier source review).

## 3. Re-extraction vs reuse
- `planning.rs:127-157` `partition_reusable`: before any work, every planned archive's declared output files are verified on disk (`OutputVerifier`). Archives that match are "reused"; only the rest become pending.
- The CLI's "queue" counts are `total_archives()`, i.e. pending + reused (`planning.rs:175-178`). So **queueing 107 header archives does not mean 107 are re-downloaded**. Headers (All) and the present chunks 105–106 should be reused if their outputs verify.
- This matches root's observation at 15:04 of about 36.5 GB read and no writes yet: the verification hashing.
- **Unknown:** the exact reused/pending split until the CLI logs it. If an existing output fails verification, that archive is re-fetched and re-extracted, overwriting that output.
- Per the earlier source review, only `--force` / `--prune-unlisted` delete data, and the emitted command has neither, so the initial snapshot's other data is not deleted. This was not re-verified in this pass.

## 4. Root's post-marker check (expects 26 required archives) and readiness
- **Do not call it complete on the 26 alone.** The 26 are a subset of what the CLI downloads, so checking them stays valid as coverage for the declared floor (48,000,000 / 52,500,000). The 4 extras must be recorded as additional, not unexpected, so they are never treated as leftovers or tampering.
- **The extras give lower bounds below the floor:** tx/receipts from 47,500,000; changesets from 52,000,000.
  - Readiness must keep claiming the declared floor (`since` = 48,000,000 and 52,500,000), never the lower extracted range. Otherwise an unreviewed claim appears.
  - reth's generated config maps `Since(b)` to `PruneMode::Before(b)` (`config_gen.rs:263`), so the node keeps data from b exactly. Whether it prunes the extra predecessor-chunk blocks below b on first run is UNKNOWN (not traced).
- **Preflight fix (later stage, not live):** use `first = (total_blocks - min(snapshot - since + 1, total_blocks)) // blocks_per_file`, the reth formula, and assert equality with the CLI's startup counts. Its current reporting and space numbers undercount by 4 archives, 34.5 GB compressed and 80.0 GB extracted.
- **Off-by-one readiness gap:** a coverage proof that takes the preflight's `firstChunk` as the lowest extracted file would be wrong by one chunk. That gap is conservative, not a false completion, because the real data reaches lower. A proof claiming start = `firstChunk × 500000` = 48,000,000 stays true. A proof that checks "exactly these 26 output sets exist and nothing else" would falsely FAIL.

## Unknowns (not invented)
- Whether chunks 95 and 104 are already on disk. The expected answer is no.
- The CLI's reused/pending split.
- Whether any present output fails verification.
- Pruning behaviour below `Before(b)` on first run.
- The real index size.
- Whether the actual 6-hour window and the throughput suffice for 22 archives (unmeasured).
