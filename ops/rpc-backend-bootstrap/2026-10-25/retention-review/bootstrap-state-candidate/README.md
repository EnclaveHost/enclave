# Option B + bootstrap state-history (2026-10-25): PATCH APPLIED AND POLICY CONFIGURED; cached download NOT run

## STATUS UPDATE, 19:24 UTC: applied by root (supersedes "CANDIDATE ONLY, NOT APPLIED")

**What root did.** Evidence is in [`root-install-v2/`](root-install-v2/), copied byte-exact from root's outputs.
- **19:24:02Z, install** (`install.out`):
  - Applied `bootstrap-state.patch` to source and guest. `chain_service.py` went from `dc9f4ad9…` to
    `713b0ddf4c99d12ca38e32e0e7b83a6ccb312230c70033ece976b8f7f11a4f57`, which matches the source tree.
  - Configured `chain.json` `baseRetention` as exactly `{"historyFromBlock": 48000000, "stateHistoryFromBlock":
    52500000}`. Every other field is unchanged. The config file sha went from `369f2a62…` to `81988aee…`.
  - The new chain config binding (`chainConfigSha256`) is
    `d01a2dcbb9c4d31aec0fd6446b09f78fcb80a891a94228aca9086f6ef71823b2`.
  - `coverage-check` exits 1 ("not approved"), as expected. Coverage is false, Base is inactive, the path unit is disabled,
    and PIDs 847, 898 and 4061 are unchanged.
- **19:24:59Z, permissions repair, before any restart** (`fix-config-mode.py`, `config-mode-repair.out`):
  - Root's atomic installer had replaced `/etc/enclave-rpc/chain.json` with mode **0600**, which is wrong for the service
    users.
  - Root restored the original installer mode **0644** (`stage_node_units.py:88`, `install -m 0644`).
  - Live `coverage-identity` then returned `d01a2dcb…` for `rpcl1el`, `rpcl1cl` and `rpcbase`.
  - There was no outage and no restart. The JWT is a separate file and is unchanged.
- **The installer used is HISTORICAL and NOT reusable as is.** It is in
  [`root-install-v2/historical-do-not-reuse/`](root-install-v2/historical-do-not-reuse/NOT-REUSABLE.md). Its line 22
  (`ct.chmod(0o600)`) is the defect. Any future config install must preserve the existing mode and owner, or use the
  original root:root 0644. **Never 0600.**
- **Root's tests on the applied source** (shared queue, 0 skips):
  - `retention-v2-root-chain.out`: 32/32 OK, rc 0;
  - `retention-v2-root-coverage.out`: 36/36 OK, rc 0, peak 54 MiB.
- **Backup:** root keeps the old code and config in the guest at `/root/enclave-rpc-retention-v2-713b0ddf`. It is
  intentionally not published, and neither are the full `chain.json` or any keys.

**Still NOT done.** No authority is ready.
- **Cached download.** The extra old-history download (rollout steps 2-3 below) has **not** run.
- **Creation block.** The legacy-book creation block is **unverified** on our own chain.
- **Index size.** The index has not been measured read-only.
- **Coverage.** There is no coverage gate or receipt; `coverage-check` refuses.
- **First start.** The first Base start must still use these flags.

Base stays disabled. This is retention, capacity and availability only: not authenticated snapshot state and not full
readiness.

**Original candidate status (19:22, historical):** root decision option B (preserve every audited feature); nothing was
applied at that time.

## Policy

| Field (`chain.json` `baseRetention`) | Value | Why |
| --- | --- | --- |
| `historyFromBlock` | **48000000** | Conservative start of file 96, which holds the legacy `EnclaveAddressBook` `0xab214342…` creation at **48,322,938** (external one-off `eth_getCode` bisection, **unverified**; see `../floor/`). Covers browser-profile ledger history, the lease reader (52,515,705) and `PinnedSessionAuthority` (52,823,640). |
| `stateHistoryFromBlock` | **52500000** | Changeset file 105 must survive until the authenticated bootstrap completes (`logs/claude-anchor-bootstrap-result.md:61-69`, option U). A distance profile deletes file 105 once the tip passes 53,140,000. |

Both fields go outside `baseBootstrap`, so `chainConfigSha256` binds them: set them **before** any coverage receipt.

**Own-chain check still pending** once file 96 is local: `eth_getBlockReceipts(48322938)` contains
`contractAddress == 0xab214342…`.

## Patch: `bootstrap-state.patch` (sha256 `e52d642d4856c686376a95e3bff379c9667d2ccc8951d8c3243377abfa2126a8`)

It applies exactly to source:

| File | Before | After |
| --- | --- | --- |
| `chain_service.py` | `dc9f4ad9…` | `713b0ddf4c99d12ca38e32e0e7b83a6ccb312230c70033ece976b8f7f11a4f57` |
| `test_chain_service.py` | `73f1bcb4…` | `5c3907b8ba491c537a935223b90baddb4d0967ab82834d54f202a2ea24f1eb20` |
| `test_coverage_activation.py` | `354c4e8a…` | `24c37c51d20f164434739093dd513d9206968e0ac60aec1ba59271b1116fa6f7` (fixture gains the new field) |

Readiness is unchanged.

**What it changes:**
- **Required `stateHistoryFromBlock` for Base.** `account_history` and `storage_history` become `--prune.*-history.before
  <stateHistoryFromBlock>`.
  - An existing `before` at or below the start is kept as is.
  - The downloader's distance (140,000 to 500,000) is upgraded.
  - A `before` above the start, or a larger or unreviewed distance, is **refused**.
- **Snapshot bound.** Both starts must be **≤ the verified snapshot block**, taken from the coverage binding
  (`origin.snapshot.block`).
