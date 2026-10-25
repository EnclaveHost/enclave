# Base snapshot history retention review (2026-10-25)

## STATUS UPDATE, 19:24 UTC: option B applied and configured; cached download NOT run (supersedes 19:22)

- **Applied.** Root applied `bootstrap-state-candidate/bootstrap-state.patch` to source and guest. `chain_service.py` is
  `713b0ddf4c99d12ca38e32e0e7b83a6ccb312230c70033ece976b8f7f11a4f57`.
- **Configured.** `chain.json` `baseRetention` is `{historyFromBlock: 48000000, stateHistoryFromBlock: 52500000}`. No
  other field changed. The new binding is `d01a2dcbb9c4d31aec0fd6446b09f78fcb80a891a94228aca9086f6ef71823b2`.
- **Tests.** Root's tests passed 32/32 and 36/36 with 0 skips.
- **Unchanged.** Coverage is false, Base is inactive, the path unit is disabled, and PIDs are unchanged.
- **Config mode.** The installer left `chain.json` at 0600. Root restored 0644 before any restart, and the identity then
  passed for all three service users. There was no outage.
  - The installer is published as **historical, NOT reusable** next to the repair:
    [`bootstrap-state-candidate/root-install-v2/`](bootstrap-state-candidate/root-install-v2/).
  - Future installs must preserve the existing mode and owner, or use 0644. Never 0600.
- **Still pending.** No authority is ready.
  - The cached old-history download has not run.
  - The creation block 48,322,938 is unverified on our own chain.
  - The index has not been measured.
  - The coverage gate and receipt are not done.
  - The first start must use these flags.

See [`bootstrap-state-candidate/README.md`](bootstrap-state-candidate/README.md).

## STATUS UPDATE, 19:22 UTC: root chose option B; candidate prepared (NOT applied)

- **Decision:** `historyFromBlock = 48000000` (file 96; legacy book creation 48,322,938, external, unverified) and
  `stateHistoryFromBlock = 52500000` (changeset file 105 kept until the authenticated bootstrap).
- **Candidate:** a patch against `dc9f4ad9`, a cached-download preflight with the exact command, and the capacity model.
  See [`bootstrap-state-candidate/README.md`](bootstrap-state-candidate/README.md).
- **Not yet done:** nothing is applied; the installed code, `chain.json` and the VM are unchanged.


## STATUS UPDATE, 19:15 UTC (supersedes the status line and the lookup/floor statements below)

**Installed code, policy NOT configured.**
- Root applied patch `fa993888…` and installed guest `chain_service.py` `dc9f4ad9…` (`root-install/install.out`, 19:08:33Z).
- Root's runs on the applied source passed 27/27 and 36/36 with 0 skips (`root-install/retention-root-{chain,coverage}.out`).
- `chain.json` is unchanged: **no `baseRetention` policy is configured**, so Base cannot start (fail-closed).
- Coverage remains false, the Base client and path unit are disabled, and protected PIDs are unchanged.

**Floors (minimum history per consumer):**

| Consumer | Floor | Source |
| --- | --- | --- |
| lease writer-authority reader | **52,515,705** | `relay/lease-generation.mjs:91-93` |
| `PinnedSessionAuthority` `0xF76A138cEb162Aa4bAB47D4787793C569759CAc8` | **52,823,640** | created by the `PinnedSessionVaultFactory` constructor (`contracts/PinnedSessionVaultFactory.sol:38`) in tx `0x987081338fba079f…` (local record `image/src/contracts/deployments/independent-authorities-base.json`); covered |
| **browser-profile ledger history** (legacy `EnclaveAddressBook` `0xab214342d5A490150A4A977063A2f88E21F80907`) | **48,322,938** | see below |

On the browser-profile floor:
- **Local evidence** only bounds it: the book existed by 52,280,280 (`sessions-base.json`).
- **External one-off read-only** `eth_getCode` bisection on `mainnet.base.org` (`floor/legacy-book-creation.json`,
  `floor/bisect.log`): first code at **48,322,938** (none at 48,322,937); creation tx
  `0xb29e0b8b13ab0098330e8e20cbba3b985cf8b84c817bb890266817f1585dcc19`. This is **UNVERIFIED external metadata**. The
  explorer returned a Cloudflare challenge, and the RPC then rate-limited (429), so the block hash was not fetched.
- **Own-chain check** after an extended download: `eth_getBlockReceipts(48322938)` on our node must contain a receipt
  with `contractAddress == 0xab214342…`, and `eth_getLogs` from that block must be served.

