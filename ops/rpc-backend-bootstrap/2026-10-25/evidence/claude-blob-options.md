# L1 blob gap for the Base 1.5.1 snapshot: options (read-only investigation)

Written 2026-10-25 around 11:30Z. Nothing on the VM was changed: no restarts, no flags, no keys.

## Problem
- Lighthouse v8.3.2 (a376defa) was checkpoint-synced at anchor slot 15508320 (epoch 484635, 2026-10-25 10:24:23Z). It runs with `--semi-supernode`.
- Base snapshot 1792886410 is at L2 block 53048526, taken 2026-10-25 00:00Z. That is L1 slot ≈15505198 (epoch 484537).
- Base derivation needs L1 data from **(the L1 origin of the snapshot's safe head) − seqWindowSize 3600 L1 blocks** (PINS.json `base.seqWindowSize`; the RUNBOOK §7 gate uses the same rule). Taking the snapshot time as the origin, that point is about slot 15501598 (epoch ≈484424, 2026-10-24 ~12:00Z). The requested target of ~484533 leaves out the sequencing window, so it is too shallow. The exact bound comes from the procedure in §4.

## 1. Can P2P backfill recover the pre-anchor columns? Yes, according to the pinned source. Not yet proven live.

Source evidence, Lighthouse at a376defa. Fetched copies are in `wo/logs/claude-blob-src-a376defa/`.
- A **fresh** node with `--semi-supernode` records cgc=64 at **Epoch 0**. See `custody_context.rs` `ValidatorRegistrations::new` (around line 59), whose comment reads: *"The node will backfill all the way back to either data_availability_boundary or fulu epoch … backfill will be done via backfill sync instead of column backfill."* The SemiSupernode override is `number_of_custody_groups / 2` (line 236).
- Backfill uses `batch_type(epoch)` to choose `BlocksAndColumns` for any epoch ≥ the DA boundary (current epoch − 4096, currently about 480549) once PeerDAS is active (`network_context.rs:1297-1316`, `custody_context.rs:553-578`). For those batches it fetches custody columns by root after the blocks arrive (`network_context.rs:~538`).
- `import_historical_block_batch` writes blobs/columns for each backfilled block (`historical_blocks.rs:215-219`). `get_blobs_or_columns_store_op` keeps `custody_columns_for_epoch(epoch)`, which is 64 columns on a fresh semi-supernode (`beacon_chain.rs:8239-8268`).
- The HTTP blobs endpoint rebuilds blobs whenever at least 64 column keys are stored (`http_api/src/block_id.rs:501-525`). It does not check whether a slot came from backfill or from live gossip.
- Backfill moves backward from the anchor in 1-epoch batches (`BACKFILL_EPOCHS_PER_BATCH = 1`). It continues to the weak-subjectivity point and stores columns only inside the DA window. **No flag stops it at a chosen slot**, and none is needed: the target range (about 210 epochs below the anchor) is the first data it fetches.
- `--complete-blob-backfill` would not help. It only works on fresh init, it is experimental, and the book warns it "may block most of its peers".

The RUNBOOK §7 line "serves blobs only for blocks received since it started" overstates the limit **for a fresh semi-supernode init**. The book's "since using the flag" refers to turning the flag on for an existing database. In that case `new_from_persisted_custody_context` makes cgc=64 effective only from head_epoch+1, and the earlier epochs need the separate custody backfill path.

Conditions and limitations. All of these need read-only checks:
1. The CL database must have been **initialised** with `--semi-supernode`, with no earlier full-node run on that datadir. If the flag was added later, this path does not apply as described.
2. Backfill only starts when `SyncState::Synced`, meaning the head is within 32 slots of the wall clock (`sync/manager.rs:646-690`). I did not verify against the live node that the CL head advances to that point while reth is still syncing. Check the CL logs or sync status.
3. Backfill holds batches until there are good peers on **every** sampling column subnet (`backfill_sync/mod.rs:1054-1075`, log "Waiting for peers to be available on custody column subnets"). With few peers it may stall.
4. Speed is rate-limited (book: typically <20 slots/s). `--disable-backfill-rate-limiting` exists (`cli.rs:519`), but it means a CL restart. Use it only if backfill measurably stalls, and only with root's approval.
5. Blobs are only part of what derivation needs. Base also needs L1 EL data (headers, receipts, logs) for the same range from **our** reth. **The EL sync is the real critical path whatever we decide about blobs.**

## 2. An earlier checkpoint state (~484533 or deeper)? Not a viable path.
- The public checkpoint services returned 500 for `debug/states/15505056`. They serve recent finalized states, not historic ones, and I found no pinned or documented source for an older state.
- `--checkpoint-state/--checkpoint-block/--checkpoint-sync-url` only take effect on a fresh database. Re-anchoring means wiping the CL database, which is a larger change. Section 1 makes it unnecessary.

## 3. A one-time verified blob import? Not supported by existing code.
- Lighthouse's `--checkpoint-blobs` (`cli.rs:1261`) covers only the checkpoint block, on fresh init. I found no route for importing historical blobs or columns. Limitation: I searched http_api route names and CLI flags only, not every file.
- Base v1.5.1 offers a single `--l1-beacon` (holder `BINARY.json` `flagsInRpcHelp`). A grep of the vendored base-v1.5.1 source found no beacon fallback or blob-archiver flag.
- Any import would therefore be new, unreviewed code. It is not the smallest change.

## 4. Recommendation (smallest change)
1. **Change nothing on the pair.** Keep the paused Base snapshot staged and do not discard it.
2. Read-only checks: confirm condition 1 from the CL datadir history and unit argv; watch the CL logs for backfill progress (`BackFillSyncing` or "Downloading historical blocks") and the oldest block slot (`GET /lighthouse/database/info`, `anchor.oldest_block_slot`). `GET /lighthouse/custody/info` (`http_api/src/lib.rs:3248`) shows custody state. I did not inspect its output fields.
3. **Exact origin.** Once the snapshot is extracted, start nothing yet. Read the snapshot's **safe** head, not its tip. Its first transaction is the L1-attributes deposit, which carries the L1 origin number and hash. Compute `need_from_block = origin − 3600` and get that L1 block's timestamp from a verified header. Then `need_slot = (ts − 1606824023) / 12`. Expect about 15501598 or a little lower.
4. **Acceptance gate for resuming the 00:00 snapshot.** Before the holder is pointed at the pair, all of the following must hold:
   - `anchor.oldest_block_slot ≤ need_slot`.
   - For blob-carrying slots from `need_slot` to 15508320, `/eth/v1/beacon/blobs/{slot}` returns the full blob count with versioned hashes matching the block's commitments. Sample them densely; ideally check every one.
   - `l1pair.py ready CONFIG --need-from-block <origin−3600> --need-blobs-from-slot <need_slot>` exits 0. Its EL checks also gate on reth finishing.
   - If any slot in that range returns "Insufficient data columns", the backfill path has failed. Go to step 5.
5. **Fallback: the next snapshot.** No shorter path has been proven live. If the gate fails, the next Base snapshot is acceptable only if **its safe-head L1 origin − 3600 L1 blocks** has a timestamp ≥ 2026-10-25 10:24:23Z (slot 15508320), the earliest slot the pair has seen live. Compute this with block numbers, not wall clock: missed slots make 3600 blocks span more than 12 h. The 2026-10-26 00:00Z snapshot would clear the bound by only about 1.5 h, so verify it exactly before downloading. Run the same §4 gate with its numbers.

Either way, holder deployment waits for reth to finish syncing. The blob question does not change that critical path.
