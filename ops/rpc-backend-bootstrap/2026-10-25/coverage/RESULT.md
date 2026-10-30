# Base snapshot origin and L1 coverage gate (coverage-stage)

Written 2026-10-25. This is source and staging only. Nothing here touched the VM, made an SSH or chain call, read a secret, or wrote `chain.json`/`coverageVerified`. No commits.

**Status: the gate is runnable and tested offline. It has never been run on the real snapshot or the real L1 pair.** A downloaded snapshot is not a ready snapshot. Activation still needs the live runs in §5 and root's review of their output.

## 1. Files

| File | sha256 | Purpose |
|---|---|---|
| `origin_extract.py` | `6b63b901…3c86c` | Offline, read-only extraction of the snapshot's persisted safe, finalized and tip labels and their L1 origins. |
| `coverage_gate.py` | `b4f6d639…3854b` | Read-only L1 coverage validator. Writes a structured verdict. |
| `kzgcheck/` (`src/main.rs`, `Cargo.toml`, `Cargo.lock` `647aad9f…af10b4`) | binary `00b3eeb94efece39e4f2cf8e34d5d3450d532328ccc667a6a74e83b151be10eb` | Recomputes commitments: blob → KZG commitment (c-kzg 2.1.8, embedded mainnet setup), and header hash, transactions root and receipts root (alloy 2.4.1). |
| `kzgcheck/lockcheck.py` | | Proves every crate in kzgcheck's lock equals base-v1.5.1's `Cargo.lock` (version + checksum + source). |
| `test_origin_extract.py`, `test_coverage_gate.py`, `jobs/{build-kzg,test,real-origin}.sh` | | Tests and queue jobs. |
| `logs/` | | Queue guard logs and outputs. The `*.try1.out` files keep the failed attempts. |

## 2. Source findings (pinned code)