**The minimum floor that preserves every audited feature, including browser-profile ledger history, is 48,322,938.**

**Two rollout options (root decision; nothing changed):**

| Option | Retention / download | Effect |
| --- | --- | --- |
| A | `baseRetention.historyFromBlock = 52515705`; no extra download | All runtime consumers are served. Browser-profile ledger history must not use this node for blocks below 52.5M; reth answers `PrunedHistoryUnavailable` there, not silence, because receipts and transactions share one floor |
| B (all features) | `historyFromBlock = 48322938`; extra receipts+transactions files 96-104 | **221.6 GB compressed / 410.0 GB extracted** (`floor/legacy-book-floor-cost.txt`) |

Option B is a reviewed `--with-txs-since 48322938 --with-receipts-since 48322938` download on the datadir **before the
first Base start**, keeping the state-history selection. It rewrites `reth.toml` and its checkpoints and is untested
here. `chain_service`'s startup check then requires `static_file_*_48000000_48499999`.

**Tx-hash lookup: rebuilt from source-proven mechanism; size not yet measured.**

1. **The downloader's reset.** It writes a TransactionLookup `Full` prune checkpoint (`download/config_gen.rs:42-92`).
   Then, in the same transaction, because `rocksdb_indices` was not selected (`download/mod.rs:1027-1031`, `:665-677`),
   `reset_index_stage_checkpoints_tx` **deletes** the TransactionLookup / AccountHistory / StorageHistory prune
   checkpoints and resets those stage checkpoints to 0 (`config_gen.rs:96-135`).
2. **First start runs the stage.** `check_pipeline_consistency` (`node/builder/src/launch/common.rs:1077-1107`) runs a
   backfill because those stages are behind.
3. **With `before N`.** The TransactionLookup stage (`stages/src/stages/tx_lookup.rs:83-117`) moves its checkpoint to
   N-1, saves a prune checkpoint only if none exists, and hashes every transaction from N to the target into RocksDB
   `TransactionHashNumbers`.
4. **This holds only for the FIRST start with the `before` flags.** If Base were ever started with lookup `full` or a
   distance, that later checkpoint is saved, and changing the CLI afterwards does **not** rebuild the older hashes.

**What `eth_getLogs` needs.** It does **not** need the hash index: it reads each tx hash by tx number
(`rpc-eth-types/src/logs_utils.rs:104-138`). Only `eth_getTransactionByHash` and `eth_getTransactionReceipt(hash)`
need the index.

**Offline repair, only if step 4 happened.** Pinned reth `stage drop tx-lookup` (`cli/commands/src/stage/drop.rs:220-236`):
- clears `TransactionHashNumbers`;
- nulls the prune checkpoint's block, keeping its mode;
- resets the TransactionLookup checkpoint;
- **also resets `Finish` to 0**.

This is **untested**. Before any use, rehearse it on a disposable copy, and confirm `base reth stage drop --help` on
binary `9c44836d`.

**Measure before the first start (read-only):** the index entry count is `last_tx_num(head) − last_tx_num(N−1)`, from
two `base reth db get mdbx BlockBodyIndices <block>` calls. Use the same read-only, secondary-scratch method as
`coverage/origin_extract.py`. Size is roughly the count × (32-byte key + small value + RocksDB overhead). **Not
measured yet.**

---


**Status: reviewed candidate for root. Not installed.** Base is still disabled. The snapshot download keeps running with
its 140,000-block distance profile; that is fine, because the fix below needs no different download. No live change,
SSH or commit.

**Scope:** retention and availability of history. It is **not** authenticated snapshot state and **not** full
readiness. The coverage gate (`chain_service.py` `a60ae322…`) is preserved unchanged and still runs first.

## 1. Required history (from consumer source, not invented)

**The ledger floor.** `route-source/relay/lease-generation.mjs:91-93` sets `LEDGER16D_FROM_BLOCK = 52_515_705`, "the
live 16d ledger's code first appears at Base block 52,515,705". The writer-authority reader walks `eth_getLogs` from head
down to that block until it finds the lease's `Claimed` log (`:244-270`). It also uses `eth_getBlockByNumber` at log
blocks, and `eth_call` only at `latest`/`finalized` (`:207-223`, `:301`).

**Bounded consumers** (all recent windows):