- **Startup file check.** Startup requires `static_files/static_file_{receipts,transactions}_<s>_<e>` for
  `historyFromBlock` **and** `static_file_{account-change-sets,storage-change-sets}_<s>_<e>` for
  `stateHistoryFromBlock`. These are the real manifest's output names.
- **L1 is unchanged.**

**CLI for `base rpc`:**

| Segment | Before (installed `dc9f4ad9` + downloader profile) | After |
| --- | --- | --- |
| receipts | before historyFromBlock | before 48000000 |
| bodies | before historyFromBlock | before 48000000 |
| transaction-lookup | before historyFromBlock | before 48000000 |
| account-history | distance 140000 | **before 52500000** |
| storage-history | distance 140000 | **before 52500000** |
| sender-recovery | full | full |

## Second (cached) download: exact command and preflight

**Prerequisites:**
- Run only after the first download has finished (`snapshot-complete`).
- The Base client must never have started.
- Run as root in the guest.

**Step 1: preflight** (read-only; exit 0 admits, exit 3 refuses):

```sh
python3 -I cached_download_preflight.py \
  --manifest /opt/enclave-rpc/snapshots/base-1792886410-manifest.json \
  --datadir /srv/enclave-base-holder/data \
  --history-from 48000000 --state-history-from 52500000
```

**Step 2: the command it prints.** Neither `--force` nor `--prune-unlisted`, the only deleting flags
(`download/mod.rs:510-511,550-553`); verified files are reused (`mod.rs:44-45`, `planning.rs:140-151`):

```sh
/opt/enclave-rpc/bin/base snapshot download --chain base \
  --manifest-path /opt/enclave-rpc/snapshots/base-1792886410-manifest.json \
  --datadir /srv/enclave-base-holder/data \
  --with-txs-since 48000000 --with-receipts-since 48000000 --with-state-history-since 52500000 \
  --download-concurrency 16 --resumable=true -y
```

**What that run then writes** (source):
- `reth.toml` with receipts and bodies `before 48000000`, account and storage history `before 52500000`, and
  lookup/senders `full` (`config_gen.rs:217-243,263`);
- prune checkpoints at the snapshot block (`:42-92`);
- the index stages reset to 0 (`:96-135`).

These are exactly what the patch accepts, as the fixed-point test asserts. The first `base rpc` start then rebuilds the
tx lookup from 48,000,000 and the history indices from 52,500,000 (`stages/src/stages/tx_lookup.rs:83-117`, via
`check_pipeline_consistency`).

**Time cost:** the re-run re-hashes the existing ~1.27 TB of outputs before scheduling. That is hours on the HDD.

## Capacity (real manifest `1f0c4e6c…`; model, `logs/test-20261025T192017Z.out`)

| Item | GB |
| --- | --- |
| missing archives (files 96-104, transactions+receipts: 18 archives), compressed | 221.6 |
| same, extracted | 410.0 |
| state history from 52.5M | 0 extra (files 105-106 already selected) |
| index reserve = max(2 × ESTIMATE 80.5, 150) | 161.0 |
| growth reserve, 30 days × 8.35 GB/day (txs+receipts+changesets+headers; state-DB growth NOT included) | 250.5 |
| **preflight need** | **1,043.2** |
| modeled free on the 3.1 TB Base volume (3.1 TB × 0.99 − 1.274 TB extracted) | 1,794.7 |
| modeled headroom | **751.5** |
| used after extraction | ~1,684 |

The model counts all compressed bytes as held at once. Per source each archive is removed after extraction, so the real
peak is lower. The admission decision uses real `statvfs` at run time.

## Tests (claude-test-queue.py `--mib 256`, `unshare -rn`, real manifest)

| Run | Result |
| --- | --- |
| `logs/test-20261025T192017Z.out` | rc 0: `test_chain_service.py` 32/32, `test_coverage_activation.py` 36/36, `test_cached_download_preflight.py` 6/6 (real-manifest numbers included); mutants s1/s2/s3 KILLED (state policy, snapshot bound, changeset-file check) |
| `logs/patchcheck-20261025T192018Z.out` (patch applied to a fresh copy of source) | rc 0: 32/32 + 36/36, 0 skips |
| `logs/superseded/mutants-20261025T192001Z` (rc 1) | s3 survived. A test gap: no case reached the changeset check. Fixed by `test_base_start_refuses_missing_changesets_even_with_history_files` |

The recipes in `recipes/` ran in the stage layout, with the test files beside them.

## Rollout order (root)

1. The first download finishes.
2. Run the preflight; it must exit 0.
3. Run the cached download command above.
4. Verify the already-installed patch and both configured `baseRetention` fields (completed at 19:24; do not reinstall the historical defective installer).
5. Measure the lookup index requirement and verify capacity before first startup.
6. Run the coverage gate and receipt.
7. Run `coverage-check` before any isolated Base bootstrap startup. The **first start** must use these flags (see `../README.md`). This retention/availability gate does not authenticate snapshot state or authorize proof serving. Production authority and consumer cutover also require the authenticated-anchor bootstrap and finality checks in `../../finality-investigation/anchor-bootstrap-review/REVIEW.md`.

## Remaining limitations

- **Unverified floor.** The legacy book creation block is unverified until checked on our own chain.
- **Index size.** The 80.5 GB index figure is an estimate, scaled from the full-chain `rocksdb_indices` by transaction
  share. Measure it read-only before the first start (method in `../README.md`).
- **State-DB growth** is not in the growth reserve.
- **Untested end to end.** The cached re-run is source-reviewed but not executed here.
- **Changeset retention after bootstrap.** Releasing `stateHistoryFromBlock` after the authenticated bootstrap (a policy
  change to a later block) is a later reviewed step.