- **Where the safe head lives.** Base v1.5.1 reads `safe`/`finalized`/`latest` from its execution layer at restart (`crates/consensus/engine/src/sync/forkchoice.rs`).
  - reth (base/reth `base-v2.5.2.8` = `7134be3b`, the exact rev in Base's `Cargo.lock`) loads them from MDBX `ChainState[LastSafeBlock|LastFinalizedBlock]` (`storage/provider/src/providers/blockchain_provider.rs:119`, `database/provider.rs:3987-4008`, `db-api/src/tables/mod.rs:587-611`).
  - If safe is absent, Base falls back to finalized. If that is absent too, it falls back to L2 genesis.
  - Base's own redb `safedb` is optional (`--safedb.path`), not configured by `chain_service.py`, and is not the restart source.
- **Which L1 range Base actually re-reads.**
  - The restart safe head is the first block, walking back from the unsafe tip, that is behind the sequencing window or is the labeled safe/finalized block (`engine/src/sync/mod.rs`).
  - `initial_reset` then restarts derivation `channel_timeout` L1 blocks below that block's origin (`derive/src/pipeline/core.rs:51-100`). That is 50 after Granite and 300 before; the code uses the conservative 300.
  - So `safe.l1Origin − 3600` (`seq_window_size`, `common/chains/src/config.rs`) is a **conservative superset** of the true start.
- **Offline tooling.** `base reth db get` opens storage with `AccessRights::RO` (`cli/commands/src/db/mod.rs`).
  - **Pitfall found by the real-binary run:** the RO RocksDB open is a *secondary* instance. It creates `<parent of rocksdb path>/rocksdb-secondary-tmp-<pid>` (`storage/provider/src/providers/rocksdb/provider.rs:429-434`).
  - On a read-only datadir the first run failed with `Read-only file system (os error 30)`. Nothing was written: `logs/test1.out`.
  - **Fix, using a supported pinned flag:** `--datadir.rocksdb SCRATCH/view/rocksdb`, where `view/rocksdb` is a symlink into the read-only mount. The secondary's temp files land in scratch. MDBX, static files and RocksDB data stay on the read-only mount.
- **Decoding the L1 origin.** The safe block's first transaction is the L1-attributes deposit. Layouts come from `crates/common/consensus/src/info/` (bedrock, ecotone, isthmus, jovian): origin number `[28..36]`, hash `[100..132]`, batcher hash `[132..164]`. Anything else is refused.
- **Mainnet constants** are taken from `common/chains/src/config.rs`:
  - batch inbox `0xff00…8453`
  - SystemConfig `0x73a7…4072`
  - ConfigUpdate topic `0x1d2b0bda…53be` (`common/genesis/src/system/update.rs:37`)

## 3. What the gate checks (`coverage_gate.py`)

**Range.** `need_from = safe.l1Origin − 3600` and `to_block = L1 finalized`. It refuses if the origin is not canonical on our L1, is above finalized, or the range exceeds `--max-blocks` (default 12000, hard cap 30000).

**L1 pair readiness** (refused codes in brackets):
- chain, genesis, spec and Fulu fork must match [`wrong-chain`]
- EL not syncing [`el-syncing`]
- CL not syncing or optimistic, EL online [`cl-optimistic`, `cl-not-synced`]
- head age under 120 s [`stale-head`]; finalized age under 3600 s [`stale-finality`]
- beacon head payload equals the EL block [`el-cl-mismatch`]
- custody groups ≥ 64 [`insufficient-custody`]

**Per L1 block, every block in the range:**
- The EL block exists [`missingData: el-block`] and its parentHash links to the previous block [`el-discontinuity`].
- `eth_getBlockReceipts` is present [`missingData: receipts`].
- kzgcheck recomputes the keccak header hash, the transactions root and the receipts root from the consensus encodings, plus the tx hashes. Each must equal what the EL claims [`header-hash`, `transactions-root`, `receipts-root`, `commitments-unverifiable`]. **This is the cryptographic receipt check; counts alone are never accepted.**
- If a SystemConfig batcher update appears in the range, the gate refuses [`batcher-changed-in-range`].

**Per slot:**
- The beacon header is canonical and not optimistic.
- The blinded block commits to this EL hash [`el-cl-mismatch`].
- Its parent_root links to the previous non-empty slot [`cl-discontinuity`].
- Empty slots between two linked beacon blocks are reported as **`missedSlots`**, which the hash linkage proves.
- A slot that has an EL block but no served beacon block is **`missingData: beacon-block`**, not a missed slot.

**Blobs:**
- Every blob tx sent to the batch inbox is checked. This is a superset of Base's inbox-and-batcher filter and does not trust the RPC's unverified `from`. `--blob-scope all` checks every blob.
- The block's KZG commitments must hash (EIP-4844 `0x01‖sha256[1:]`) to exactly the EL's `blobVersionedHashes`, which the transactions root binds.
- Then `/eth/v1/beacon/blobs/{slot}?versioned_hashes=…` (Base's own call) must serve every blob [`missingData: blobs`].
- Each served blob's commitment is recomputed with c-kzg and must hash to a requested versioned hash [`blob-commitment`]. A correct count with wrong content is rejected.

**Bounds:**
- loopback `http` only
- per-request timeout of 15 s or less (≤ 60 s)
- response cap of 32 MiB (1–64 MiB)
- request budget (`--max-requests` 80000)
- rate limit `--rps` 100 (≤ 500)
- one block in memory at a time
- verdict lists capped at 100 entries with full counts
- the `--out` file must not already exist

**Verdicts:**
- `COVERED` (exit 0) with `proposedBaseBootstrap {l1Block: need_from, blobSlot: first verified batcher-blob slot, rootReviewRequired: true, coverageVerifiedEligible: true}`
- `REFUSED` (exit 3) with `{code, detail}` and the partial counts
- exit 2 for config errors
- `coverageVerifiedWritten` is always false

**No persisted safe label.** If the snapshot persists no safe label, the gate refuses with `no-persisted-safe-head`; the unsafe tip alone is not enough. The explicit `--accept-tip-walk-rule` applies the same source rules to the tip:
- `need_from = min(tip.l1Origin − 3601, finalized.l1Origin if present) − 300`.
- The verdict is then `COVERED_UNDER_TIP_WALK_RULE_ROOT_DECISION_REQUIRED` (exit 4) with `coverageVerifiedEligible: false`.
- The origin document keeps `status: NO_PERSISTED_SAFE_HEAD` and `labels.safe: null`, so nothing is relabelled as safe.
- **Limit:** this rule is derived from source, not observed. It assumes the tip's L1 origin is canonical (checked) and that Base's walk behaves as the pinned code reads. Root must decide.

## 4. Tests run (all through the shared queue, 1024 MiB cap, 16 GiB floor kept)

```sh
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/coverage-stage
Q=/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py
python3 $Q --mib 1024 --log logs/build-kzg4.guard -- unshare -rn bash jobs/build-kzg.sh    # rc 0, peak 411 MiB
python3 $Q --mib 1024 --log logs/test4.guard -- unshare -rmn bash jobs/test.sh            # rc 0, peak 112 MiB
```

**Build.** `cargo build --release --offline --locked`, with no network namespace and no new downloads. Every crate came from the local registry, and `lockcheck` passed: every crate equals base-v1.5.1's `Cargo.lock`.

**Tests: 24/24 pass** (`logs/test4.out`).
- **Gate fixtures:** a loopback fake EL plus beacon. Every block is sealed with real roots and hashes from kzgcheck, and real blobs carry c-kzg commitments.
  - Covered case: missed slot classified, 3 batcher blobs verified.
  - Rejected cases:
    - beacon gap reported as missing data, not as a missed slot
    - blobs unavailable
    - right count with the wrong blob
    - commitments ≠ EL versioned hashes
    - receipts missing, short or tampered (receipts root)
    - a self-consistent EL/beacon/blob swap, caught only by the transactions root
    - header field tamper (header hash)
    - CL optimistic, head optimistic, EL syncing, low custody, stale head
    - unsafe-only origin refused; with the tip rule it returns exit 4 and is not eligible
    - status/label inconsistency and provenance
    - origin not canonical, above finalized, or range not finalized
    - EL and CL discontinuity, EL/CL mismatch
    - batcher change in range
    - range, request and body bounds
    - non-loopback or https endpoint, kzg pin mismatch
- **Extractor fixtures:** a fake `base` that prints reth's `println` format, with ANSI log lines.
  - Decodes all four layouts and refuses bad selectors, lengths and batcher words.
  - Covers the persisted and not-persisted cases, pruned or empty bodies, a non-deposit first tx, safe above tip, missing Finish, and a binary pin mismatch.
  - Refuses a writable datadir and a scratch dir that is inside the datadir, non-empty or missing.
- **Real pinned binary** (`jobs/real-origin.sh`, `base` sha256 `9c44836d…5e53f`, offline in `unshare -rmn`):
  - `base reth init --chain base` into scratch, then a read-only bind mount, then `origin_extract.py`.
  - Observed: the six `db get` calls exit 0 against the read-only mount; `ChainState` labels are absent (null); `Finish = 0`; the static-file header hash is `0xf712aa92…73dd` (the Base mainnet genesis from `config.rs:483`). The run correctly refuses with "tip block 0: body pruned or empty". The datadir tree and its content hashes are unchanged.
  - Earlier failed attempts are kept: `logs/test1.out` shows the secondary-tmp failure; `test2`/`test3` are fixture fixes.

## 5. Operator procedure (root, on the VM, after Base extraction; not performed here)

```sh
# Base client must be stopped (enclave-base-holder.path stays disabled). DATA = <manifest mounts.base>/data
install -d -m 0755 /run/cov/ro
install -d -o rpcbase -m 0700 /run/cov/scratch /run/cov/output
install -d -m 0700 /root/cov
mount --bind "$DATA" /run/cov/ro && mount -o remount,bind,ro /run/cov/ro
runuser -u rpcbase -- python3 origin_extract.py --base-bin /opt/enclave-rpc/bin/base \
  --base-sha256 9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f \
  --datadir /run/cov/ro --scratch /run/cov/scratch --out /run/cov/output/origin.json
# Only after a successful extraction; preserve refusals separately for diagnosis.
install -m 0600 /run/cov/output/origin.json /root/cov/origin.json
umount /run/cov/ro && rm -rf /run/cov/scratch
# After reth has finished syncing and l1-ready passes (stage kzgcheck with its sha256 pin):
python3 coverage_gate.py --origin /root/cov/origin.json --kzg /opt/enclave-rpc/bin/kzgcheck \
  --kzg-sha256 00b3eeb94efece39e4f2cf8e34d5d3450d532328ccc667a6a74e83b151be10eb \
  --el http://127.0.0.1:18645 --beacon http://127.0.0.1:15052 --max-blocks <range> --out /root/cov/verdict.json
```

Only `COVERED` (exit 0) plus root's review may lead to setting `baseBootstrap.{coverageVerified,l1Block,blobSlot}`.

## 6. Still requires live evidence or root decisions

1. **Real snapshot extraction.** The download is not finished and not extracted. Two things are unknown:
   - Whether snapshot 1792886410 persists `LastSafeBlock`. If not, the result is `NO_PERSISTED_SAFE_HEAD` and the decision goes to root.
   - The exact `serde` shape of a real Base deposit in `db get static-file transactions`. The parser searches for `input`, accepts only the four L1-info selectors and fails closed; no real non-genesis Base block was available offline.
   - The MDBX/RocksDB read-only open was proven only on a genesis-only datadir.
2. **Real L1 data through kzgcheck.** Header hashes for current mainnet headers (Prague `requestsHash`, Fulu) and the real tx/receipt types (0–4) have only been tested on synthetic blocks. An unknown field or type fails closed (`header-hash`/`commitments-unverifiable`) instead of passing.
3. **The live L1 pair.** reth has to finish syncing. Lighthouse semi-supernode backfill has to reach `need_slot` with columns (see `../logs/claude-blob-options.md`). Then the gate must actually return `COVERED` over the full range. Receipt retention at the origin (140000 blocks) also needs live confirmation.
4. **Range size.** The range grows by about 7200 blocks per day after the snapshot. Above 30000 blocks the gate refuses; root may run with `--to-block` (≤ finalized, ≥ origin). Blocks past `--to-block` are then not verified by this gate.
5. **Trust boundaries.**
   - The beacon block root and canonical flag come from our own Lighthouse; SSZ roots are not recomputed.
   - Signatures and senders are not recovered. This is harmless because the blob filter does not use `from`.
   - Base's derivation correctness beyond data availability is not tested.
6. **`chain_service.py` is unchanged.** Its Base start check is still count-only (`len(blobs) == len(commitments)` at one slot). Consider making it require a reviewed `COVERED` verdict. That is outside this staging directory.
7. **Single site and sequencer.** One operator and one site, and the sequencer dependence remains, as recorded in the HANDOFF.