| Consumer | Window |
| --- | --- |
| `relay/sessions.mjs:633` | 5,000-block cursor start |
| `relay/provisioner.js:266` | 50,000 blocks |
| `relay/indexer.js:64-67` | starts at tip; catch-up ≤ `INDEXER_MAX_CATCHUP_BLOCKS` 200,000 |
| supervisor ledger delta (`supervisor.js:11207-11232`) | bounded by `LEDGER_MAX_CATCHUP`, else a full state read via multicall |
| MCP session scans (`mcp/independent-tools.mjs:307-313`) | ≤ maxChunks × chunk |

**NOT covered by the ledger floor.** `scripts/network/browser-profile.mjs --ledger-history-from <block>` reads the
address book's `AddressSet` logs from **the book's deployment block** (`:26`, `:113-120`, `:210-211`). It is an
occasional operator publishing tool.

- The local deployment profiles name two books: legacy `0xab214342…` (also the default in `relay/mcp.js:63`) and
  current `0xf76a138c…`.
- They record only review blocks 52,830,935 and 52,831,588 (`image/src/contracts/deployments/*.json`), not deployment
  blocks.
- **The book deployment floor is unknown and may be below 52,515,705.**

So 52,515,705 is the floor for the lease reader and the bounded consumers only. It is **not** claimed for
browser-profile ledger-history publication.

## 2. What the pinned client does

Base `5476069f` links reth `7134be3`.

**`eth_getLogs` needs headers, receipts, body indices and transactions.** The tx hash comes from `transaction_by_id`
(`crates/rpc/rpc-eth-types/src/logs_utils.rs:104-138`).

**Its pruned-range check is weak:**
- it refuses only below `earliest_block_number()`, which is the start of the lowest **Transactions** static file
  (`storage/provider/.../static_file/manager.rs:1224-1231`);
- a block whose receipts are absent is **silently skipped** (`rpc/rpc/src/eth/filter.rs:1282-1284`).

**The download** (`base snapshot download` = reth `DownloadCommand`, `base crates/execution/cli/src/commands/download.rs:33-35`):
- `--with-*-distance 140000` selects whole 500k-block files from 105 (52,500,000).
- It writes `receipts` / `bodies_history` = `Distance(140000)`, `transaction_lookup` = `Full` and
  `sender_recovery` = `Full` (`crates/cli/commands/src/download/config_gen.rs:217-243`).
- It writes prune checkpoints at the snapshot block (`:42-92`).
- `--with-*-since` exist (`download/mod.rs:365-398`) and map to `PruneMode::Before` (`config_gen.rs:263`).

**Pruning** deletes whole static files only (`crates/prune/prune/src/segments/mod.rs:32-71`).
`Before(n)` targets `n-1` (`prune/types/src/mode.rs:63-65`). Bodies pruning waits on TransactionLookup
(`segments/user/bodies.rs:112-125`).

## 3. Before vs after

