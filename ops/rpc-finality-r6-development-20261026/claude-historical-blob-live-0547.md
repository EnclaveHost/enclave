# Historical L1/blob prerequisite for the selected Base snapshot: live read-only check (2026-10-26 05:46–05:48 UTC)
**Done:** bounded own-node reads only (EL 18645, CL 15052 inside enclave-rpc). **Not done:** no external RPC, no blob payload downloads, no config, service or download changes; Base downloader PID 4061 untouched. **No coverage verdict is claimed.**
Receipts: `logs/historical-blob-live-0547/` (`live-l1-probe.txt`, `lighthouse-database-info.txt`, `l1-needfrom-estimate-block.txt`, `SHA256SUMS`).

## Required range (from the existing coverage procedure)
`source/ops/rpc-backend-bootstrap/2026-10-25/coverage/RESULT.md` §2–3, from pinned Base v1.5.1 / reth 7134be3:
- `need_from = safe.l1Origin − 3600` (seq_window_size, a conservative superset of channel_timeout), and `to_block = L1 finalized`.
- The gate refuses a range above `--max-blocks` (default **12000**, hard cap **30000**).
- **Exact dependency:** `safe.l1Origin` is read from the snapshot's MDBX `ChainState[LastSafeBlock]` (else finalized), plus the safe block's L1-attributes deposit (`origin_extract.py`). **It cannot be known exactly until the Base DB (state) is extracted.**

**Estimate now (NOT the gate's value):**
- The manifest block 53048526 has timestamp 1686789347 + 2·53048526 = **1792886399 (2026-10-24T23:59:59Z)**.
- The L1 block at that time is ≈ **26265930**, so `need_from` ≈ **26262330** (assuming safe ≈ unsafe; a lagging safe or finalized label moves it earlier).

## Own L1 state at 05:46:53Z (`live-l1-probe.txt`)
| Check | Value | Against the estimated range |
|---|---|---|
| EL | `reth/v2.8.0-05ba481`, chainId 1, `eth_syncing` false; latest 26274864, finalized **26274780** | — |
| EL history | pruned: `earliest available 26100000` (code 4444) | covers need_from ≈ 26262330 (about 162k blocks of margin) |
| CL | Lighthouse/v8.3.2, not syncing, not optimistic, EL online; head slot 15514132, finalized slot 15514048; `custody_group_count` **64** (gate needs ≥ 64) | ✓ |
| CL block history (backfill) | anchor_slot 15508320 (checkpoint), **oldest_block_slot 15341664**: backfill is complete back to there | estimated need_from block 26262330 is at slot **15501564** (its actual EL timestamp 1792842791) ✓ |
| CL blob/column data | **oldest_data_slot 15382624**; `prune_blobs` true, `epochs_per_blob_prune` 256, margin 0. The window (head − oldest) is 131 508 slots, about the 4096-epoch retention | need_from slot 15501564 is covered, with about 119k slots (~16.5 days) before pruning reaches it |

The CL is **not backfilling** the needed range: it already holds blocks and data from slot 15341664 and 15382624 onward. On the estimate, own L1 history (EL blocks, CL blocks and blob/column data) covers the range now. **This is a prerequisite check only.** The gate's per-block KZG/receipt verification over the exact range has not run.

## Blocker found: the range size
- The window from need_from to L1 finalized is **already about 12 450 blocks**, above the gate's **default 12000**. It grows by about 7200 blocks/day.
- **The hard cap of 30000 is reached at about 2026-10-28 16:00 UTC** on this estimate, earlier if the snapshot's safe or finalized label lags.
- The coverage gate must therefore run with an explicit `--max-blocks` (≤ 30000) and **before about 2026-10-28 16:00 UTC**. Otherwise the procedure's own cap refuses, and this snapshot can no longer be bridged under the reviewed gate (a fresh snapshot/manifest would be required).
- Blob retention is not the tighter limit: the needed data stays until about 2026-11-11.

## Next steps (existing procedure, no new framework)
1. Keep the current download untouched. The `state` extraction is the dependency.
2. **As soon as `state` is extracted** (before the second 18-archive run if time is tight), run the staged `coverage/origin_extract.py` read-only against the datadir, using the documented `--datadir.rocksdb SCRATCH/view/rocksdb` secondary-scratch pattern. This gives the exact `safe.l1Origin` and `need_from`.
3. Run `coverage/coverage_gate.py` with `--max-blocks` set to the actual range (≤ 30000) against own EL/CL, and write the verdict and receipt per `readiness/RESULT.md` §5. **Deadline:** before need_from + 30000 exceeds L1 finalized (≈ 2026-10-28 16:00 UTC on the estimate; recompute from the real origin).
4. Only then do root's coverage-activation steps (`coverage-activation/README.md`: pin the receipt, verdict, origin and manifest sha256 values; `coverageVerified`). Not before.

Production remains unqualified; admin control and the 16 GiB floor are untouched.