**Measured from the real manifest** (`manifest-measurements.txt`, sha `1f0c4e6c…`, block 53,048,526):
- 116 archives, 827.64 GB compressed (= root's 770.80 GiB), 1,274.29 GB extracted.
- Txs, receipts and changesets are downloaded from file 105, starting at **52,500,000**, which contains 52,515,705.

**Before (current profile, distance 140,000).**
- First startup deletes nothing in file 105.
- Once the Base tip passes **53,140,000**, file 105 is deleted for receipts and transactions, dropping
  52,515,705-52,999,999.
- Receipts can go first while bodies wait on the lookup, which gives **silently empty `eth_getLogs`** for that range.
- Transactions hashed by lookup older than 140,000 blocks return null.

**After (this patch).**
- `base rpc` gets `--prune.receipts.before`, `--prune.bodies.before` and `--prune.transaction-lookup.before` set to
  `chain.json` `baseRetention.historyFromBlock` (52515705). The pinned binary supports these flags
  (`fresh-witness-supply/evidence/binary-help-20261023T054215Z/rpc-help.txt:891-942`, binary `9c44836d…`).
- File 105 is never deleted, receipts and transactions share the same floor, and the tx-hash lookup covers the same
  range.
- State history, senders and L1 are **unchanged**: still a distance of 140,000; `eth_call` is used only at `latest` /
  `finalized`.

**Capacity** (`manifest-measurements.txt`):
- Receipts plus transactions are about **53 GB per 500k-block file** (file 105: 23.56 + 29.49 GB), about **4.6 GB/day**,
  kept indefinitely from 52.5M.
- There is no extra download now.
- The tx-lookup index is rebuilt on the first start with the `before` flags (mechanism proven in the status update
  above). Its size and HDD time are **not measured**; see the read-only measurement method above.

## 4. The patch (`base-retention.patch`, sha256 `fa993888…`)

The patch is made against root's exact source files, which it modifies only:

| File | Before | After |
| --- | --- | --- |
| `chain_service.py` | `a60ae322…` | `dc9f4ad9…` |
| `test_chain_service.py` | `42231a7a…` | `73f1bcb4…` |
| `test_coverage_activation.py` | `085672f3…` | `354c4e8a…` |

Readiness is unchanged.

**What it changes:**
- **New required config:** `chain.json` `baseRetention.historyFromBlock`, required for Base. It sits outside
  `baseBootstrap`, so the coverage receipt's `chainConfigSha256` binds it.
- **Before-flags for Base:** `prune_args(profile, history_from)` emits before-flags for receipts, bodies and lookup.
  - An existing `before` at or below the start is kept as is.
  - The downloader's distance (140,000 to 500,000) is upgraded.
  - Larger or unreviewed profiles, `before` above the start, and receipts `full` are **refused**, never silently
    reduced.
- **Startup guard:** `run('base')`, after the coverage gate and before any L1 call, requires the config and the existence
  of `static_files/static_file_{receipts,transactions}_<start>_<end>` covering the start. These names match the real
  manifest's outputs.

L1 behaviour and its tests are unchanged. The one existing Base test now expects the before-flags. The persisted-config
model learned `before`, and the fixed point across restarts is still asserted.

## 5. Tests (claude-test-queue.py `--mib 256`, `unshare -rn`, `REAL_SNAPSHOT_MANIFEST` set)

| Run | Result |
| --- | --- |
| `logs/test-20261025T190345Z.out` | rc 0: `test_chain_service.py` 27/27 (20 existing + 7 new), `test_coverage_activation.py` 36/36 (3 real-manifest ran) |
| `logs/patchcheck-20261025T190414Z.out` (patch applied to a fresh copy of the originals) | rc 0: 27/27 + 36/36, 0 skips |
| `logs/mutants-20261025T190402Z.out` (`recipes/`) | 3/3 KILLED: no startup file check, distance kept, no upgrade bound |
| `logs/superseded/test-20261025T190303Z` (rc 1) | two bugs in my new tests: a wrong pruned-datadir block, and an unbound `Path.is_file` patch. Fixed |

## 6. Rollout (root; none performed)

**Before the first Base start:**
1. Let the download finish unchanged.
2. Apply the patch and install `chain_service.py`.
3. Add `"baseRetention": {"historyFromBlock": 52515705}` to `chain.json`. Do this before writing any coverage receipt,
   because `chainConfigSha256` changes.
4. Check that `static_files/static_file_{receipts,transactions}_52500000_52999999` exist.

**First start:** the client rewrites the `reth.toml` `[prune]` section from these flags, which the tests assert as a
fixed point. The download's checkpoints at block 53,048,526 sit above the `before` target, so nothing is pruned.

**Rollback:** reinstall `a60ae322…`. Base remains gated. Never start Base with the distance profile once the tip
exceeds 53,140,000 unless losing that history is accepted.

## 7. Remaining limitations

**Book deployment floor (rollout prerequisite for browser-profile ledger history).**
- Root must determine both books' deployment blocks read-only, for example the first `AddressSet` log or the code-start
  block from an archive-capable source.
- If the floor is below 52,500,000, the extra receipts+transactions files are bounded per `earlier-floor-costs.txt`:
  - from 52,000,000: 25.4 GB compressed / 46.7 GB extracted;
  - from 50,000,000: 138 / 255 GB;
  - from genesis: 1,932 / 3,897 GB.
- Adding them means a reviewed `--with-txs-since` / `--with-receipts-since` download on the datadir **before the first
  Base start**. That run also rewrites `reth.toml` and its checkpoints; it is untested here.
- Until then, browser-profile history publication must not rely on this node for blocks below its floor. reth answers
  that range with `PrunedHistoryUnavailable` (`filter.rs:596-603`), not with silence, once receipts and transactions
  share a floor.

**Other limitations:**
- Not run on the VM or on the real datadir; the static-file names come from the manifest. The lookup rebuild cost is
  unmeasured.
- Snapshot contents are publisher claims verified by the downloader's BLAKE3. This review does not authenticate state.
